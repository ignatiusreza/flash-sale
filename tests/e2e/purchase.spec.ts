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
 * The async flow end to end: click, 202, a visible queued state, then the
 * result over the socket. The queued state is the point — a synchronous
 * design would not have one — and it normally lasts milliseconds, so the
 * result is held back at the socket until the test has seen it.
 */
test('a purchase is queued first, then confirmed over the socket', async ({ page, request }) => {
  await seedSale(request, { stock: 5 });

  let release!: () => void;
  const resultHeld = new Promise<void>((resolve) => (release = resolve));
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage(async (message) => {
      if (typeof message === 'string' && message.startsWith('42["purchase:result"')) {
        await resultHeld;
      }
      ws.send(message);
    });
  });

  await page.goto('/');
  const screen = ui(page);
  await expect(screen.buy).toBeDisabled();

  await screen.name.fill(uniqueUser('purchase'));
  await screen.name.blur();
  await expectConnected(page);

  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/orders'),
  );
  await screen.buy.click();
  expect((await response).status()).toBe(202);

  await expect(screen.status).toHaveText(QUEUED);
  await expect(screen.buy).toBeDisabled();

  release();
  await expect(screen.status).toHaveText(HELD);
  await expect(screen.buy).toBeDisabled();
});
