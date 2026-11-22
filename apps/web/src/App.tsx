import { canPurchase } from './sale/purchase-state.js';
import { PurchaseForm } from './sale/PurchaseForm.js';
import { SaleStatus } from './sale/SaleStatus.js';
import { useIdentity } from './sale/useIdentity.js';
import { usePurchase } from './sale/usePurchase.js';
import { useSale } from './sale/useSale.js';
import { Viewers } from './sale/Viewers.js';

export function App() {
  const { userId, setUserId } = useIdentity();
  const { sale, offsetMs, viewers, connected, lastResult } = useSale(userId || undefined);
  const { purchaseState, purchase } = usePurchase(userId, lastResult);

  return (
    <main>
      <header>
        <h1>Flash Sale</h1>
        <Viewers count={viewers} reconnecting={Boolean(userId) && !connected} />
      </header>

      <SaleStatus sale={sale} offsetMs={offsetMs} />

      <PurchaseForm
        userId={userId}
        onIdentify={setUserId}
        purchaseState={purchaseState}
        canPurchase={canPurchase(purchaseState, userId, sale)}
        onPurchase={purchase}
      />
    </main>
  );
}
