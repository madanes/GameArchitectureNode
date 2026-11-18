import { Router } from 'express';
import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown, authenticate, asyncHandler } from '@ipm/common';
import { createGameManager } from './gameManager.js';
import { attachWebSocket } from './ws.js';

const config = loadConfig('game-service');
const port = Number(process.env.GAME_PORT || process.env.PORT || 4003);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'game');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'game', logger });
const manager = createGameManager({ redis, db, bus, logger });

// A started lobby room becomes a live game.
await bus.subscribe('events:room', 'game-service', async ({ type, data }) => {
  if (type === 'room.started') await manager.createGame(data);
});

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
const api = Router();
api.use(authenticate(config.jwtSecret));
// Snapshot endpoint for reconnects / debugging. Realtime play happens over WebSocket (/ws).
api.get('/:roomId/state', asyncHandler(async (req, res) => res.json(await manager.assertParticipant(req.params.roomId, req.user.id))));
api.get('/history/me', asyncHandler(async (req, res) => {
  const rows = await db.collection('matches').find({ 'players.userId': req.user.id }).sort({ finishedAt: -1 }).limit(20).toArray();
  res.json(rows);
}));
app.use('/game', api);
finalize(app, logger);

const server = await listen(app, port, logger);
const ws = attachWebSocket({ server, manager, redis, config, logger });
onShutdown(logger, () => ws.close(), () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
