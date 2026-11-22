import { useState } from 'react';

import { isBusy, isTerminal, type PurchaseState } from './purchase-state.js';
import { PurchaseMessage } from './PurchaseMessage.js';

interface PurchaseFormProps {
  readonly userId: string;
  readonly onIdentify: (userId: string) => void;
  readonly purchaseState: PurchaseState;
  readonly canPurchase: boolean;
  readonly onPurchase: () => Promise<void>;
}

/**
 * The name field, the Buy button and the outcome.
 *
 * The name is committed on blur rather than per keystroke: every change of
 * identity reconnects the socket and re-runs the order lookup.
 */
export function PurchaseForm({
  userId,
  onIdentify,
  purchaseState,
  canPurchase,
  onPurchase,
}: PurchaseFormProps) {
  const [draft, setDraft] = useState(userId);

  return (
    <section className="buy">
      <label htmlFor="userId">Your name</label>
      <input
        id="userId"
        data-testid="userId"
        value={draft}
        placeholder="e.g. alice"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onIdentify(draft.trim())}
        disabled={isTerminal(purchaseState)}
      />

      <button
        type="button"
        data-testid="buy"
        onClick={() => {
          onIdentify(draft.trim());
          void onPurchase();
        }}
        // Disabled while in flight so a double click cannot send a second
        // attempt. The server would absorb it — one per user — but the user
        // should not be able to produce one in the first place.
        disabled={!canPurchase}
      >
        {isBusy(purchaseState) ? 'Working…' : 'Buy now'}
      </button>

      <PurchaseMessage state={purchaseState} />
    </section>
  );
}
