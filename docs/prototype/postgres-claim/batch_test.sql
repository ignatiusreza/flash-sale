\set ON_ERROR_STOP on
\pset pager off

-- The batch claim. Decrements by the number of rows ACTUALLY inserted, which
-- is what makes a redelivered batch a no-op rather than a double decrement.
CREATE OR REPLACE FUNCTION claim_batch(p_sale text, p_users text[])
RETURNS TABLE (remaining integer, granted bigint)
LANGUAGE sql AS $$
  WITH input AS (
    SELECT user_id, ord
    FROM unnest(p_users) WITH ORDINALITY AS t(user_id, ord)
  ),
  locked AS (
    SELECT s.remaining FROM sales s WHERE s.id = p_sale FOR UPDATE
  ),
  candidate AS (
    SELECT i.user_id FROM input i, locked l WHERE i.ord <= l.remaining
  ),
  ins AS (
    INSERT INTO orders (sale_id, user_id)
    SELECT p_sale, c.user_id FROM candidate c
    ON CONFLICT (sale_id, user_id) DO NOTHING
    RETURNING user_id
  )
  UPDATE sales s SET remaining = s.remaining - (SELECT count(*) FROM ins)
  WHERE s.id = p_sale
  RETURNING s.remaining, (SELECT count(*) FROM ins);
$$;

\echo ''
\echo '=== A: batch of 100 against stock 1000 -> expect granted=100 remaining=900'
TRUNCATE orders;
UPDATE sales SET total_stock = 1000, remaining = 1000;
SELECT * FROM claim_batch('flash', (SELECT array_agg('u' || g) FROM generate_series(1,100) g));

\echo '=== B: batch of 100 against stock 5 -> expect granted=5 remaining=0 (partial)'
TRUNCATE orders;
UPDATE sales SET remaining = 5;
SELECT * FROM claim_batch('flash', (SELECT array_agg('b' || lpad(g::text,3,'0')) FROM generate_series(1,100) g));

\echo '=== B2: the first 5 by arrival order won (fairness)'
SELECT string_agg(user_id, ',' ORDER BY user_id) AS winners FROM orders;

\echo '=== C: REDELIVERY of the same batch -> expect granted=0 remaining=0 (idempotent)'
SELECT * FROM claim_batch('flash', (SELECT array_agg('b' || lpad(g::text,3,'0')) FROM generate_series(1,100) g));
SELECT count(*) AS orders_still FROM orders;

\echo '=== D: duplicate user inside one batch -> expect granted=1 remaining=9'
TRUNCATE orders;
UPDATE sales SET remaining = 10;
SELECT * FROM claim_batch('flash', ARRAY['dupe','dupe','dupe']);

\echo '=== E: batch against stock 0 -> expect granted=0 remaining=0'
UPDATE sales SET remaining = 0;
SELECT * FROM claim_batch('flash', ARRAY['z1','z2','z3']);

\echo '=== F: consistency across two batches straddling sellout'
TRUNCATE orders;
UPDATE sales SET total_stock = 50, remaining = 50;
SELECT * FROM claim_batch('flash', (SELECT array_agg('f' || g) FROM generate_series(1,30) g));
SELECT * FROM claim_batch('flash', (SELECT array_agg('g' || g) FROM generate_series(1,40) g));
SELECT (SELECT count(*) FROM orders) AS orders,
       (SELECT remaining FROM sales) AS remaining,
       (SELECT count(*) FROM orders) = (SELECT total_stock - remaining FROM sales) AS consistent;
