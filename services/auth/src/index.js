import { loadConfig, createLogger, connectMongo, createRedis, createApp, finalize, listen, onShutdown } from '@ipm/common';
import { createAuthService } from './service.js';
import { buildRoutes } from './routes.js';

const config = loadConfig('auth-service');
const port = Number(process.env.AUTH_PORT || process.env.PORT || 4001);
const logger = createLogger(config);

const { client, db } = await connectMongo(config.mongoUrl, 'auth');
const redis = createRedis(config.redisUrl);

const service = createAuthService({ db, redis, config });
await service.init();

const app = createApp({ logger, checks: { mongo: () => db.command({ ping: 1 }), redis: () => redis.ping() } });
app.use('/auth', buildRoutes({ service, config }));
finalize(app, logger);

const server = await listen(app, port, logger);
onShutdown(logger, () => server.close(), () => client.close(), () => redis.quit());
