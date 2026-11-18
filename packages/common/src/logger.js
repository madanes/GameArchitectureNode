import pino from 'pino';

export function createLogger(config) {
  return pino({ name: config.service, level: config.logLevel });
}
