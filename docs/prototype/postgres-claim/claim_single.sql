-- One purchase claim per transaction: the naive serial worker.
BEGIN;
UPDATE sales SET remaining = remaining - 1 WHERE id = 'flash' AND remaining > 0;
INSERT INTO orders (sale_id, user_id)
VALUES ('flash', 'u' || nextval('user_seq'))
ON CONFLICT (sale_id, user_id) DO NOTHING;
END;
