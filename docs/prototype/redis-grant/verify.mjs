// Verifies the grant.lua invariants against a real Redis using raw RESP over
// N concurrent sockets. No dependencies.
import net from 'node:net';
import fs from 'node:fs';

const PORT = 6399;
const KEYS = ['sale:t:stock', 'sale:t:buyers', 'sale:t:orders', 'sale:t:window'];

const enc = (...args) =>
  `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('');

// Minimal RESP reader: handles +, -, :, $, * (one level of nesting is enough here).
function makeReader(onReply) {
  let buf = Buffer.alloc(0);
  // Parse one value at offset; returns [value, nextOffset] or null if incomplete.
  function parse(off) {
    const nl = buf.indexOf('\r\n', off);
    if (nl === -1) return null;
    const type = String.fromCharCode(buf[off]);
    const head = buf.toString('utf8', off + 1, nl);
    if (type === '+' || type === '-' || type === ':') return [head, nl + 2];
    if (type === '$') {
      const len = Number(head);
      if (len === -1) return [null, nl + 2];
      if (buf.length < nl + 2 + len + 2) return null;
      return [buf.toString('utf8', nl + 2, nl + 2 + len), nl + 2 + len + 2];
    }
    if (type === '*') {
      const n = Number(head);
      if (n === -1) return [null, nl + 2];
      const out = [];
      let cur = nl + 2;
      for (let i = 0; i < n; i++) {
        const r = parse(cur);
        if (!r) return null;
        out.push(r[0]);
        cur = r[1];
      }
      return [out, cur];
    }
    throw new Error(`unexpected RESP type ${type} at ${off}`);
  }
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let off = 0;
    for (;;) {
      const r = parse(off);
      if (!r) break;
      onReply(r[0]);
      off = r[1];
    }
    buf = buf.subarray(off);
  };
}

function connect() {
  return new Promise((res) => {
    const s = net.createConnection(PORT, '127.0.0.1', () => res(s));
    s.setNoDelay(true);
  });
}

// Send `cmds` (array of encoded strings) on one socket, resolve with all replies.
function pipeline(sock, cmds) {
  return new Promise((res, rej) => {
    const replies = [];
    const read = makeReader((v) => {
      replies.push(v);
      if (replies.length === cmds.length) {
        sock.off('data', read);
        res(replies);
      }
    });
    sock.on('data', read);
    sock.once('error', rej);
    sock.write(cmds.join(''));
  });
}

const ctl = await connect();
const one = async (...args) => (await pipeline(ctl, [enc(...args)]))[0];

const sha = await one('SCRIPT', 'LOAD', fs.readFileSync('grant.lua', 'utf8'));
console.log(`script loaded: ${sha}`);

const grant = (user, order) => enc('EVALSHA', sha, 4, ...KEYS, user, order);

async function reset(stock, startOffMs, endOffMs) {
  const now = Date.now();
  await pipeline(ctl, [
    enc('DEL', ...KEYS),
    enc('SET', KEYS[0], String(stock)),
    enc('HSET', KEYS[3], 'startAtMs', String(now + startOffMs), 'endAtMs', String(now + endOffMs)),
  ]);
}

async function state() {
  const [stock, buyers, orders] = await pipeline(ctl, [
    enc('GET', KEYS[0]),
    enc('SCARD', KEYS[1]),
    enc('XLEN', KEYS[2]),
  ]);
  return { stock: Number(stock), buyers: Number(buyers), orders: Number(orders) };
}

// Fan `total` grant calls across `socks` sockets, all in flight at once.
async function fanout(socks, total, userFor) {
  const per = Math.ceil(total / socks.length);
  const batches = socks.map((s, i) => {
    const cmds = [];
    for (let n = i * per; n < Math.min(total, (i + 1) * per); n++) {
      cmds.push(grant(userFor(n), `order-${n}`));
    }
    return cmds.length ? pipeline(s, cmds) : Promise.resolve([]);
  });
  const all = (await Promise.all(batches)).flat();
  const tally = {};
  for (const r of all) tally[r[0]] = (tally[r[0]] || 0) + 1;
  return { tally, count: all.length };
}

const socks = await Promise.all(Array.from({ length: 50 }, connect));
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` != ${JSON.stringify(expected)}`}`);
};

console.log('\nTest A — no oversell: stock 1000, 20000 distinct users, 50 sockets');
await reset(1000, -1000, 600000);
let t0 = Date.now();
let r = await fanout(socks, 20000, (n) => `user-${n}`);
let ms = Date.now() - t0;
check('tally', r.tally, { CONFIRMED: 1000, SOLD_OUT: 19000 });
check('redis state', await state(), { stock: 0, buyers: 1000, orders: 1000 });
console.log(`  ${r.count} grants in ${ms}ms (~${Math.round(r.count / (ms / 1000)).toLocaleString()} ops/s, single redis)`);

console.log('\nTest B — no double-grant: stock 1000, 1000 attempts from ONE user');
await reset(1000, -1000, 600000);
r = await fanout(socks, 1000, () => 'same-user');
check('tally', r.tally, { CONFIRMED: 1, ALREADY_PURCHASED: 999 });
check('redis state', await state(), { stock: 999, buyers: 1, orders: 1 });

console.log('\nTest C — window boundaries');
await reset(1000, 60000, 600000); // starts in 60s
check('before start', (await fanout(socks, 10, (n) => `early-${n}`)).tally, { NOT_STARTED: 10 });
await reset(1000, -600000, -1000); // ended 1s ago
check('after end', (await fanout(socks, 10, (n) => `late-${n}`)).tally, { ENDED: 10 });
check('no stock consumed', await state(), { stock: 1000, buyers: 0, orders: 0 });

console.log('\nTest D — unconfigured sale');
await pipeline(ctl, [enc('DEL', ...KEYS), enc('SET', KEYS[0], '1000')]);
check('no window hash', (await fanout(socks, 5, (n) => `u-${n}`)).tally, { NOT_CONFIGURED: 5 });

console.log('\nTest E — sold out is not sticky for the buyer set');
await reset(2, -1000, 600000);
r = await fanout(socks, 100, (n) => `u-${n}`);
check('tally', r.tally, { CONFIRMED: 2, SOLD_OUT: 98 });
check('only winners in buyers set', await state(), { stock: 0, buyers: 2, orders: 2 });

await pipeline(ctl, [enc('DEL', ...KEYS)]);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
