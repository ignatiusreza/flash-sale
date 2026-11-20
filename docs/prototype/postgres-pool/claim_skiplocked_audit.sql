-- The correct form: concurrent claimers skip rows another transaction already
-- holds and take the next free slot, so they never queue behind each other.
WITH upd AS (
  UPDATE orders
  SET user_id = 'u' || nextval('user_seq'), created_at = now()
  WHERE id = (
    SELECT id FROM orders
    WHERE sale_id = 'flash' AND user_id IS NULL
    ORDER BY id LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, user_id
)
INSERT INTO claim_log (order_id, user_id) SELECT id, user_id FROM upd;
