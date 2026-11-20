import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown } from '@gamearch/common';
import { createLobbyService } from './service.js';
import { createMatchmaker } from './matchmaker.js';
import { buildRoutes } from './routes.js';

const config = loadConfig('lobby-service');
const port = Number(process.env.LOBBY_PORT || process.env.PORT || 4002);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'lobby');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'lobby', logger });

const service = createLobbyService({ db, bus });
await service.init();
const matchmaker = createMatchmaker({ redis, bus, lobby: service, logger });

// Matchmaking requests arrive as events from the game service's WebSocket layer.
await bus.subscribe('events:mm', 'lobby-service', async ({ type, data }) => {
  if (type === 'mm.join') await matchmaker.enqueue(data).catch((err) => logger.warn({ err: err.message, data }, 'rejected mm.join'));
  if (type === 'mm.cancel') await matchmaker.cancel(data.userId);
});
// Lobby learns that a match ended via the event stream (no direct call from game-service).
await bus.subscribe('events:game', 'lobby-service', async ({ type, data }) => {
  if (type === 'game.finished') await service.markFinished(data.roomId);
});

const ticker = setInterval(() => matchmaker.tick().catch((err) => logger.error({ err }, 'tick failed')), 1000);

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
app.use('/lobby', buildRoutes({ service, config }));
finalize(app, logger);

const server = await listen(app, port, logger);
onShutdown(logger, () => clearInterval(ticker), () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
