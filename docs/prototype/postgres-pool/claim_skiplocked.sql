-- Throughput probe: the SKIP LOCKED claim without the audit-log insert.
UPDATE orders
SET user_id = 'u' || nextval('user_seq'), created_at = now()
WHERE id = (
  SELECT id FROM orders
  WHERE sale_id = 'flash' AND user_id IS NULL
  ORDER BY id LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING id;
