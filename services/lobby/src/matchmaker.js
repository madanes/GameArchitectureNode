import { randomUUID } from 'node:crypto';
import { INITIAL_RATING } from '@ipm/rating';
import { findMatches, planBotFill, BOT_NAMES } from './matching.js';

const QUEUES = 'lobby:mm:queues'; // set of "game:size" queues that may contain players
const queueKey = (game, size) => `lobby:mm:q:${game}:${size}`; // ZSET member=userId score=MMR
const ticketKey = (id) => `lobby:mm:ticket:${id}`; // HASH {username, game, size, mmr, since}
const TICKET_TTL_SEC = 600;

/**
 * Skill-based matchmaking driven by WebSocket requests relayed as `events:mm` events:
 *
 *   game-service --mm.join / mm.cancel--> [events:mm] --> lobby (this module)
 *   lobby --room.started--> [events:room] --> game-service --match_found--> player sockets
 *   lobby --mm.timeout--> [events:mm] --> game-service --mm_timeout--> player socket
 *
 * A 1 s ticker (guarded by a Redis lock so only one replica runs it) groups waiting players by MMR,
 * widening the acceptable gap with wait time, and fills seats with bots when nobody suitable shows up.
 */
export function createMatchmaker({ redis, bus, lobby, logger, options = {} }) {
  const botsEnabled = (options.bots ?? process.env.MM_BOTS ?? 'on') !== 'off';
  const botAfterMs = Number(options.botAfterSec ?? process.env.MM_BOT_FILL_SEC ?? 10) * 1000;
  const maxWaitMs = Number(options.maxWaitSec ?? process.env.MM_MAX_WAIT_SEC ?? 60) * 1000;
  const matchOpts = { botAfterMs };

  async function enqueue({ userId, username, game, maxPlayers }) {
    lobby.validateGame(game, maxPlayers);
    await cancel(userId); // a player is in at most one queue
    const mmr = Number(await redis.zscore(`league:mmr:${game}`, userId)) || INITIAL_RATING; // read-model published by league-service
    await redis.multi()
      .hset(ticketKey(userId), { username, game, size: maxPlayers, mmr, since: Date.now() })
      .expire(ticketKey(userId), TICKET_TTL_SEC)
      .zadd(queueKey(game, maxPlayers), mmr, userId)
      .sadd(QUEUES, `${game}:${maxPlayers}`)
      .exec();
    logger.info({ userId, game, maxPlayers, mmr }, 'queued');
  }

  async function cancel(userId) {
    const t = await redis.hgetall(ticketKey(userId));
    if (t.game) {
      await redis.zrem(queueKey(t.game, t.size), userId);
      await redis.del(ticketKey(userId));
    }
  }

  /** One matchmaking pass. Called every second. */
  async function tick() {
    if ((await redis.set('lobby:mm:lock', '1', 'PX', 900, 'NX')) !== 'OK') return; // another replica is ticking
    for (const q of await redis.smembers(QUEUES)) {
      const [game, size] = q.split(':');
      await processQueue(game, Number(size)).catch((err) => logger.error({ err, q }, 'matchmaking pass failed'));
    }
  }

  async function loadTickets(game, size) {
    const ids = await redis.zrange(queueKey(game, size), 0, -1);
    const rows = await Promise.all(ids.map((id) => redis.hgetall(ticketKey(id))));
    const tickets = [];
    for (const [i, id] of ids.entries()) {
      if (!rows[i].since) { await redis.zrem(queueKey(game, size), id); continue; } // ticket expired
      tickets.push({ id, username: rows[i].username, mmr: Number(rows[i].mmr), since: Number(rows[i].since) });
    }
    return tickets;
  }

  async function processQueue(game, size) {
    const now = Date.now();
    let tickets = await loadTickets(game, size);
    if (!tickets.length) { await redis.srem(QUEUES, `${game}:${size}`); return; }

    const { matches, rest } = findMatches(tickets, size, now, matchOpts);
    for (const group of matches) await seat(game, size, group, []);

    tickets = rest;
    while (tickets.length) {
      const plan = botsEnabled ? planBotFill(tickets, size, now, matchOpts) : null;
      if (!plan) break;
      const bots = plan.botRatings.map((rating, i) => ({
        userId: `bot:${randomUUID()}`, username: `Bot ${BOT_NAMES[(Date.now() + i * 7) % BOT_NAMES.length]}`, isBot: true, rating,
      }));
      await seat(game, size, plan.humans, bots);
      tickets = tickets.filter((t) => !plan.humans.includes(t));
    }

    if (!botsEnabled) { // no bots: give up after maxWait so clients are not left hanging
      for (const t of tickets.filter((x) => now - x.since > maxWaitMs)) {
        await cancel(t.id);
        await bus.publish('events:mm', 'mm.timeout', { userId: t.id });
      }
    }
  }

  /** Remove the group from the queue (atomically per player) and start their match. */
  async function seat(game, size, humans, bots) {
    const removed = [];
    for (const t of humans) if ((await redis.zrem(queueKey(game, size), t.id)) === 1) removed.push(t);
    if (removed.length !== humans.length) { // somebody cancelled in the meantime: put the others back
      for (const t of removed) await redis.zadd(queueKey(game, size), t.mmr, t.id);
      return;
    }
    await Promise.all(humans.map((t) => redis.del(ticketKey(t.id))));
    await lobby.createMatchRoom({
      game, maxPlayers: size,
      players: [...humans.map((t) => ({ userId: t.id, username: t.username })), ...bots],
    });
    logger.info({ game, size, humans: humans.length, bots: bots.length }, 'match created');
  }

  return { enqueue, cancel, tick };
}
