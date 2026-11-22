/**
 * What `pnpm dev` and the E2E server share: finding Postgres and RabbitMQ,
 * refusing taken ports, running setup steps in order, and supervising the
 * long-running processes so that one dying takes the rest down with it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const COLORS = { types: 36, api: 32, worker: 35, web: 33, dev: 34, e2e: 34 };
const reset = '\u001B[0m';
const label = (name) => `\u001B[${COLORS[name] ?? 37}m${name.padEnd(6)}${reset} │`;

export function say(name, line) {
  if (line.trim()) console.log(`${label(name)} ${line}`);
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
 * A supervisor that reports as `name`. One per process: it owns the children
 * it starts and the shutdown that stops them.
 */
export function supervisor(name) {
  const children = [];
  let shuttingDown = false;

  /** Runs a setup step to completion, with the step's own output inherited. */
  function run(command, args, env = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...env },
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
      );
    });
  }

  /**
   * Resolves DATABASE_URL and RABBITMQ_URL: the shell first, then `.env`, then
   * `defaults`. Exits, naming the service, if either cannot be reached.
   */
  async function resolveServices(defaults) {
    const envFile = path.join(ROOT, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);

    const env = {
      DATABASE_URL: process.env.DATABASE_URL || defaults.DATABASE_URL,
      RABBITMQ_URL: process.env.RABBITMQ_URL || defaults.RABBITMQ_URL,
    };

    const pg = new URL(env.DATABASE_URL);
    const mq = new URL(env.RABBITMQ_URL);
    const [pgUp, mqUp] = await Promise.all([
      reachable(pg.hostname, Number(pg.port || 5432)),
      reachable(mq.hostname, Number(mq.port || 5672)),
    ]);

    for (const [up, service, url, variable] of [
      [pgUp, 'Postgres', pg, 'DATABASE_URL'],
      [mqUp, 'RabbitMQ', mq, 'RABBITMQ_URL'],
    ]) {
      if (up) continue;
      say(name, `cannot reach ${service} at ${url.host}`);
      say(name, `  start it, or set ${variable} (in the shell or .env) to one that is running`);
    }
    if (!pgUp || !mqUp) process.exit(1);

    say(name, `postgres ${pg.host}${pg.pathname}, rabbitmq ${mq.host}`);
    return env;
  }

  /**
   * Refuses to start when a port is taken, typically by an earlier run still
   * going. Starting anyway fails badly: a server under `node --watch` crashes
   * on EADDRINUSE and then waits for a file change instead of exiting, so the
   * stack looks up while nothing answers.
   */
  async function checkPorts(ports, hint) {
    const results = await Promise.all(ports.map(([, port]) => portFree(port)));

    let ok = true;
    ports.forEach(([service, port], i) => {
      if (results[i] === true) return;
      ok = false;
      const why =
        results[i] === 'EADDRINUSE' ? 'is already in use' : `cannot be bound (${results[i]})`;
      say(name, `port ${port} for the ${service} ${why}`);
    });
    if (!ok) {
      say(name, `  ${hint}`);
      process.exit(1);
    }
  }

  /**
   * Starts a long-running process whose exit brings the whole stack down.
   *
   * By default in its own process group: pnpm runs scripts through a shell, so
   * signalling the child alone kills the wrapper and orphans the node or vite
   * process underneath it — which then keeps holding its port. Signalling the
   * group takes the whole tree down. Pass `{ ownGroup: false }` for a process
   * that is not wrapped, so it stays in ours and dies with us even when we are
   * SIGKILLed and never get to signal anything.
   */
  function start(childName, command, args, env = {}, { ownGroup = true } = {}) {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env, FORCE_COLOR: '1' },
      detached: ownGroup,
    });
    children.push(child);

    for (const stream of [child.stdout, child.stderr]) {
      let buffered = '';
      stream.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) say(childName, line);
      });
    }

    child.on('exit', (code) => {
      if (shuttingDown) return;
      say(name, `${childName} exited (${code}) — shutting the rest down`);
      void shutdown(code ?? 1);
    });
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
    for (const child of children) signalGroup(child, 'SIGTERM');

    // Give them a moment to close connections, then stop waiting.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const child of children) signalGroup(child, 'SIGKILL');
    process.exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void shutdown(0));
  }

  return { say: (line) => say(name, line), run, resolveServices, checkPorts, start };
}
