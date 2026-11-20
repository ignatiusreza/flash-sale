-- The order row is only written if the UPDATE actually claimed a unit.
-- One statement, so the claim and the order can never diverge.
WITH claimed AS (
  UPDATE sales SET remaining = remaining - 1
  WHERE id = 'flash' AND remaining > 0
  RETURNING id
)
INSERT INTO orders (sale_id, user_id)
SELECT 'flash', 'u' || nextval('user_seq') FROM claimed
ON CONFLICT (sale_id, user_id) DO NOTHING;
