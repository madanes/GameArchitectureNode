import Redis from 'ioredis';

export function createRedis(url, opts = {}) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, ...opts });
}
