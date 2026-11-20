-- The form as described: UPDATE ... WHERE id = (SELECT ... user_id IS NULL LIMIT 1)
-- No SKIP LOCKED, no re-check of user_id in the outer WHERE.
-- claim_log records every claim the statement reported as successful.
WITH upd AS (
  UPDATE orders
  SET user_id = 'u' || nextval('user_seq'), created_at = now()
  WHERE id = (
    SELECT id FROM orders
    WHERE sale_id = 'flash' AND user_id IS NULL
    ORDER BY id LIMIT 1
  )
  RETURNING id, user_id
)
INSERT INTO claim_log (order_id, user_id) SELECT id, user_id FROM upd;
