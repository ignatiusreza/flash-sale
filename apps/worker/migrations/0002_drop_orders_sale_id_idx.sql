-- Redundant with orders_one_per_user, whose leading column is sale_id, and
-- harmful: on statistics taken before a sale fills, the planner picks it for
-- the worker's existing-orders lookup and scans every order in the sale rather
-- than probing (sale_id, user_id). It also cost an index write per order.

DROP INDEX orders_sale_id_idx;
