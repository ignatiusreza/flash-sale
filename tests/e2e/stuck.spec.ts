import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import {
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

async function identify(page: Page, userId: string): Promise<void> {
  const screen = ui(page);
  await screen.name.fill(userId);
  await screen.name.blur();
}

test('a rejection that never arrives still settles once the sale sells out', async ({
  page,
  request,
}) => {
  await seedSale(request, { stock: 1 });
  await acceptWithoutQueueing(page);
  await page.goto('/');
  await identify(page, uniqueUser('lost-rejection'));
  await expectConnected(page);

  const screen = ui(page);
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
