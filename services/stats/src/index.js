import { Router } from 'express';
import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown, authenticate, asyncHandler, isDuplicateKey } from '@gamearch/common';

const config = loadConfig('stats-service');
const port = Number(process.env.STATS_PORT || process.env.PORT || 4004);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'stats');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'stats', logger });

const stats = db.collection('player_stats');
const processed = db.collection('processed_matches');
await stats.createIndex({ userId: 1, game: 1 }, { unique: true });

const POINTS = [30, 15, 5, 0, 0, 0, 0, 0]; // by finishing rank (0 = winner)
const lbKey = (game) => `stats:lb:${game}`;

// Consume game results: update per-player stats in Mongo and the live leaderboard in Redis.
await bus.subscribe('events:game', 'stats-service', async ({ type, data }) => {
  if (type !== 'game.finished') return;
  // Idempotency: events are at-least-once, so process each match exactly once.
  try { await processed.insertOne({ _id: data.matchId, at: new Date() }); } catch (err) { if (isDuplicateKey(err)) return; throw err; }
  const bots = new Set(data.players.filter((p) => p.isBot).map((p) => p.userId)); // bots have no stats
  try {
    for (const [i, userId] of data.ranking.entries()) {
      if (bots.has(userId)) continue;
      const username = data.players.find((p) => p.userId === userId)?.username;
      const points = POINTS[i] ?? 0;
      await stats.updateOne(
        { userId, game: data.game },
        { $inc: { played: 1, wins: i === 0 ? 1 : 0, points }, $set: { username, updatedAt: new Date() } },
        { upsert: true },
      );
      await redis.zincrby(lbKey(data.game), points, userId);
    }
  } catch (err) {
    await processed.deleteOne({ _id: data.matchId }); // allow retry
    throw err;
  }
});

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
const api = Router();
api.use(authenticate(config.jwtSecret));

api.get('/leaderboard/:game', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const top = await redis.zrevrange(lbKey(req.params.game), 0, limit - 1, 'WITHSCORES');
  const ids = top.filter((_, i) => i % 2 === 0);
  const docs = await stats.find({ game: req.params.game, userId: { $in: ids } }).toArray();
  const byId = new Map(docs.map((d) => [d.userId, d]));
  res.json(ids.map((userId, i) => ({
    rank: i + 1, userId, username: byId.get(userId)?.username, points: Number(top[i * 2 + 1]),
    played: byId.get(userId)?.played ?? 0, wins: byId.get(userId)?.wins ?? 0,
  })));
}));

api.get('/me', asyncHandler(async (req, res) => {
  const rows = await stats.find({ userId: req.user.id }).toArray();
  const withRank = await Promise.all(rows.map(async (r) => {
    const rank = await redis.zrevrank(lbKey(r.game), r.userId);
    return { game: r.game, played: r.played, wins: r.wins, points: r.points, rank: rank === null ? null : rank + 1 };
  }));
  res.json(withRank);
}));

app.use('/stats', api);
finalize(app, logger);

const server = await listen(app, port, logger);
onShutdown(logger, () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
