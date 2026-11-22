#!/usr/bin/env node
/**
 * Starts everything needed to work on the project: a TypeScript watcher, the
 * API, the worker, and the web dev server.
 *
 * It is a script rather than `concurrently` or `pnpm -r --parallel` because
 * the interesting part is not running things side by side — it is what has to
 * happen first. Services must be reachable, migrations must be applied before
 * the API reads `sales`, and the compiled output must exist before `node
 * --watch` has anything to run. A generic runner does none of that ordering.
 *
 * By default it uses the Postgres and RabbitMQ already running on this machine,
 * with their stock credentials, so `pnpm dev` is the only command needed. Point
 * it elsewhere with DATABASE_URL / RABBITMQ_URL, from the shell or `.env`.
 */
import { supervisor } from './lib/stack.mjs';

const dev = supervisor('dev');

const env = await dev.resolveServices('development');
// After resolveServices, which loads `.env` and so any PORT override in it.
await dev.checkPorts(
  [
    ['API', Number(process.env.PORT || 3000)],
    // Must match `server.port` in apps/web/vite.config.ts.
    ['web dev server', 5173],
  ],
  'is another `pnpm dev` still running? Stop it, or free the port, then retry',
);

dev.say('building once so the watchers have something to run…');
await dev.run('pnpm', ['-s', 'build']);

dev.say('creating the database if it is missing…');
await dev.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'create-database'], env);

dev.say('applying migrations…');
await dev.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'migrate'], env);

dev.say('ensuring a sale exists…');
await dev.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'seed'], env);

dev.say('starting api, worker and web — ctrl-c to stop all');
dev.start('types', 'pnpm', ['-s', 'exec', 'tsc', '-b', '--watch', '--preserveWatchOutput']);
dev.start('api', 'pnpm', ['-s', '--filter', '@flash-sale/api', 'dev'], env);
dev.start('worker', 'pnpm', ['-s', '--filter', '@flash-sale/worker', 'dev'], env);
dev.start('web', 'pnpm', ['-s', '--filter', '@flash-sale/web', 'dev'], env);
