-- 100 claims per transaction via the guarded batch function (the real one).
SELECT * FROM claim_batch('flash',
  (SELECT array_agg('u' || nextval('user_seq')) FROM generate_series(1, 100)));
