import { loadConfig, createLogger, connectMongo, createRedis, createEventBus, createApp, finalize, listen, onShutdown } from '@gamearch/common';
import { createRewardsService } from './service.js';
import { buildRoutes } from './routes.js';

const config = loadConfig('rewards-service');
const port = Number(process.env.REWARDS_PORT || process.env.PORT || 4006);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'rewards');
const redis = createRedis(config.redisUrl);
const bus = createEventBus({ redis, serviceName: 'rewards', logger });

const service = createRewardsService({ db, logger });
await service.init();

await bus.subscribe('events:game', 'rewards-service', async ({ type, data, ts }) => {
  if (type === 'game.finished') await service.onGameFinished(data, ts);
});
await bus.subscribe('events:league', 'rewards-service', async ({ type, data }) => {
  if (type === 'league.reward') await service.onLeagueReward(data);
});

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
app.use('/rewards', buildRoutes({ service, config }));
finalize(app, logger);

const server = await listen(app, port, logger);
onShutdown(logger, () => server.close(), () => bus.close(), () => client.close(), () => redis.quit());
