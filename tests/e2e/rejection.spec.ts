import type { Page } from '@playwright/test';

import { HELD, expect, expectConnected, seedSale, test, ui, uniqueUser } from './fixtures.js';

/** Every way a purchase can be refused ends in a message, never a stack trace. */

test('before the sale opens, Buy is disabled and the page says when it opens', async ({
  request,
  buyer,
}) => {
  await seedSale(request, { startsInMs: 3_600_000 });
  const screen = ui(await buyer(uniqueUser('early')));

  await expect(screen.sale).toHaveAttribute('data-status', 'upcoming');
  await expect(screen.sale).toContainText('Opens in');
  await expect(screen.buy).toBeDisabled();
});

test('after the sale ends, Buy is disabled and the page says so', async ({ request, buyer }) => {
  await seedSale(request, { startsInMs: -2 * 3_600_000, durationMs: 3_600_000 });
  const screen = ui(await buyer(uniqueUser('late')));

  await expect(screen.sale).toHaveAttribute('data-status', 'ended');
  await expect(screen.sale).toContainText('This sale has ended.');
  await expect(screen.buy).toBeDisabled();
});

test('someone who already holds an order sees it, not a Buy button', async ({ request, buyer }) => {
  await seedSale(request);
  const userId = uniqueUser('holder');

  const first = await buyer(userId);
  await expectConnected(first);
  await ui(first).buy.click();
  await expect(ui(first).status).toHaveText(HELD);

  // The same person in another browser.
  const second = await buyer(userId);
  await expect(ui(second).status).toHaveText(HELD);
  await expect(ui(second).buy).toBeDisabled();
});

/**
 * Responses the server gives under pressure, substituted at the network so the
 * UI's handling is tested deterministically. Producing a real 503 means
 * saturating the queue, which is the stress suite's job (docs/PLAN.md §11).
 */
async function refuseWith(page: Page, status: number, error: string): Promise<void> {
  await page.route('**/api/orders', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status, json: { error } })
      : route.continue(),
  );
}

for (const [status, error, message] of [
  [503, 'busy', 'Too many people at once. Try again in a moment.'],
  [429, 'rate_limited', 'You’re going too fast. Wait a moment before trying again.'],
] as const) {
  test(`a ${status} says what happened, and allows another try`, async ({ request, buyer }) => {
    await seedSale(request);
    const page = await buyer(uniqueUser(`refused${status}`));
    await refuseWith(page, status, error);
    await expectConnected(page);

    await ui(page).buy.click();

    await expect(ui(page).status).toHaveText(message);
    await expect(ui(page).buy).toBeEnabled();
  });
}
