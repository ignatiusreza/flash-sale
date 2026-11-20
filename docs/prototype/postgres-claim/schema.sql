DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS sales;
DROP SEQUENCE IF EXISTS user_seq;

CREATE TABLE sales (
  id          TEXT PRIMARY KEY,
  total_stock INTEGER NOT NULL CHECK (total_stock >= 0),
  remaining   INTEGER NOT NULL CHECK (remaining >= 0),
  start_at    TIMESTAMPTZ NOT NULL,
  end_at      TIMESTAMPTZ NOT NULL,
  CHECK (end_at > start_at)
);

CREATE TABLE orders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id    TEXT NOT NULL REFERENCES sales(id),
  user_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sale_id, user_id)
);
CREATE INDEX ON orders (sale_id);

CREATE SEQUENCE user_seq;

INSERT INTO sales VALUES
  ('flash', 100000000, 100000000, now() - interval '1 min', now() + interval '1 day');
