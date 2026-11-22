/**
 * Whether a claim failed because of an attempt's own data — Postgres SQLSTATE
 * class 22, "data exception": a NUL byte in a user id, a value too long, text
 * that will not convert. Retrying never helps, so the consumer isolates the
 * attempt and dead-letters it rather than holding every purchase behind it
 * (issue #17).
 *
 * Deliberately not class 23, integrity violations. The claim is written never
 * to trip `CHECK` or `UNIQUE`, so one firing is a bug in it, not in an
 * attempt; isolating would dead-letter every attempt in turn, where retrying
 * in place stops the sale visibly and loses nothing. Anything unrecognised —
 * a lost connection, a database that is down — is likewise retried in place.
 */
export function isBadAttemptData(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('22');
}
