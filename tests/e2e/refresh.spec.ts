import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

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
 * A refresh while a purchase waits in the queue. The queue holds requests, not
 * anything a page can look up, so a reloaded page used to offer Buy again
 * mid-purchase and never explain a later rejection.
 *
 * "Waiting in the queue" is made deterministic by answering the page's POST
 * with a 202 for an attempt that never reaches the queue; the spec then
 * decides how it ends.
 */
async function buyIntoAQueueThatNeverMoves(page: Page, userId: string): Promise<void> {
  await page.route('**/api/orders', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { status: 'queued', attemptId: randomUUID() } })
      : route.continue(),
  );
  await page.goto('/');
  await ui(page).name.fill(userId);
  await ui(page).name.blur();
  await expectConnected(page);

  await ui(page).buy.click();
  await expect(ui(page).status).toHaveText(QUEUED);

  await page.reload();
  await expectConnected(page);
  // The point: still the purchase in progress, not a fresh Buy button.
  await expect(ui(page).status).toHaveText(QUEUED);
  await expect(ui(page).buy).toBeDisabled();
}

test('a refresh mid-purchase keeps it, and the order still arrives', async ({ page, request }) => {
  await seedSale(request);
  const userId = uniqueUser('refresh-held');
  await buyIntoAQueueThatNeverMoves(page, userId);

  // The purchase completes: an order for this user, announced over the socket.
  expect((await request.post('/api/orders', { data: { userId } })).status()).toBe(202);

  await expect(ui(page).status).toHaveText(HELD);
});

test('a refresh mid-purchase, then a sellout, says it failed', async ({ page, request }) => {
  await seedSale(request);
  await buyIntoAQueueThatNeverMoves(page, uniqueUser('refresh-sold-out'));

  // Stock is gone while the attempt waits: it can no longer succeed, and this
  // page will never see a result for it.
  await seedSale(request, { stock: 0 });

  await expect(ui(page).status).toHaveText(SOLD_OUT);
  await expect(ui(page).buy).toBeDisabled();
});

test('an attempt pending for too long is let go', async ({ page, request }) => {
  await seedSale(request);
  const userId = uniqueUser('refresh-stale');
  // Left by a page closed three minutes ago, past the two-minute limit.
  await page.addInitScript(
    ({ id, pending }) => {
      localStorage.setItem('flash-sale:userId', id);
      localStorage.setItem(`flash-sale:pending:${id}`, pending);
    },
    {
      id: userId,
      pending: JSON.stringify({ attemptId: randomUUID(), since: Date.now() - 3 * 60_000 }),
    },
  );

  await page.goto('/');
  await expectConnected(page);

  await expect(ui(page).buy).toBeEnabled();
  await expect(ui(page).status).toHaveCount(0);
});
