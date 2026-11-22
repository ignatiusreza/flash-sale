import { useSocket } from './realtime/useSocket.js';
import { canPurchase } from './sale/purchase-state.js';
import { PurchaseForm } from './sale/PurchaseForm.js';
import { SaleStatus } from './sale/SaleStatus.js';
import { useIdentity } from './sale/useIdentity.js';
import { usePurchase } from './sale/usePurchase.js';
import { useSale } from './sale/useSale.js';
import { useViewers } from './sale/useViewers.js';
import { Viewers } from './sale/Viewers.js';

export function App() {
  const { userId, setUserId } = useIdentity();
  const { socket, connected } = useSocket(userId || undefined);
  const { sale, offsetMs } = useSale(socket);
  const viewers = useViewers(socket);
  const { purchaseState, purchase } = usePurchase(userId, socket, sale);

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
        canPurchase={canPurchase(purchaseState, userId, sale, connected)}
        onPurchase={purchase}
      />
    </main>
  );
}
