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
 * Host ports are discovered from Compose rather than assumed, so this works
 * whatever POSTGRES_PORT / RABBITMQ_PORT happen to be.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('exit', () => resolve(out.trim()));
  });
}

async function composePort(service, containerPort) {
  const mapped = await capture('docker', ['compose', 'port', service, String(containerPort)]);
  const port = mapped.split(':').pop();
  return port && /^\d+$/.test(port) ? Number(port) : undefined;
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

async function resolveServices() {
  const [pgPort, mqPort] = await Promise.all([
    composePort('postgres', 5432),
    composePort('rabbitmq', 5672),
  ]);

  if (!pgPort || !mqPort) {
    say('dev', 'Postgres and RabbitMQ are not running. Start them with:');
    say('dev', '  docker compose up -d --wait');
    process.exit(1);
  }

  const [pgUp, mqUp] = await Promise.all([
    reachable('127.0.0.1', pgPort),
    reachable('127.0.0.1', mqPort),
  ]);
  if (!pgUp || !mqUp) {
    say('dev', `services mapped but not accepting connections (pg:${pgPort} mq:${mqPort})`);
    say('dev', '  docker compose up -d --wait');
    process.exit(1);
  }

  say('dev', `postgres on ${pgPort}, rabbitmq on ${mqPort}`);
  return {
    DATABASE_URL: `postgres://flashsale:flashsale@127.0.0.1:${pgPort}/flashsale`,
    RABBITMQ_URL: `amqp://flashsale:flashsale@127.0.0.1:${mqPort}`,
  };
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

say('dev', 'building once so the watchers have something to run…');
await run('pnpm', ['-s', 'build']);

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
