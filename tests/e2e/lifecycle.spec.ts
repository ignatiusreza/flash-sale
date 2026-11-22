import { expect, seedSale, test, ui, uniqueUser } from './fixtures.js';

/** The sale's whole life, pushed over the socket and watched without a reload. */
test('upcoming, then active, then ended — live', async ({ request, buyer }) => {
  await seedSale(request, { startsInMs: 4_000, durationMs: 4_000 });
  const page = await buyer(uniqueUser('lifecycle'));
  const screen = ui(page);
  // Cleared by any navigation, so its survival proves nothing reloaded.
  await page.evaluate(() => Object.assign(globalThis, { stillTheSamePage: true }));

  await expect(screen.sale).toHaveAttribute('data-status', 'upcoming');
  await expect(screen.sale).toContainText('Opens in');
  await expect(screen.buy).toBeDisabled();

  await expect(screen.sale).toHaveAttribute('data-status', 'active', { timeout: 10_000 });
  await expect(screen.sale).toContainText('Closes in');
  await expect(screen.buy).toBeEnabled();

  await expect(screen.sale).toHaveAttribute('data-status', 'ended', { timeout: 10_000 });
  await expect(screen.sale).toContainText('This sale has ended.');
  await expect(screen.buy).toBeDisabled();

  expect(await page.evaluate(() => 'stillTheSamePage' in globalThis)).toBe(true);
});

/**
 * Before typing a name, a visitor is still watching: the page must not sit on
 * "upcoming" until they do. It connects anonymously, and counts as here.
 */
test('a visitor who has not given a name still sees the sale open, live', async ({
  page,
  request,
}) => {
  await seedSale(request, { startsInMs: 3_000 });
  await page.goto('/');
  const screen = ui(page);
  await expect(screen.name).toHaveValue('');

  await expect(screen.sale).toHaveAttribute('data-status', 'upcoming');
  await expect(screen.viewers).toHaveText(/^[1-9]\d* (person|people) here$/);
  await expect(screen.sale).toHaveAttribute('data-status', 'active', { timeout: 10_000 });
});
