import { createProxyMiddleware } from 'http-proxy-middleware';
import { loadConfig, createLogger, createRedis, createApp, finalize, listen, onShutdown, authenticate, rateLimit } from '@gamearch/common';

const config = loadConfig('gateway');
const port = Number(process.env.GATEWAY_PORT || process.env.PORT || 8080);
const logger = createLogger(config);
const redis = createRedis(config.redisUrl);

const upstream = {
  auth: process.env.AUTH_URL || 'http://localhost:4001',
  lobby: process.env.LOBBY_URL || 'http://localhost:4002',
  game: process.env.GAME_URL || 'http://localhost:4003',
  stats: process.env.STATS_URL || 'http://localhost:4004',
  league: process.env.LEAGUE_URL || 'http://localhost:4005',
  rewards: process.env.REWARDS_URL || 'http://localhost:4006',
};

// The gateway streams bodies straight to upstreams, so it must NOT parse JSON itself.
const app = createApp({ logger, json: false, checks: { redis: () => redis.ping() } });

const PUBLIC = new Set(['/auth/register', '/auth/login', '/auth/guest', '/auth/refresh', '/lobby/games']);
const verify = authenticate(config.jwtSecret);

app.use('/api', rateLimit({ redis, prefix: 'rl:gw:ip', windowSec: 60, max: 600, keyFn: (req) => req.ip })); // coarse per-IP limit
app.use('/api/auth', rateLimit({ redis, prefix: 'rl:gw:auth', windowSec: 60, max: 20, keyFn: (req) => req.ip })); // brute-force guard
// Early rejection of unauthenticated calls. Services re-verify the JWT themselves (zero trust).
app.use('/api', (req, res, next) => (PUBLIC.has(req.path) ? next() : verify(req, res, next)));

// pathFilter + pathRewrite keeps routing explicit and independent of express mount-path stripping.
const proxy = (prefix, target, rewriteTo) => createProxyMiddleware({
  target, changeOrigin: true, pathFilter: prefix, pathRewrite: { [`^${prefix}`]: rewriteTo },
  on: { error: (err, _req, res) => { logger.error({ err: err.message, target }, 'upstream error'); res.writeHead?.(502, { 'content-type': 'application/json' }); res.end?.(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'Upstream unavailable' } })); } },
});

app.use(proxy('/api/auth', upstream.auth, '/auth'));
app.use(proxy('/api/lobby', upstream.lobby, '/lobby'));
app.use(proxy('/api/game', upstream.game, '/game'));
app.use(proxy('/api/stats', upstream.stats, '/stats'));
app.use(proxy('/api/league', upstream.league, '/league'));
app.use(proxy('/api/rewards', upstream.rewards, '/rewards'));

// WebSocket traffic (gameplay AND matchmaking) is proxied to the game service (token is verified there on upgrade).
const wsProxy = createProxyMiddleware({ target: upstream.game, changeOrigin: true, ws: true, pathFilter: '/ws' });
app.use(wsProxy);

finalize(app, logger);

const server = await listen(app, port, logger);
server.on('upgrade', wsProxy.upgrade);
onShutdown(logger, () => server.close(), () => redis.quit());
