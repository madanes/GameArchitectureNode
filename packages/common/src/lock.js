import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const RELEASE = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Short distributed mutex (SET NX PX + token-checked release).
 * Serialises all actions on one game room even when many game-service replicas are running.
 */
export async function withLock(redis, key, fn, { ttlMs = 5000, retries = 40, delayMs = 25 } = {}) {
  const token = randomUUID();
  for (let i = 0; i < retries; i++) {
    if ((await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK') {
      try { return await fn(); } finally { await redis.eval(RELEASE, 1, key, token); }
    }
    await sleep(delayMs);
  }
  throw new AppError(423, 'LOCKED', 'Resource busy, retry');
}
