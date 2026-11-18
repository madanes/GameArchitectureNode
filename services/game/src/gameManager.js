import { randomInt } from 'node:crypto';
import { getEngine, EngineError } from '@ipm/game-engines';
import { AppError, withLock, isDuplicateKey, notFound, forbidden } from '@ipm/common';

const STATE_TTL_SEC = 60 * 60 * 24; // abandoned games vanish after a day
const FINISHED_TTL_SEC = 60 * 10; // finished games stay readable (reconnect/results) for 10 minutes
const DEADLINES = 'game:deadlines'; // ZSET roomId -> ms epoch when the current turn times out (or the bot should act)
const PENDING = 'game:pending-finalize'; // HASH roomId -> finished state not yet safely persisted

export const stateKey = (roomId) => `game:${roomId}:state`;
export const channel = (roomId) => `game:${roomId}:events`;
export const userChannel = (userId) => `user:${userId}:events`;

/**
 * Orchestrates live games: Redis holds the hot state, the engine decides what is legal,
 * a per-room lock serialises actions across replicas, pub/sub fans results out to every replica
 * (and therefore every connected player), Mongo stores the finished match.
 *
 * Time is handled here, not in the engine: every committed state gets a `turnDeadline`. A ticker
 * finds due rooms and either plays the bot's turn or applies the engine's timeout rule to a human.
 */
export function createGameManager({ redis, db, bus, logger, options = {} }) {
  const matches = db.collection('matches');
  const turnTimeoutMs = Number(options.turnTimeoutMs ?? process.env.TURN_TIMEOUT_MS ?? 20000);
  const botDelayMs = Number(options.botDelayMs ?? process.env.BOT_DELAY_MS ?? 900);
  const serverRng = () => randomInt(1, 7); // dice are rolled server-side only: clients cannot cheat

  const publish = (roomId, message) => redis.publish(channel(roomId), JSON.stringify(message));

  async function getState(roomId) {
    const raw = await redis.get(stateKey(roomId));
    return raw ? JSON.parse(raw) : null;
  }

  /** Stamp the deadline for the player to act next and register it for the ticker. */
  function stamp(state) {
    if (state.status !== 'playing') { state.turnDeadline = null; return; }
    state.turnDeadline = Date.now() + (state.players[state.turn].isBot ? botDelayMs : turnTimeoutMs);
  }

  async function schedule(roomId, state) {
    stamp(state);
    if (state.turnDeadline) await redis.zadd(DEADLINES, state.turnDeadline, roomId);
    else await redis.zrem(DEADLINES, roomId);
  }

  /** Called from the `room.started` event. Idempotent: redelivery cannot reset a running game. */
  async function createGame({ roomId, game, players }) {
    const engine = getEngine(game);
    if (!engine) throw new Error(`unknown game ${game}`);
    const state = engine.create({ players });
    state.players.forEach((p, i) => { if (p.isBot) p.rating = players[i].rating; }); // bots carry the rating they were matched at
    stamp(state);
    const created = await redis.set(stateKey(roomId), JSON.stringify(state), 'EX', STATE_TTL_SEC, 'NX');
    if (created !== 'OK') return; // already exists (event redelivery): leave the running game and its deadline alone
    await redis.zadd(DEADLINES, state.turnDeadline, roomId);
    logger.info({ roomId, game, bots: state.players.filter((p) => p.isBot).length }, 'game created');
    await publish(roomId, { type: 'state', state, events: [{ type: 'game_started' }] });
    const info = { type: 'match_found', roomId, game, players: state.players.map((p) => ({ userId: p.userId, username: p.username, color: p.color, isBot: p.isBot })) };
    await Promise.all(state.players.filter((p) => !p.isBot).map((p) => redis.publish(userChannel(p.userId), JSON.stringify(info))));
  }

  async function assertParticipant(roomId, userId) {
    const state = await getState(roomId);
    if (!state) throw notFound('Game not found');
    if (!state.players.some((p) => p.userId === userId)) throw forbidden('You are not in this game');
    return state;
  }

  /** Persist + broadcast the result of an engine call. Must run inside the room lock. */
  async function commit(roomId, result) {
    const { state } = result;
    await schedule(roomId, state);
    await redis.set(stateKey(roomId), JSON.stringify(state), 'EX', state.status === 'finished' ? FINISHED_TTL_SEC : STATE_TTL_SEC);
    await publish(roomId, { type: 'state', state, events: result.events });
    if (state.status === 'finished') {
      // Never fail the player's action because of bookkeeping: failures are retried by the ticker.
      await finalize(roomId, state).catch((err) => logger.error({ err, roomId }, 'finalize failed; will retry'));
    }
    return result;
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
      return commit(roomId, result);
    });
  }

  /** A room's deadline passed: bot plays, or a human is timed out (auto-play / forfeit). */
  async function handleDue(roomId) {
    await withLock(redis, `game:${roomId}:lock`, async () => {
      const state = await getState(roomId);
      if (!state || state.status !== 'playing') { await redis.zrem(DEADLINES, roomId); return; }
      if (state.turnDeadline > Date.now()) return; // somebody acted just before us
      const engine = getEngine(state.game);
      const current = state.players[state.turn];
      const result = current.isBot
        ? engine.applyAction(state, current.userId, engine.suggestAction(state), serverRng)
        : engine.onTimeout(state, serverRng);
      await commit(roomId, result);
    }, { retries: 1 });
  }

  // ---- finished games: persist + announce, retried until it sticks -------------------------------

  async function persist(roomId, state) {
    const players = state.players.map((p) => ({ userId: p.userId, username: p.username, isBot: p.isBot, rating: p.rating }));
    try {
      await matches.insertOne({ _id: roomId, game: state.game, players, ranking: state.ranking, moves: state.moveCount, finishedAt: new Date() });
    } catch (err) { if (!isDuplicateKey(err)) throw err; }
    const stats = Object.fromEntries(state.players.map((p) => [p.userId, { captures: p.captures ?? 0 }]));
    await bus.publish('events:game', 'game.finished', { matchId: roomId, roomId, game: state.game, players, ranking: state.ranking, stats });
    logger.info({ roomId, ranking: state.ranking }, 'game finished');
  }

  async function finalize(roomId, state) {
    await redis.hset(PENDING, roomId, JSON.stringify({ ts: Date.now(), state })); // survives a crash mid-way
    await persist(roomId, state);
    await redis.hdel(PENDING, roomId);
  }

  /** Re-run finalisation for games whose bookkeeping did not complete (Mongo blip, replica crash). Consumers are idempotent. */
  async function retryPending() {
    const entries = await redis.hgetall(PENDING);
    for (const [roomId, raw] of Object.entries(entries)) {
      const { ts, state } = JSON.parse(raw);
      if (Date.now() - ts < 10_000) continue; // probably still in flight
      try { await persist(roomId, state); await redis.hdel(PENDING, roomId); logger.info({ roomId }, 'finalize retry succeeded'); } catch (err) { logger.warn({ err: err.message, roomId }, 'finalize retry failed'); }
    }
  }

  let ticking = false;
  let lastRetry = 0;
  /** Called every 250 ms by the service. Safe to run on every replica (room lock + deadline re-check). */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const due = await redis.zrangebyscore(DEADLINES, '-inf', Date.now(), 'LIMIT', 0, 25);
      await Promise.all(due.map((roomId) => handleDue(roomId).catch((err) => { if (err.code !== 'LOCKED') logger.error({ err, roomId }, 'timer failed'); })));
      if (Date.now() - lastRetry > 5000) { lastRetry = Date.now(); await retryPending(); }
    } finally { ticking = false; }
  }

  return { createGame, getState, assertParticipant, act, tick, userChannel };
}
