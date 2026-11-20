// Postgres vs MongoDB for the flash-sale claim, measured through equivalent
// Node clients so neither side gets a native-tool advantage.
//
// Both run the SAME model: stock pre-warmed as N claimable rows/documents,
// claimed one at a time. That is the pool model from ../postgres-pool, and it
// is the only model both engines can express without a multi-document
// transaction — which is itself part of the finding.
import pg from 'pg';
import { MongoClient } from 'mongodb';

const PG = { host: '127.0.0.1', port: 5499, user: 'postgres', database: 'postgres' };
const MONGO_URL = 'mongodb://127.0.0.1:27019/?replicaSet=rs0&directConnection=true';

const CONCURRENCY = Number(process.env.CONC ?? 50);
const DURATION_MS = Number(process.env.DUR ?? 10000);

// ---------- Postgres ----------

async function pgSetup(pool, slots) {
  await pool.query('DROP TABLE IF EXISTS orders_pool');
  await pool.query(`CREATE TABLE orders_pool (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id TEXT, created_at TIMESTAMPTZ, UNIQUE (user_id))`);
  await pool.query('CREATE INDEX ON orders_pool (id) WHERE user_id IS NULL');
  await pool.query('INSERT INTO orders_pool (user_id) SELECT NULL FROM generate_series(1,$1)', [slots]);
  await pool.query('ANALYZE orders_pool');
}

const PG_CLAIM = `
  UPDATE orders_pool SET user_id = $1, created_at = now()
  WHERE id = (SELECT id FROM orders_pool WHERE user_id IS NULL
              ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING id`;

async function pgClaim(pool, user) {
  const r = await pool.query(PG_CLAIM, [user]);
  return r.rowCount === 1;
}

async function pgCount(pool) {
  const r = await pool.query('SELECT count(*) FILTER (WHERE user_id IS NOT NULL) AS filled, count(DISTINCT user_id) AS users FROM orders_pool');
  return { filled: Number(r.rows[0].filled), users: Number(r.rows[0].users) };
}

// ---------- MongoDB ----------

async function mongoSetup(db, slots) {
  await db.collection('orders').drop().catch(() => {});
  await db.createCollection('orders');
  const col = db.collection('orders');
  // A plain unique index will NOT do here: Mongo treats `null` as a value, so
  // every free slot collides. Postgres gives this for free because NULLs are
  // mutually distinct in a unique index. A partial index is the equivalent.
  await col.createIndex({ userId: 1 }, {
    unique: true,
    partialFilterExpression: { userId: { $type: 'string' } },
  });
  await col.createIndex({ userId: 1, _id: 1 });
  const docs = [];
  for (let i = 0; i < slots; i++) docs.push({ _id: i, userId: null, createdAt: null });
  // insert in chunks so a large prewarm does not blow the BSON batch limit
  for (let i = 0; i < docs.length; i += 10000) {
    await col.insertMany(docs.slice(i, i + 10000), { ordered: false });
  }
}

// findOneAndUpdate is atomic on a single document. The predicate is applied at
// update time, so a concurrent claimant cannot take a document already taken —
// no explicit SKIP LOCKED equivalent is needed.
// With `sort`, every concurrent claimant targets the SAME lowest _id and they
// serialise on write conflicts — Mongo has no SKIP LOCKED to break the convoy.
// Without it, claimants spread out but arrival order is lost.
const MONGO_SORT = process.env.MONGO_SORT !== '0';

async function mongoClaim(col, user) {
  const opts = { projection: { _id: 1 } };
  if (MONGO_SORT) opts.sort = { _id: 1 };
  const r = await col.findOneAndUpdate(
    { userId: null },
    { $set: { userId: user, createdAt: new Date() } },
    opts,
  );
  return r !== null;
}

async function mongoCount(col) {
  const filled = await col.countDocuments({ userId: { $ne: null } });
  const users = (await col.distinct('userId', { userId: { $ne: null } })).length;
  return { filled, users };
}

// ---------- harness ----------

async function drive(label, claimFn, durationMs, concurrency) {
  let ok = 0, fail = 0, n = 0;
  const latencies = [];
  const deadline = Date.now() + durationMs;
  async function worker(id) {
    while (Date.now() < deadline) {
      const t = process.hrtime.bigint();
      const got = await claimFn(`${label}-${id}-${n++}`);
      latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
      got ? ok++ : fail++;
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    claims: ok,
    rejected: fail,
    perSec: Math.round(ok / elapsed),
    p50: +latencies[Math.floor(latencies.length * 0.5)].toFixed(2),
    p99: +latencies[Math.floor(latencies.length * 0.99)].toFixed(2),
  };
}

const mode = process.argv[2] ?? 'throughput';
const pool = new pg.Pool({ ...PG, max: CONCURRENCY + 5 });
const mongo = new MongoClient(MONGO_URL, { maxPoolSize: CONCURRENCY + 5 });
await mongo.connect();
const db = mongo.db('flashsale');
const col = db.collection('orders');

if (mode === 'correctness') {
  const SLOTS = 1000, ATTEMPTS = 20000;
  for (const [name, setup, claim, count] of [
    ['postgres', () => pgSetup(pool, SLOTS), (u) => pgClaim(pool, u), () => pgCount(pool)],
    ['mongodb', () => mongoSetup(db, SLOTS), (u) => mongoClaim(col, u), () => mongoCount(col)],
  ]) {
    await setup();
    let ok = 0, n = 0;
    const inflight = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      inflight.push(claim(`${name}-u${n++}`).then((g) => { if (g) ok++; }));
      if (inflight.length >= 200) { await Promise.all(inflight.splice(0)); }
    }
    await Promise.all(inflight);
    const c = await count();
    const pass = ok === SLOTS && c.filled === SLOTS && c.users === SLOTS;
    console.log(`${name.padEnd(9)} claims_reported=${String(ok).padStart(5)} filled=${String(c.filled).padStart(5)} distinct_users=${String(c.users).padStart(5)}  ${pass ? 'PASS' : 'FAIL'}`);
  }
} else {
  const SLOTS = 400000;
  console.log(`concurrency=${CONCURRENCY} duration=${DURATION_MS}ms slots=${SLOTS}\n`);
  await pgSetup(pool, SLOTS);
  const p = await drive('pg', (u) => pgClaim(pool, u), DURATION_MS, CONCURRENCY);
  console.log(`postgres  ${String(p.perSec).padStart(6)} claims/s   p50 ${String(p.p50).padStart(6)} ms   p99 ${String(p.p99).padStart(7)} ms`);

  await mongoSetup(db, SLOTS);
  const m = await drive('mg', (u) => mongoClaim(col, u), DURATION_MS, CONCURRENCY);
  console.log(`mongodb   ${String(m.perSec).padStart(6)} claims/s   p50 ${String(m.p50).padStart(6)} ms   p99 ${String(m.p99).padStart(7)} ms`);
}

await pool.end();
await mongo.close();
