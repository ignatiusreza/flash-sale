import { randomUUID } from 'node:crypto';

import type { Page, WebSocketRoute } from '@playwright/test';

import {
  HELD,
  QUEUED,
  SOLD_OUT,
  expect,
  expectConnected,
  seedSale,
  test,
  ui,
  uniqueUser,
} from './fixtures.js';

/**
 * Every way a purchase could sit on "Securing your item…" for good (#11). Each
 * one is a result the page never hears, so each ends in a state it reaches
 * without that result.
 */

/** Answers this page's POST with a 202 for an attempt the server never sees, so no result can come. */
async function acceptWithoutQueueing(page: Page): Promise<void> {
  await page.route('**/api/orders', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'queued', attemptId: randomUUID() }),
        })
      : route.fallback(),
  );
}

const ENDED = 'The sale has ended.';

async function identify(page: Page, userId: string): Promise<void> {
  const screen = ui(page);
  await screen.name.fill(userId);
  await screen.name.blur();
}

test('a rejection that never arrives still settles once the sale sells out', async ({
  page,
  request,
}) => {
  // Opening shortly after seeding: see the last test in this file.
  await seedSale(request, { stock: 1, startsInMs: 1_500 });
  await acceptWithoutQueueing(page);
  await page.goto('/');
  await identify(page, uniqueUser('lost-rejection'));
  await expectConnected(page);

  const screen = ui(page);
  await expect(screen.buy).toBeEnabled({ timeout: 5_000 });
  await screen.buy.click();
  await expect(screen.status).toHaveText(QUEUED);

  // Someone else takes the last unit; this page's own result never comes.
  const winner = await request.post('/api/orders', {
    data: { userId: uniqueUser('winner') },
    headers: { 'x-forwarded-for': '10.11.0.1' },
  });
  expect(winner.status()).toBe(202);

  await expect(screen.status).toHaveText(SOLD_OUT);
});

test('Buy waits for the socket, since a result decided before it connects goes nowhere', async ({
  page,
  request,
}) => {
  await seedSale(request);
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.routeWebSocket(/\/socket\.io\//, async (ws) => {
    await released;
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });

  await page.goto('/');
  await identify(page, uniqueUser('early-click'));
  const screen = ui(page);
  await expect(screen.sale).toHaveAttribute('data-status', 'active');
  await expect(screen.buy).toBeDisabled();

  release();
  await expectConnected(page);
  await expect(screen.buy).toBeEnabled();
});

test('renaming while a purchase is queued neither carries it over nor loses it', async ({
  page,
  request,
}) => {
  await seedSale(request);
  await acceptWithoutQueueing(page);
  const first = uniqueUser('rename-a');
  const second = uniqueUser('rename-b');
  const pendingOf = (userId: string) =>
    page.evaluate((id) => localStorage.getItem(`flash-sale:pending:${id}`), userId);

  await page.goto('/');
  await identify(page, first);
  await expectConnected(page);
  const screen = ui(page);
  await screen.buy.click();
  await expect(screen.status).toHaveText(QUEUED);

  await identify(page, second);
  await expectConnected(page);
  await expect(screen.status).toHaveCount(0);
  await expect(screen.buy).toBeEnabled();
  expect(await pendingOf(second)).toBeNull();

  // The first name's attempt is still theirs to come back to.
  await identify(page, first);
  await expect(screen.status).toHaveText(QUEUED);
});

test('a rejection that never arrives still settles once the sale ends', async ({
  page,
  request,
}) => {
  await seedSale(request, { durationMs: 4_000 });
  await acceptWithoutQueueing(page);
  await page.goto('/');
  await identify(page, uniqueUser('lost-at-end'));
  await expectConnected(page);

  const screen = ui(page);
  await screen.buy.click();
  await expect(screen.status).toHaveText(QUEUED);

  await expect(screen.status).toHaveText(ENDED, { timeout: 10_000 });
});

test('a sellout while the socket is down settles a waiting attempt on reconnect', async ({
  page,
  request,
}) => {
  await seedSale(request, { stock: 1 });
  await acceptWithoutQueueing(page);

  // Connections wait at this gate while it is closed, so the sale sells out
  // while the page has no socket at all.
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  const connections: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/socket\.io\//, async (ws) => {
    connections.push(ws);
    await gate;
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });

  await page.goto('/');
  await identify(page, uniqueUser('lost-offline'));
  await expectConnected(page);
  const screen = ui(page);
  await screen.buy.click();
  await expect(screen.status).toHaveText(QUEUED);

  gate = new Promise((resolve) => {
    open = resolve;
  });
  await connections.at(-1)?.close();
  await expect(screen.viewers).toContainText('reconnecting');

  const winner = await request.post('/api/orders', {
    data: { userId: uniqueUser('winner') },
    headers: { 'x-forwarded-for': '10.11.0.2' },
  });
  expect(winner.status()).toBe(202);
  await expect
    .poll(async () => (await (await request.get('/api/sale')).json()).availability)
    .toBe('sold_out');

  open();
  await expect(screen.status).toHaveText(SOLD_OUT);
});

test('a winner whose result is lost is never told sold out because a lookup failed', async ({
  page,
  request,
}) => {
  // The last unit is theirs, its result never arrives, and the sale then
  // reads as sold out: the page must look the order up — and a lookup that
  // was rate limited is not "no order" (issue #17).
  //
  // Opening shortly after seeding, so the server has pushed this sale as open
  // before it sells out: status is pushed on a change from the last push, and
  // a reseed that sells out within a tick looks like no change at all.
  await seedSale(request, { stock: 1, startsInMs: 1_500 });
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === 'string' && message.startsWith('42["purchase:result"')) return;
      ws.send(message);
    });
  });
  let limited = 0;
  let armed = false;
  await page.route('**/api/orders?*', (route) => {
    if (armed && limited < 2) {
      limited++;
      return route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        contentType: 'application/json',
        body: JSON.stringify({ error: 'rate_limited' }),
      });
    }
    return route.fallback();
  });

  const userId = uniqueUser('lucky');
  await page.goto('/');
  await identify(page, userId);
  await expectConnected(page);
  const screen = ui(page);
  await expect(screen.buy).toBeEnabled({ timeout: 5_000 });
  armed = true;
  await screen.buy.click();
  await expect(screen.status).toHaveText(QUEUED);

  await expect
    .poll(async () => (await (await request.get(`/api/orders?userId=${userId}`)).json()).length)
    .toBe(1);
  await expect(screen.status).toHaveText(HELD, { timeout: 10_000 });
  expect(limited).toBe(2);
});
