-- Alternative inventory model: stock is pre-warmed as N claimable order rows
-- with user_id IS NULL, rather than a single counter row on `sales`.
DROP TABLE IF EXISTS claim_log;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS sales;
DROP SEQUENCE IF EXISTS user_seq;

CREATE TABLE sales (
  id       TEXT PRIMARY KEY,
  start_at TIMESTAMPTZ NOT NULL,
  end_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE orders (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id    TEXT NOT NULL REFERENCES sales(id),
  user_id    TEXT,                       -- NULL = unclaimed slot
  created_at TIMESTAMPTZ,
  UNIQUE (sale_id, user_id)              -- NULLs are distinct, so many free slots coexist
);

-- Claimed rows leave this index entirely, so "find the next free slot" stays
-- O(log n) instead of degrading as the sale drains.
CREATE INDEX orders_unclaimed ON orders (id) WHERE user_id IS NULL;

CREATE TABLE claim_log (
  seq      BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  user_id  TEXT NOT NULL
);

CREATE SEQUENCE user_seq;

INSERT INTO sales VALUES ('flash', now() - interval '1 min', now() + interval '1 day');
