import type { SaleState } from '@flash-sale/core';

/**
 * Phase 0 placeholder. The real page — userId entry, buy button, queued state,
 * terminal states, viewer count — lands in phase 5 of docs/PLAN.md.
 */
export function App({ sale }: { sale?: SaleState }) {
  return (
    <main>
      <h1>Flash Sale</h1>
      <p>{sale ? `Sale is ${sale.status}.` : 'Scaffold only — no sale wired up yet.'}</p>
    </main>
  );
}
