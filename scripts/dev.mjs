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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A local Postgres trusting its `postgres` user, and RabbitMQ's `guest`. */
const DEFAULTS = {
  DATABASE_URL: 'postgres://postgres@localhost:5432/flashsale_development',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};

const COLORS = { types: 36, api: 32, worker: 35, web: 33, dev: 34 };
const reset = '\u001B[0m';
const label = (name) => `\u001B[${COLORS[name] ?? 37}m${name.padEnd(6)}${reset} │`;

function say(name, line) {
  if (line.trim()) console.log(`${label(name)} ${line}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

function reachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * Whether `port` can be bound, found by binding it. Bound with no host, so on
 * a dual-stack machine a listener on either IPv4 or IPv6 makes it unavailable.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code));
    server.listen({ port }, () => server.close(() => resolve(true)));
  });
}

/**
 * Refuses to start when the API or web port is taken, typically by an earlier
 * `pnpm dev` still running. Starting anyway fails badly: the API crashes on
 * EADDRINUSE but `node --watch` waits for a file change instead of exiting, so
 * the stack looks up while nothing answers.
 */
async function checkPorts() {
  const ports = [
    ['API', Number(process.env.PORT || 3000)],
    // Must match `server.port` in apps/web/vite.config.ts.
    ['web dev server', 5173],
  ];
  const results = await Promise.all(ports.map(([, port]) => portFree(port)));

  let ok = true;
  ports.forEach(([name, port], i) => {
    if (results[i] === true) return;
    ok = false;
    const why =
      results[i] === 'EADDRINUSE' ? 'is already in use' : `cannot be bound (${results[i]})`;
    say('dev', `port ${port} for the ${name} ${why}`);
  });
  if (!ok) {
    say('dev', '  is another `pnpm dev` still running? Stop it, or free the port, then retry');
    process.exit(1);
  }
}

async function resolveServices() {
  // Values already in the environment win over `.env`, so a one-off override on
  // the command line still works. The devcontainer sets both this way.
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const env = {
    DATABASE_URL: process.env.DATABASE_URL || DEFAULTS.DATABASE_URL,
    RABBITMQ_URL: process.env.RABBITMQ_URL || DEFAULTS.RABBITMQ_URL,
  };

  const pg = new URL(env.DATABASE_URL);
  const mq = new URL(env.RABBITMQ_URL);
  const [pgUp, mqUp] = await Promise.all([
    reachable(pg.hostname, Number(pg.port || 5432)),
    reachable(mq.hostname, Number(mq.port || 5672)),
  ]);

  for (const [up, name, url, variable] of [
    [pgUp, 'Postgres', pg, 'DATABASE_URL'],
    [mqUp, 'RabbitMQ', mq, 'RABBITMQ_URL'],
  ]) {
    if (up) continue;
    say('dev', `cannot reach ${name} at ${url.host}`);
    say('dev', `  start it, or set ${variable} (in the shell or .env) to one that is running`);
  }
  if (!pgUp || !mqUp) process.exit(1);

  say('dev', `postgres ${pg.host}${pg.pathname}, rabbitmq ${mq.host}`);
  return env;
}

const children = [];
let shuttingDown = false;

function start(name, args, env) {
  const child = spawn('pnpm', args, {
    cwd: ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: '1' },
    // Its own process group. pnpm runs scripts through a shell, so signalling
    // the child alone kills the wrapper and orphans the node or vite process
    // underneath it — which then keeps holding its port. Signalling the group
    // takes the whole tree down.
    detached: true,
  });
  children.push({ name, child });

  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) say(name, line);
    });
  }

  child.on('exit', (code) => {
    if (shuttingDown) return;
    say('dev', `${name} exited (${code}) — shutting the rest down`);
    void shutdown(code ?? 1);
  });

  return child;
}

/** Signals the whole process group, so nothing is left holding a port. */
function signalGroup(child, signal) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone, or never got a group — fall back to the child itself.
    try {
      child.kill(signal);
    } catch {
      /* already reaped */
    }
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) signalGroup(child, 'SIGTERM');

  // Give them a moment to close connections, then stop waiting.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const { child } of children) signalGroup(child, 'SIGKILL');
  process.exit(code);
}

const env = await resolveServices();
// After resolveServices, which loads `.env` and so any PORT override in it.
await checkPorts();

say('dev', 'building once so the watchers have something to run…');
await run('pnpm', ['-s', 'build']);

say('dev', 'creating the database if it is missing…');
await run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'create-database'], {
  env: { ...process.env, ...env },
});

say('dev', 'applying migrations…');
await run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'migrate'], {
  env: { ...process.env, ...env },
});

say('dev', 'ensuring a sale exists…');
await run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'seed'], {
  env: { ...process.env, ...env },
});

say('dev', 'starting api, worker and web — ctrl-c to stop all');
start('types', ['-s', 'exec', 'tsc', '-b', '--watch', '--preserveWatchOutput']);
start('api', ['-s', '--filter', '@flash-sale/api', 'dev'], env);
start('worker', ['-s', '--filter', '@flash-sale/worker', 'dev'], env);
start('web', ['-s', '--filter', '@flash-sale/web', 'dev'], env);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(0));
}
