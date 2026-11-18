import { AppError } from './errors.js';

/** Fixed-window rate limiter backed by Redis, so the limit holds across gateway replicas. Fails open. */
export function rateLimit({ redis, windowSec = 60, max = 120, prefix = 'rl', keyFn = (req) => req.user?.id || req.ip }) {
  return async (req, res, next) => {
    try {
      const key = `${prefix}:${keyFn(req)}:${Math.floor(Date.now() / 1000 / windowSec)}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, windowSec);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - n));
      if (n > max) return next(new AppError(429, 'RATE_LIMITED', 'Too many requests'));
    } catch { /* Redis down: do not block traffic */ }
    next();
  };
}
