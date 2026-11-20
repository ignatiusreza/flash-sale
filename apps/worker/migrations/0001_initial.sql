-- Initial schema. See docs/PLAN.md §9.
--
-- Both headline invariants are enforced here, independently of any application
-- code: CHECK (remaining >= 0) makes an oversell impossible to persist even if
-- the claim statement has a bug, and UNIQUE (sale_id, user_id) does the same
-- for one-item-per-user. If either ever trips, the fast path is wrong and the
-- transaction aborts rather than committing something untrue.
--
-- Every instant is TIMESTAMPTZ, never TIMESTAMP (§9.1).

CREATE TABLE sales (
  id          TEXT PRIMARY KEY,
  total_stock INTEGER NOT NULL CHECK (total_stock >= 0),
  remaining   INTEGER NOT NULL CHECK (remaining >= 0),
  start_at    TIMESTAMPTZ NOT NULL,
  end_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT sales_window_ordered CHECK (end_at > start_at),
  CONSTRAINT sales_remaining_within_stock CHECK (remaining <= total_stock)
);

CREATE TABLE orders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id    TEXT NOT NULL REFERENCES sales (id),
  user_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_one_per_user UNIQUE (sale_id, user_id)
);

CREATE INDEX orders_sale_id_idx ON orders (sale_id);
