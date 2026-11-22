/** How many people are looking, and whether our own link to them has dropped. */
export function Viewers({ count, reconnecting }: { count: number; reconnecting: boolean }) {
  return (
    <p className="viewers" data-testid="viewers">
      {count === 1 ? '1 person here' : `${count} people here`}
      {reconnecting && <span className="warn"> · reconnecting…</span>}
    </p>
  );
}
