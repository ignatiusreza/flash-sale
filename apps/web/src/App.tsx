import { useCallback, useEffect, useRef, useState } from 'react';

import { formatCountdown, formatLocal } from './sale/clock.js';
import {
  applyResponse,
  applyResult,
  idle,
  isBusy,
  isTerminal,
  type PurchaseState,
} from './sale/purchase-state.js';
import { useCountdown } from './sale/useCountdown.js';
import { useIdentity } from './sale/useIdentity.js';
import { useSale } from './sale/useSale.js';

function Message({ state }: { state: PurchaseState }) {
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

export function App() {
  const { userId, setUserId } = useIdentity();
  const [draft, setDraft] = useState(userId);
  const { sale, offsetMs, viewers, connected, lastResult } = useSale(userId || undefined);
  const [purchase, setPurchase] = useState<PurchaseState>(idle);
  const attemptRef = useRef<string | undefined>(undefined);

  // The socket may report an order this tab never asked for — another tab, or
  // an earlier visit. Folding it in is what keeps tabs agreeing.
  useEffect(() => {
    if (!lastResult) return;
    setPurchase((current) => applyResult(current, lastResult, attemptRef.current));
  }, [lastResult]);

  // On arrival, ask whether this user already holds an order. This is the
  // reconnect source of truth: without it a returning visitor sees a Buy
  // button for something they already own.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    void fetch(`/api/purchase/${encodeURIComponent(userId)}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { status?: string; orderId?: string } | undefined) => {
        if (cancelled || body?.status !== 'confirmed' || !body.orderId) return;
        setPurchase({ status: 'held', orderId: body.orderId });
      })
      .catch(() => {
        /* the socket will tell us if anything changes */
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const buy = useCallback(async () => {
    setPurchase({ status: 'submitting' });
    try {
      const response = await fetch('/api/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      const next = applyResponse(response.status, body);
      attemptRef.current = next.status === 'queued' ? next.attemptId : undefined;
      setPurchase(next);
    } catch {
      setPurchase({ status: 'failed', message: 'Could not reach the server.' });
    }
  }, [userId]);

  const status = sale?.status;
  const countdownTarget = status === 'upcoming' ? sale?.startAt : sale?.endAt;
  const msLeft = useCountdown(countdownTarget, offsetMs);

  const canBuy =
    Boolean(userId) &&
    status === 'active' &&
    sale?.availability !== 'sold_out' &&
    !isBusy(purchase) &&
    !isTerminal(purchase);

  return (
    <main>
      <header>
        <h1>Flash Sale</h1>
        <p className="viewers" data-testid="viewers">
          {viewers === 1 ? '1 person here' : `${viewers} people here`}
          {!connected && userId && <span className="warn"> · reconnecting…</span>}
        </p>
      </header>

      {!sale && <p data-testid="sale">Loading the sale…</p>}

      {sale && (
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
      )}

      <section className="buy">
        <label htmlFor="userId">Your name</label>
        <input
          id="userId"
          data-testid="userId"
          value={draft}
          placeholder="e.g. alice"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setUserId(draft.trim())}
          disabled={isTerminal(purchase)}
        />

        <button
          type="button"
          data-testid="buy"
          onClick={() => {
            setUserId(draft.trim());
            void buy();
          }}
          // Disabled while in flight so a double click cannot send a second
          // attempt. The server would absorb it — one per user — but the user
          // should not be able to produce one in the first place.
          disabled={!canBuy}
        >
          {isBusy(purchase) ? 'Working…' : 'Buy now'}
        </button>

        <Message state={purchase} />
      </section>
    </main>
  );
}
