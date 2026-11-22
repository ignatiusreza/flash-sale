/**
 * Countdown arithmetic against the server's clock rather than the browser's.
 *
 * A browser with the wrong *timezone* still has a correct instant, because the
 * OS holds UTC underneath — that only corrupts display. A browser with a wrong
 * *clock* has a wrong instant, and would show a countdown that is minutes out.
 * `serverTime` from `GET /api/sale` is what closes that (docs/PLAN.md §9.1).
 */

/** How far ahead of us the server is, in milliseconds. */
export function clockOffset(serverTime: string, now = Date.now()): number {
  return Date.parse(serverTime) - now;
}

/** Milliseconds until `target`, corrected for clock skew. Never negative. */
export function remainingMs(target: string, offsetMs: number, now = Date.now()): number {
  return Math.max(0, Date.parse(target) - (now + offsetMs));
}

/** `1:02:03` past an hour, `02:03` below it. Rounded down, so it never shows 0:00 early. */
export function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Formats an instant in the viewer's own timezone and locale, labelled with the
 * zone so nobody has to guess which one the sale opens in (§9.1). `timeZone`
 * is for tests; the page always uses the viewer's.
 *
 * Fields, not `dateStyle`/`timeStyle`: those cannot be combined with
 * `timeZoneName`, and the constructor throws — which, during render, blanked
 * the whole page for any sale not yet open.
 */
export function formatLocal(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}
