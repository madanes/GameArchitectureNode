import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown } from '@ipm/common';
import { createLobbyService } from './service.js';
import { buildRoutes } from './routes.js';

const config = loadConfig('lobby-service');
const port = Number(process.env.LOBBY_PORT || process.env.PORT || 4002);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'lobby');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'lobby', logger });

const service = createLobbyService({ db, redis, bus });
await service.init();

// Lobby learns that a match ended via the event stream (no direct call from game-service).
await bus.subscribe('events:game', 'lobby-service', async ({ type, data }) => {
  if (type === 'game.finished') await service.markFinished(data.roomId);
});

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
app.use('/lobby', buildRoutes({ service, config }));
finalize(app, logger);

const server = await listen(app, port, logger);
onShutdown(logger, () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
