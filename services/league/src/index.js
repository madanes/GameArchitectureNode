import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown } from '@ipm/common';
import { createLeagueService } from './service.js';
import { buildRoutes } from './routes.js';

const config = loadConfig('league-service');
const port = Number(process.env.LEAGUE_PORT || process.env.PORT || 4005);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'league');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'league', logger });

const service = createLeagueService({ db, redis, bus, logger });
await service.init();

await bus.subscribe('events:game', 'league-service', async ({ type, data }) => {
  if (type === 'game.finished') await service.onGameFinished(data);
});

// Season rollover check. Cheap and idempotent; a Redis lock makes only one replica do the work.
const timer = setInterval(() => service.rollover().catch((err) => logger.error({ err }, 'rollover failed')), 30_000);
service.rollover().catch((err) => logger.error({ err }, 'rollover failed'));

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
app.use('/league', buildRoutes({ service, config }));
finalize(app, logger);

const server = await listen(app, port, logger);
onShutdown(logger, () => clearInterval(timer), () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
