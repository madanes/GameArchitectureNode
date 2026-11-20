import { Router } from 'express';
import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown, authenticate, asyncHandler } from '@gamearch/common';
import { createGameManager, userChannel } from './gameManager.js';
import { attachWebSocket } from './ws.js';

const config = loadConfig('game-service');
const port = Number(process.env.GAME_PORT || process.env.PORT || 4003);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'game');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'game', logger });
const manager = createGameManager({ redis, db, bus, logger });

// A started lobby room becomes a live game (and every human player is told via match_found).
await bus.subscribe('events:room', 'game-service', async ({ type, data }) => {
  if (type === 'room.started') await manager.createGame(data);
});
// The matchmaker gave up on a player: tell their socket (it may be on any replica -> user pub/sub channel).
await bus.subscribe('events:mm', 'game-service', async ({ type, data }) => {
  if (type === 'mm.timeout') await redis.publish(userChannel(data.userId), JSON.stringify({ type: 'mm_timeout' }));
});

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
const api = Router();
api.use(authenticate(config.jwtSecret));
// Snapshot endpoint for reconnects / debugging. Realtime play happens over WebSocket (/ws).
api.get('/history/me', asyncHandler(async (req, res) => {
  const rows = await db.collection('matches').find({ 'players.userId': req.user.id }).sort({ finishedAt: -1 }).limit(20).toArray();
  res.json(rows);
}));
api.get('/:roomId/state', asyncHandler(async (req, res) => res.json(await manager.assertParticipant(req.params.roomId, req.user.id))));
app.use('/game', api);
finalize(app, logger);

// Turn deadlines, bot moves and finalisation retries.
const ticker = setInterval(() => manager.tick().catch((err) => logger.error({ err }, 'tick failed')), 250);

const server = await listen(app, port, logger);
const ws = attachWebSocket({ server, manager, redis, bus, config, logger });
onShutdown(logger, () => clearInterval(ticker), () => ws.close(), () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
