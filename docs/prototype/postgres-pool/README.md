# Spike: stock as a pool of claimable rows

An alternative inventory model. Instead of one `sales.remaining` counter that every buyer must decrement, stock is **pre-warmed as N order rows with `user_id IS NULL`**, and a purchase claims one of them:

```sql
UPDATE orders SET user_id = $1 WHERE id = (
  SELECT id FROM orders WHERE user_id IS NULL LIMIT 1
) RETURNING id;
```

The appeal is obvious and real: N writers now contend on N different rows instead of one, so the lock convoy measured in [`../postgres-claim/`](../postgres-claim/) (7% more throughput for 46× the latency) should disappear entirely.

It does. But the naive form above is also **catastrophically, silently wrong**, and the throughput story has a twist.

## Running it

```sh
initdb -D ./pgdata -U postgres --auth=trust
pg_ctl -D ./pgdata -o "-p 5499" -l pg.log start
psql -p 5499 -U postgres -f pool_schema.sql

# correctness: 20 000 attempts against a pool of 1000
psql -p 5499 -U postgres -c "INSERT INTO orders (sale_id) SELECT 'flash' FROM generate_series(1,1000);"
pgbench -p 5499 -U postgres -n -c 50 -j 4 -t 400 -f claim_naive_audit.sql postgres
psql -p 5499 -U postgres -c "SELECT count(*) AS claims_reported, count(DISTINCT order_id) AS slots FROM claim_log;"
#   -> claims_reported MUST equal slots. It does not.

psql -p 5499 -U postgres -c "TRUNCATE claim_log;" -c "UPDATE orders SET user_id=NULL;"
pgbench -p 5499 -U postgres -n -c 50 -j 4 -t 400 -f claim_skiplocked_audit.sql postgres
psql -p 5499 -U postgres -c "SELECT count(*) AS claims_reported, count(DISTINCT order_id) AS slots FROM claim_log;"

# throughput: prewarm a large pool first
psql -p 5499 -U postgres -c "TRUNCATE orders;" -c "INSERT INTO orders (sale_id) SELECT 'flash' FROM generate_series(1,2000000);" -c "VACUUM ANALYZE orders;"
for c in 1 10 50; do pgbench -p 5499 -U postgres -n -c $c -j 4 -T 10 -f claim_pool_batch.sql postgres; done

pg_ctl -D ./pgdata stop
```

## The silent oversell

**20 000 attempts, 50 connections, pool of exactly 1000 slots:**

| Form | Claims reported successful | Slots that exist | Verdict |
|---|---|---|---|
| `UPDATE ... WHERE id = (SELECT … LIMIT 1)` | **9 482** | 1 000 | **9.5× oversell** |
| `… LIMIT 1 FOR UPDATE SKIP LOCKED` | 1 000 | 1 000 | correct |
| Batched + `SKIP LOCKED` | 1 000 | 1 000 | correct |

The naive form is a lost update under `READ COMMITTED`. Several transactions evaluate the subquery and all get the same `id`. One wins the row lock and writes its `user_id`. The others block — and when the lock releases they re-evaluate only the outer predicate, `id = X`, which is still true, so each in turn **overwrites the previous claimant**. 8 482 users were told they had secured an item that someone else now holds.

What makes this genuinely dangerous is how well it hides:

- `pgbench` reported **0 failed transactions**. Every statement "succeeded".
- The final table state is immaculate: 1 000 filled slots, 0 free, 1 000 distinct users.
- **An invariant check on final state passes.** `count(orders WHERE user_id IS NOT NULL) == 1000` is true. The oversell is only visible in the audit log of what each statement *claimed to have done* — which is why `claim_log` exists in this spike, and why plan §11's oversell test must assert on responses returned to clients, not just on rows in the database.

Adding `AND user_id IS NULL` to the outer `WHERE` also fixes correctness, but turns every lost race into a spurious "sold out" while stock remains. `SKIP LOCKED` is the right primitive: a blocked claimant moves to the next free slot instead of queueing for a slot that is about to be taken.

## Throughput

PostgreSQL 18.6, default config (`synchronous_commit=on`), 12-core machine, 1–2M slot pool with a partial index `ON orders (id) WHERE user_id IS NULL`.

| Design | c=1 | c=10 | c=50 |
|---|---|---|---|
| Pool, 1 claim per transaction | 765/s | 1 716/s | 5 514/s |
| Pool, **100 claims per transaction** | 35 805/s | **61 132/s** | 30 791/s |
| Pool, 20 claims per transaction | — | — | 29 137/s |
| *Counter row, serial batched (prior spike)* | *37 000–41 500/s* | *n/a* | *n/a* |

Mean latency: 1.3 ms / 5.8 ms / 9.1 ms unbatched; 2.8 ms / 16.4 ms / 162 ms at batch 100; 34 ms for batch 20 at c=50.

**Parallelism alone is a poor substitute for batching.** Un-batched parallel claiming manages only 5 514/s even at 50 connections — roughly 7× *worse* than a single serial worker batching 100 claims per transaction. Each claim pays its own fsync, and spreading fsyncs across connections amortises them far less effectively than putting 100 claims behind one commit. Group commit helps, which is why it scales at all, but not nearly enough.

**Batching plus parallelism is the best result measured: 61 132 claims/s at concurrency 10** — about 1.5× the serial batched counter design, and the only configuration here that beats it.

**It peaks and then degrades.** At c=50 throughput halves and latency goes to 162 ms. The machine has 12 cores, so c=10 sits right at the core count and c=50 oversubscribes 4×. Dropping the batch to 20 at c=50 recovers latency (34 ms) but not throughput (~29k), which points at CPU saturation rather than an algorithmic cliff in `SKIP LOCKED`. The practical reading: **concurrency should be tuned to roughly the core count, not raised indefinitely** — and whatever ships needs the batch-size and concurrency knobs exposed, because the optimum is hardware-dependent and the penalty for overshooting is severe.

## Costs this model carries

Not all of them show up in a benchmark:

- **Duplicate claims abort the transaction.** The counter design used `INSERT … ON CONFLICT DO NOTHING`, which skips a duplicate buyer and carries on. `ON CONFLICT` is INSERT-only, so here a repeat buyer trips `UNIQUE (sale_id, user_id)` and **kills the whole batch of 100**. Workable — the worker's in-memory buyer set dedupes first — but the database backstop degrades from "skip that row" to "abort everything", which is a real loss of robustness.
- **Arrival order is gone.** The serial batched worker grants in queue order, which is how plan §4.1 implements the brief's fairness requirement. Parallel claimants race, so the winners are decided by scheduling.
- **Stock changes become DDL-ish.** Restocking means inserting rows, reducing stock means deleting unclaimed ones, and the table carries a row per unsold unit. 1M slots is 91 MB. At realistic flash-sale sizes this is nothing, but it is no longer a one-field update.
- **The partial index is load-bearing.** Without `ON orders (id) WHERE user_id IS NULL`, "find the next free slot" degrades as the pool drains, because the scan must step over an ever-growing prefix of claimed rows. With it, claimed rows leave the index entirely.

## The architectural consequence

The queue in plan §3 exists primarily because the counter row could not take concurrent writes. This model removes that row — and with it, the main justification for serializing upstream.

That reopens a simpler design the plan had ruled out: **API instances claiming directly from the pool, no RabbitMQ, no worker, no WebSocket, and a synchronous HTTP response.** At 5 514 claims/s (c=50, 9 ms mean) it is well short of the batched architectures, but it is within reach of the 10k/s target on better hardware with a connection pooler, and it deletes most of the system.

Three live options, then:

| Architecture | Throughput | Response | Fairness | Components |
|---|---|---|---|---|
| Queue + serial batched worker + counter | 37–41k/s | async | FIFO | API, RabbitMQ, worker, PG |
| Queue + parallel batched workers + pool | **61k/s** | async | racy | API, RabbitMQ, workers, PG |
| **Direct API claim + pool** | 5.5k/s | **synchronous** | racy | API, PG |

The third is dramatically simpler and the brief says it values clarity and simplicity. Whether 5.5k/s is enough is the question that decides it.
