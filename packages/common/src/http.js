import express from 'express';
import { randomUUID } from 'node:crypto';
import { errorHandler, notFoundHandler } from './errors.js';

/**
 * Standard service skeleton: JSON body parsing, request logging, /health.
 * `checks` is { name: async () => void } - throw to mark the dependency unhealthy.
 */
export function createApp({ logger, checks = {}, json = true }) {
  const app = express();
  app.disable('x-powered-by');
  if (json) app.use(express.json({ limit: '100kb' }));

  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || randomUUID();
    res.setHeader('x-request-id', req.id);
    const start = Date.now();
    res.on('finish', () => {
      if (req.path !== '/health') logger.info({ reqId: req.id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - start }, 'req');
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    const result = {};
    let ok = true;
    for (const [name, fn] of Object.entries(checks)) {
      try { await fn(); result[name] = 'up'; } catch { result[name] = 'down'; ok = false; }
    }
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks: result });
  });
  return app;
}

/** Call after all routes are mounted. */
export function finalize(app, logger) {
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
}

export function listen(app, port, logger) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info({ port }, 'listening');
      resolve(server);
    });
  });
}

/** Run cleanup callbacks on SIGINT/SIGTERM (container stop) and exit. */
export function onShutdown(logger, ...fns) {
  let done = false;
  const handler = async (sig) => {
    if (done) return;
    done = true;
    logger.info({ sig }, 'shutting down');
    for (const fn of fns) { try { await fn(); } catch (err) { logger.error({ err }, 'shutdown step failed'); } }
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
