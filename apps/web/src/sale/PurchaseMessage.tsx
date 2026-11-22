import type { PurchaseState } from './purchase-state.js';

/** One line telling the user where their purchase stands, or nothing. */
export function PurchaseMessage({ state }: { state: PurchaseState }) {
  switch (state.status) {
    case 'queued':
      // The honest representation of what the system is doing: the attempt is
      // durably queued and the outcome is on its way over the socket.
      return <p data-testid="status">Securing your item…</p>;
    case 'held':
      return (
        <p data-testid="status" className="good">
          It’s yours. Order <code>{state.orderId}</code>
        </p>
      );
    case 'rejected':
      return (
        <p data-testid="status" className="bad">
          {state.reason === 'sold_out' && 'Sold out — every unit is gone.'}
          {state.reason === 'not_started' && 'The sale hasn’t opened yet.'}
          {state.reason === 'ended' && 'The sale has ended.'}
        </p>
      );
    case 'busy':
      return (
        <p data-testid="status" className="bad">
          Too many people at once. Try again in a moment.
        </p>
      );
    case 'rateLimited':
      return (
        <p data-testid="status" className="bad">
          You’re going too fast. Wait a moment before trying again.
        </p>
      );
    case 'failed':
      return (
        <p data-testid="status" className="bad">
          {state.message}
        </p>
      );
    default:
      return null;
  }
}
