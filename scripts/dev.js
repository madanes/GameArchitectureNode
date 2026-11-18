// Runs every service locally with auto-reload and prefixed logs:  npm run dev
// Requires Mongo + Redis (npm run infra).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const services = ['auth', 'lobby', 'game', 'stats', 'gateway'];
const children = services.map((name) => {
  const child = spawn('node', ['--watch', '--env-file-if-exists=.env', `services/${name}/src/index.js`], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (l) => console.log(`[${name.padEnd(7)}] ${l}`));
  }
  return child;
});
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
