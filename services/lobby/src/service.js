import { randomUUID, randomInt } from 'node:crypto';
import { getEngine, listGames } from '@ipm/game-engines';
import { badRequest, conflict, forbidden, notFound } from '@ipm/common';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

// Atomic matchmaking: enqueue the user (once) and, if enough players wait, pop them all in one step.
const MATCH_LUA = `
if redis.call('SADD', KEYS[2], ARGV[1]) == 1 then redis.call('RPUSH', KEYS[1], ARGV[1]) end
local size = tonumber(ARGV[2])
if redis.call('LLEN', KEYS[1]) >= size then
  local users = redis.call('LRANGE', KEYS[1], 0, size - 1)
  redis.call('LTRIM', KEYS[1], size, -1)
  for _, u in ipairs(users) do redis.call('SREM', KEYS[2], u) end
  return users
end
return {}`;

/**
 * Lobby: rooms (Mongo `lobby.rooms`) + quick-match queues (Redis).
 * Publishes `room.started` on the `events:room` stream; game-service reacts to it.
 */
export function createLobbyService({ db, redis, bus }) {
  const rooms = db.collection('rooms');
  const queueKey = (game, size) => `lobby:mm:${game}:${size}`;

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

  async function startRoom(user, roomId) {
    const room = await rooms.findOne({ _id: roomId });
    if (!room) throw notFound('Room not found');
    if (room.hostId !== user.id) throw forbidden('Only the host can start the game');
    const { minPlayers } = validateGame(room.game, room.maxPlayers);
    if (room.players.length < minPlayers) throw conflict(`Need at least ${minPlayers} players`);
    return launch(roomId);
  }

  /** waiting -> playing is a compare-and-set, so a room can only ever start once. */
  async function launch(roomId) {
    const started = await rooms.findOneAndUpdate({ _id: roomId, status: 'waiting' }, { $set: { status: 'playing', startedAt: new Date() } }, { returnDocument: 'after' });
    if (!started) throw conflict('Room already started');
    await bus.publish('events:room', 'room.started', { roomId: started._id, game: started.game, players: started.players });
    return started;
  }

  async function quickMatch(user, { game, maxPlayers }) {
    validateGame(game, maxPlayers);
    const key = queueKey(game, maxPlayers);
    await redis.set(`lobby:mm:name:${user.id}`, user.username, 'EX', 600);
    await redis.set(`lobby:mm:user:${user.id}`, `${game}:${maxPlayers}`, 'EX', 600);
    await redis.del(`lobby:mm:matched:${user.id}`);
    const ids = await redis.eval(MATCH_LUA, 2, key, `${key}:set`, user.id, maxPlayers);
    if (!ids.length) return { status: 'queued' };

    const names = await redis.mget(ids.map((id) => `lobby:mm:name:${id}`));
    const room = {
      _id: randomUUID(), code: newCode(), game, maxPlayers, isPrivate: true, status: 'waiting', hostId: ids[0],
      players: ids.map((id, i) => ({ userId: id, username: names[i] || 'Player' })), createdAt: new Date(),
    };
    await rooms.insertOne(room);
    await launch(room._id);
    for (const id of ids) await redis.set(`lobby:mm:matched:${id}`, room._id, 'EX', 300);
    return { status: 'matched', roomId: room._id };
  }

  async function quickMatchStatus(user) {
    const roomId = await redis.get(`lobby:mm:matched:${user.id}`);
    if (roomId) return { status: 'matched', roomId };
    return { status: (await redis.exists(`lobby:mm:user:${user.id}`)) ? 'queued' : 'idle' };
  }

  async function cancelQuickMatch(user) {
    const q = await redis.get(`lobby:mm:user:${user.id}`);
    if (q) {
      const [game, size] = q.split(':');
      const key = queueKey(game, size);
      await redis.lrem(key, 0, user.id);
      await redis.srem(`${key}:set`, user.id);
    }
    await redis.del(`lobby:mm:user:${user.id}`);
  }

  const getRoom = async (id) => (await rooms.findOne({ _id: id })) ?? (() => { throw notFound('Room not found'); })();
  const listOpen = (game) => rooms.find({ status: 'waiting', isPrivate: false, ...(game && { game }) }).sort({ createdAt: -1 }).limit(50).toArray();
  const markFinished = (roomId) => rooms.updateOne({ _id: roomId }, { $set: { status: 'finished', finishedAt: new Date() } });

  return { init, createRoom, joinRoom, leaveRoom, startRoom, quickMatch, quickMatchStatus, cancelQuickMatch, getRoom, listOpen, markFinished, listGames };
}
