-- Strongest form: parallel workers AND batching. Locks 100 free slots with
-- SKIP LOCKED, then assigns 100 users to them positionally.
WITH picked AS (
  SELECT id FROM orders
  WHERE sale_id = 'flash' AND user_id IS NULL
  ORDER BY id LIMIT 20
  FOR UPDATE SKIP LOCKED
),
numbered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM picked
),
input AS (
  SELECT 'u' || nextval('user_seq') AS user_id, g AS ord
  FROM generate_series(1, 20) g
)
UPDATE orders o
SET user_id = i.user_id, created_at = now()
FROM numbered n JOIN input i ON i.ord = n.rn
WHERE o.id = n.id
RETURNING o.id;
