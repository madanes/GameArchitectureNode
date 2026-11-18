import { randomUUID, randomInt } from 'node:crypto';
import { getEngine, listGames } from '@ipm/game-engines';
import { badRequest, conflict, forbidden, notFound } from '@ipm/common';
import { BOT_NAMES } from './matching.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/**
 * Lobby: rooms (Mongo `lobby.rooms`). Matchmaking lives in matchmaker.js and uses createMatchRoom().
 * Publishes `room.started` on the `events:room` stream; game-service reacts to it.
 */
export function createLobbyService({ db, bus }) {
  const rooms = db.collection('rooms');

  async function init() {
    await rooms.createIndex({ code: 1 }, { unique: true });
    await rooms.createIndex({ status: 1, isPrivate: 1, game: 1, createdAt: -1 });
    await rooms.createIndex({ 'players.userId': 1, status: 1 });
  }

  function validateGame(game, maxPlayers) {
    const engine = getEngine(game);
    if (!engine) throw badRequest(`Unknown game '${game}'. Available: ${listGames().map((g) => g.id).join(', ')}`);
    const { minPlayers, maxPlayers: max } = engine.meta;
    if (maxPlayers < minPlayers || maxPlayers > max) throw badRequest(`${game} supports ${minPlayers}-${max} players`);
    return engine.meta;
  }

  async function createRoom(user, { game, maxPlayers, isPrivate }) {
    validateGame(game, maxPlayers);
    const room = {
      _id: randomUUID(), code: newCode(), game, maxPlayers, isPrivate, status: 'waiting', hostId: user.id,
      players: [{ userId: user.id, username: user.username }], createdAt: new Date(),
    };
    await rooms.insertOne(room);
    return room;
  }

  async function joinRoom(user, idOrCode) {
    // One atomic update enforces: still waiting, not already in, not full.
    const res = await rooms.findOneAndUpdate(
      {
        $or: [{ _id: idOrCode }, { code: idOrCode.toUpperCase() }],
        status: 'waiting',
        'players.userId': { $ne: user.id },
        $expr: { $lt: [{ $size: '$players' }, '$maxPlayers'] },
      },
      { $push: { players: { userId: user.id, username: user.username } } },
      { returnDocument: 'after' },
    );
    if (res) return res;
    const existing = await rooms.findOne({ $or: [{ _id: idOrCode }, { code: idOrCode.toUpperCase() }] });
    if (!existing) throw notFound('Room not found');
    if (existing.players.some((p) => p.userId === user.id)) return existing; // idempotent
    throw conflict(existing.status !== 'waiting' ? 'Room already started' : 'Room is full');
  }

  async function leaveRoom(user, roomId) {
    const room = await rooms.findOne({ _id: roomId });
    if (!room) throw notFound('Room not found');
    if (room.status !== 'waiting') throw conflict('Cannot leave a started game');
    const after = await rooms.findOneAndUpdate({ _id: roomId, status: 'waiting' }, { $pull: { players: { userId: user.id } } }, { returnDocument: 'after' });
    if (after && after.players.length === 0) { await rooms.deleteOne({ _id: roomId }); return null; }
    if (after && after.hostId === user.id) { // hand host over
      await rooms.updateOne({ _id: roomId }, { $set: { hostId: after.players[0].userId } });
      after.hostId = after.players[0].userId;
    }
    return after;
  }

  /** Host starts the room. With fillWithBots=true every empty seat is taken by a bot. */
  async function startRoom(user, roomId, { fillWithBots = false } = {}) {
    const room = await rooms.findOne({ _id: roomId });
    if (!room) throw notFound('Room not found');
    if (room.hostId !== user.id) throw forbidden('Only the host can start the game');
    const { minPlayers } = validateGame(room.game, room.maxPlayers);
    if (fillWithBots && room.players.length < room.maxPlayers) {
      const bots = Array.from({ length: room.maxPlayers - room.players.length }, (_, i) => makeBot(i));
      const filled = await rooms.findOneAndUpdate(
        { _id: roomId, status: 'waiting', $expr: { $eq: [{ $size: '$players' }, room.players.length] } },
        { $push: { players: { $each: bots } } },
        { returnDocument: 'after' },
      );
      if (!filled) throw conflict('Room changed, try again');
    } else if (room.players.length < minPlayers) {
      throw conflict(`Need at least ${minPlayers} players`);
    }
    return launch(roomId);
  }

  const makeBot = (i) => ({ userId: `bot:${randomUUID()}`, username: `Bot ${BOT_NAMES[randomInt(BOT_NAMES.length)]}`, isBot: true, rating: 1000 + i });

  /** waiting -> playing is a compare-and-set, so a room can only ever start once. */
  async function launch(roomId) {
    const started = await rooms.findOneAndUpdate({ _id: roomId, status: 'waiting' }, { $set: { status: 'playing', startedAt: new Date() } }, { returnDocument: 'after' });
    if (!started) throw conflict('Room already started');
    await bus.publish('events:room', 'room.started', { roomId: started._id, game: started.game, players: started.players });
    return started;
  }

  /** Used by the matchmaker: create an already-full room and start it immediately. */
  async function createMatchRoom({ game, maxPlayers, players }) {
    const room = {
      _id: randomUUID(), code: newCode(), game, maxPlayers, isPrivate: true, status: 'waiting',
      hostId: players.find((p) => !p.isBot).userId, players, matchmade: true, createdAt: new Date(),
    };
    await rooms.insertOne(room);
    return launch(room._id);
  }

  const getRoom = async (id) => (await rooms.findOne({ _id: id })) ?? (() => { throw notFound('Room not found'); })();
  const listOpen = (game) => rooms.find({ status: 'waiting', isPrivate: false, ...(game && { game }) }).sort({ createdAt: -1 }).limit(50).toArray();
  const markFinished = (roomId) => rooms.updateOne({ _id: roomId }, { $set: { status: 'finished', finishedAt: new Date() } });

  return { init, validateGame, createRoom, joinRoom, leaveRoom, startRoom, createMatchRoom, getRoom, listOpen, markFinished, listGames };
}
