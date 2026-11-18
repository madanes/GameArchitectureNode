/**
 * Event bus on Redis Streams.
 *
 * - publish(): XADD to a stream (capped so it cannot grow unbounded).
 * - subscribe(): consumer-group read loop. Each *group* (one per service) receives every
 *   event once; replicas of the same service share the group and split the work.
 *   Events are XACKed only after the handler succeeds, so a crash means redelivery
 *   (at-least-once). Handlers MUST be idempotent.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toObject = (fields) => {
  const o = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
};

export function createEventBus({ redis, serviceName, logger }) {
  let running = true;
  const connections = [];

  async function publish(stream, type, data) {
    return redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'type', type, 'data', JSON.stringify(data), 'ts', Date.now());
  }

  async function subscribe(stream, group, handler) {
    try {
      await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
    const conn = redis.duplicate(); // blocking reads need a dedicated connection
    connections.push(conn);
    const consumer = `${serviceName}-${process.pid}`;

    const process_ = async (entries) => {
      for (const [id, fields] of entries) {
        const evt = toObject(fields);
        try {
          await handler({ id, type: evt.type, data: JSON.parse(evt.data), ts: Number(evt.ts) });
          await conn.xack(stream, group, id);
        } catch (err) {
          logger.error({ err, stream, id, type: evt.type }, 'event handler failed; will retry on restart');
        }
      }
    };

    (async () => {
      // 1) recover events delivered to us earlier but never acknowledged
      try {
        const pending = await conn.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'STREAMS', stream, '0');
        if (pending?.[0]) await process_(pending[0][1]);
      } catch (err) {
        logger.error({ err }, 'pending recovery failed');
      }
      // 2) normal loop
      while (running) {
        try {
          const res = await conn.xreadgroup('GROUP', group, consumer, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', stream, '>');
          if (res?.[0]) await process_(res[0][1]);
        } catch (err) {
          if (!running) return;
          logger.error({ err }, 'event loop error');
          await sleep(1000);
        }
      }
    })();
  }

  async function close() {
    running = false;
    connections.forEach((c) => c.disconnect());
  }

  return { publish, subscribe, close };
}
