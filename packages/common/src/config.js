const DEFAULT_SECRET = 'dev-secret-change-me';
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/**
 * Central, 12-factor configuration. Every value comes from the environment so the
 * same container image runs unchanged in dev, staging and production.
 */
export function loadConfig(service, overrides = {}) {
  const e = process.env;
  const config = {
    service,
    env: e.NODE_ENV || 'development',
    logLevel: e.LOG_LEVEL || 'info',
    mongoUrl: e.MONGO_URL || 'mongodb://localhost:27017',
    redisUrl: e.REDIS_URL || 'redis://localhost:6379',
    jwtSecret: e.JWT_SECRET || DEFAULT_SECRET,
    accessTtlSec: num(e.ACCESS_TTL_SEC, 900),
    refreshTtlSec: num(e.REFRESH_TTL_SEC, 60 * 60 * 24 * 30),
    ...overrides,
  };
  if (config.env === 'production' && config.jwtSecret === DEFAULT_SECRET) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return config;
}
