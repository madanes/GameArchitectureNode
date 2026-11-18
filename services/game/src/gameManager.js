import { randomInt } from 'node:crypto';
import { getEngine, EngineError } from '@ipm/game-engines';
import { AppError, withLock, isDuplicateKey, notFound, forbidden } from '@ipm/common';

const STATE_TTL_SEC = 60 * 60 * 24; // abandoned games vanish after a day
const FINISHED_TTL_SEC = 60 * 10; // finished games stay readable (reconnect/results) for 10 minutes

export const stateKey = (roomId) => `game:${roomId}:state`;
export const channel = (roomId) => `game:${roomId}:events`;

/**
 * Orchestrates a live game: Redis holds the hot state, the engine decides what is legal,
 * a per-room lock serialises actions across replicas, pub/sub fans results out to every
 * replica (and therefore every connected player), Mongo stores the finished match.
 */
export function createGameManager({ redis, db, bus, logger }) {
  const matches = db.collection('matches');
  const serverRng = () => randomInt(1, 7); // dice are rolled server-side only: clients cannot cheat

  const publish = (roomId, message) => redis.publish(channel(roomId), JSON.stringify(message));

  async function getState(roomId) {
    const raw = await redis.get(stateKey(roomId));
    return raw ? JSON.parse(raw) : null;
  }

  /** Called from the `room.started` event. Idempotent: redelivery cannot reset a running game. */
  async function createGame({ roomId, game, players }) {
    const engine = getEngine(game);
    if (!engine) throw new Error(`unknown game ${game}`);
    const state = engine.create({ players });
    const created = await redis.set(stateKey(roomId), JSON.stringify(state), 'EX', STATE_TTL_SEC, 'NX');
    if (created !== 'OK') return;
    logger.info({ roomId, game }, 'game created');
    await publish(roomId, { type: 'state', state, events: [{ type: 'game_started' }] });
  }

  async function assertParticipant(roomId, userId) {
    const state = await getState(roomId);
    if (!state) throw notFound('Game not found');
    if (!state.players.some((p) => p.userId === userId)) throw forbidden('You are not in this game');
    return state;
  }

  async function act(roomId, userId, action) {
    return withLock(redis, `game:${roomId}:lock`, async () => {
      const state = await getState(roomId);
      if (!state) throw notFound('Game not found');
      const engine = getEngine(state.game);
      let result;
      try {
        result = engine.applyAction(state, userId, action, serverRng);
      } catch (err) {
        if (err instanceof EngineError) throw new AppError(422, err.code, err.message);
        throw err;
      }
      const finished = result.state.status === 'finished';
      await redis.set(stateKey(roomId), JSON.stringify(result.state), 'EX', finished ? FINISHED_TTL_SEC : STATE_TTL_SEC);
      await publish(roomId, { type: 'state', state: result.state, events: result.events });
      if (finished) await finalize(roomId, result.state);
      return result;
    });
  }

  async function finalize(roomId, state) {
    const players = state.players.map((p) => ({ userId: p.userId, username: p.username }));
    try {
      await matches.insertOne({ _id: roomId, game: state.game, players, ranking: state.ranking, moves: state.moveCount, finishedAt: new Date() });
    } catch (err) { if (!isDuplicateKey(err)) throw err; }
    await bus.publish('events:game', 'game.finished', { matchId: roomId, roomId, game: state.game, players, ranking: state.ranking });
    logger.info({ roomId, ranking: state.ranking }, 'game finished');
  }

  return { createGame, getState, assertParticipant, act };
}
