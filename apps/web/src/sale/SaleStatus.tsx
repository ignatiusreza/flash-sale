import { formatCountdown, formatLocal } from './clock.js';
import { useCountdown } from './useCountdown.js';
import type { SaleSnapshot } from './useSale.js';

/** Where the sale is in its window, counting down to the next change. */
export function SaleStatus({
  sale,
  offsetMs,
}: {
  sale: SaleSnapshot | undefined;
  offsetMs: number;
}) {
  // Before opening, count to the start; while open, to the end.
  const target = sale?.status === 'upcoming' ? sale.startAt : sale?.endAt;
  const msLeft = useCountdown(target, offsetMs);

  if (!sale) return <p data-testid="sale">Loading the sale…</p>;

  return (
    <section className="sale" data-testid="sale" data-status={sale.status}>
      {sale.status === 'upcoming' && (
        <p>
          Opens in <strong data-testid="countdown">{formatCountdown(msLeft)}</strong>
          <br />
          <small>{formatLocal(sale.startAt)}</small>
        </p>
      )}
      {sale.status === 'active' && (
        <p>
          {sale.availability === 'sold_out' ? (
            <strong>Sold out</strong>
          ) : (
            <>
              Closes in <strong data-testid="countdown">{formatCountdown(msLeft)}</strong>
              {sale.availability === 'low' && <em> · almost gone</em>}
            </>
          )}
        </p>
      )}
      {sale.status === 'ended' && <p>This sale has ended.</p>}
    </section>
  );
}
