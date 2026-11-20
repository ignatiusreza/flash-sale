-- 100 purchase claims per transaction: the batching serial worker.
BEGIN;
UPDATE sales SET remaining = remaining - 100 WHERE id = 'flash' AND remaining >= 100;
INSERT INTO orders (sale_id, user_id)
SELECT 'flash', 'u' || nextval('user_seq') FROM generate_series(1, 100)
ON CONFLICT (sale_id, user_id) DO NOTHING;
END;
