import { HELD, expect, expectConnected, seedSale, test, ui, uniqueUser } from './fixtures.js';

/**
 * The button disables while an attempt is in flight. The server would absorb a
 * second attempt — one order per user — but the page should never send one.
 */
test('a double click sends exactly one attempt', async ({ request, buyer }) => {
  await seedSale(request);
  const page = await buyer(uniqueUser('double'));
  await expectConnected(page);

  const attempts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/orders')) attempts.push(r.url());
  });

  await ui(page).buy.dblclick();

  await expect(ui(page).status).toHaveText(HELD);
  expect(attempts).toHaveLength(1);
});
