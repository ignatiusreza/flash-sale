/**
 * What `pnpm dev` and the E2E server share: finding Postgres and RabbitMQ,
 * refusing taken ports, running setup steps in order, and supervising the
 * long-running processes so that one dying takes the rest down with it.
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseUrlFor } from './database-url.mjs';

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
/**
 * `logDir`, if given, sends every child's output to a file of its own there —
 * `<name>.log` for a long-running process, `setup.log` for the steps `run`
 * takes unless told otherwise — instead of to the terminal, which is left to
 * the supervisor's own lines.
 */
export function supervisor(name, { logDir } = {}) {
  const children = [];
  const cleanups = [];
  let shuttingDown = false;
  if (logDir) mkdirSync(logDir, { recursive: true });

  const logs = new Map();
  /** The file a child writes to, opened afresh the first time in a run. */
  function logFile(logName) {
    const file = path.join(logDir, `${logName}.log`);
    if (!logs.has(file)) logs.set(file, openSync(file, 'w'));
    return { file, fd: logs.get(file) };
  }
  const relative = (file) => path.relative(ROOT, file);

  /**
   * The last lines a log's process wrote, so a failure can be read where it is
   * reported — without the `$ command` lines `run` heads each step with.
   */
  function tail(file, lines = 20) {
    return readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((line) => !line.startsWith('$ '))
      .slice(-lines);
  }

  /**
   * Runs a setup step to completion: its output inherited, or with `logDir`
   * appended to `<logAs>.log` — and the end of that shown if the step fails.
   * Resolves the exit code; codes in `answers` are results to read, not
   * failures, so they resolve too and show nothing.
   */
  function run(command, args, env = {}, { logAs = 'setup', answers = [0] } = {}) {
    const log = logDir ? logFile(logAs) : undefined;
    if (log) writeSync(log.fd, `$ ${command} ${args.join(' ')}\n`);

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: ROOT,
        stdio: log ? ['ignore', log.fd, log.fd] : 'inherit',
        env: { ...process.env, ...env },
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (answers.includes(code)) return resolve(code);
        if (log) {
          say(name, `${command} exited with ${code}; the end of ${relative(log.file)}:`);
          for (const line of tail(log.file)) say(name, `  ${line}`);
        }
        reject(new Error(`${command} exited with ${code}`));
      });
    });
  }

  /**
   * The environment for `APP_ENV` (development, test, e2e): its own database
   * and its own RabbitMQ names, on whichever services it finds.
   *
   * DATABASE_URL and RABBITMQ_URL come from the shell first, then `.env` unless
   * `readEnvFile` is false, then default to the local services with their stock
   * credentials — Postgres's passwordless `postgres`, RabbitMQ's `guest`. A
   * DATABASE_URL naming no database gets one named for the environment
   * (`databaseUrlFor`). Exits, naming the service, if either cannot be reached.
   */
  async function resolveServices(appEnv, { readEnvFile = true } = {}) {
    const envFile = path.join(ROOT, '.env');
    if (readEnvFile && existsSync(envFile)) process.loadEnvFile(envFile);

    const env = {
      APP_ENV: appEnv,
      DATABASE_URL: databaseUrlFor(
        process.env.DATABASE_URL || 'postgres://postgres@localhost:5432',
        appEnv,
      ),
      RABBITMQ_URL: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
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

    say(name, `environment ${appEnv}: postgres ${pg.host}${pg.pathname}, rabbitmq ${mq.host}`);
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
    const log = logDir ? logFile(childName) : undefined;
    const child = spawn(command, args, {
      cwd: ROOT,
      // Colour only for a terminal: in a file it is escape codes.
      env: { ...process.env, ...env, ...(log ? {} : { FORCE_COLOR: '1' }) },
      detached: ownGroup,
    });
    children.push(child);

    // To a file, the child still writes into a pipe, and its bytes are copied
    // across as they come. Handing it the file itself slowed the API under
    // load: its logger writes synchronously, and a quiet stress phase's p99
    // went from 37 ms to 185–494 ms.
    const out = log ? createWriteStream('', { fd: log.fd, autoClose: false }) : undefined;
    if (out) {
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
    } else {
      for (const stream of [child.stdout, child.stderr]) {
        let buffered = '';
        stream.on('data', (chunk) => {
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) say(childName, line);
        });
      }
    }

    child.on('exit', (code) => {
      if (shuttingDown) return;
      say(name, `${childName} exited (${code}) — shutting the rest down`);
      if (!out) return void shutdown(code ?? 1);
      // Once what it wrote last has reached the file.
      out.write('', () => {
        say(name, `the end of ${relative(log.file)}:`);
        for (const line of tail(log.file)) say(name, `  ${line}`);
        void shutdown(code ?? 1);
      });
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

  /**
   * Something else to undo on the way out, however the run ends — for what
   * outlives a killed child, like a container its `docker run` started.
   */
  function onShutdown(cleanup) {
    cleanups.push(cleanup);
  }

  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    for (const child of children) signalGroup(child, 'SIGTERM');

    // Give them a moment to close connections, then stop waiting.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const child of children) signalGroup(child, 'SIGKILL');
    process.exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void shutdown(0));
  }
  // A crash in the script itself — a top-level await that throws lands here
  // too — must still stop the children, or they outlive it holding ports.
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
      console.error(error);
      void shutdown(1);
    });
  }

  return {
    say: (line) => say(name, line),
    run,
    resolveServices,
    checkPorts,
    start,
    onShutdown,
    shutdown,
  };
}
