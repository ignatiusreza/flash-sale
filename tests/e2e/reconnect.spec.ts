import type { WebSocketRoute } from '@playwright/test';

import {
  HELD,
  QUEUED,
  expect,
  expectConnected,
  seedSale,
  test,
  ui,
  uniqueUser,
} from './fixtures.js';

/**
 * The resilience claim of docs/PLAN.md §5: a dropped socket is cosmetic. The
 * result of a purchase is lost in flight, the connection drops, and on
 * reconnect the page re-syncs through `GET /api/orders?userId=` and lands on
 * the right terminal state anyway.
 */
test('a result lost to a dropped socket is recovered on reconnect', async ({
  page,
  context,
  request,
}) => {
  await seedSale(request, { stock: 5 });
  const userId = uniqueUser('reconnect');

  const connections: WebSocketRoute[] = [];
  // Until the connection is severed, no result is delivered: it is lost in
  // flight. Every connection before then, since the page connects anonymously
  // first and again once named.
  let losingResults = true;
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const losing = losingResults;
    connections.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (losing && typeof message === 'string' && message.startsWith('42["purchase:result"')) {
        return;
      }
      ws.send(message);
    });
  });

  await page.goto('/');
  const screen = ui(page);
  await screen.name.fill(userId);
  await screen.name.blur();
  await expectConnected(page);

  await screen.buy.click();
  await expect(screen.status).toHaveText(QUEUED);

  // The order exists; only its delivery was lost.
  await expect
    .poll(async () => (await (await request.get(`/api/orders?userId=${userId}`)).json()).length)
    .toBe(1);
  await expect(screen.status).toHaveText(QUEUED);

  const resync = page.waitForRequest(
    (r) => r.method() === 'GET' && r.url().includes(`/api/orders?userId=${userId}`),
  );
  const severed = connections.length;
  losingResults = false;
  await context.setOffline(true);
  // Offline emulation does not reliably sever an open WebSocket, so drop it too.
  await connections.at(-1)?.close();
  await expect(screen.viewers).toContainText('reconnecting');

  await context.setOffline(false);
  await resync;
  await expect(screen.status).toHaveText(HELD);
  expect(connections.length).toBeGreaterThan(severed);
});
