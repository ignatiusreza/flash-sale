import {
  HELD,
  SOLD_OUT,
  expect,
  expectConnected,
  seedSale,
  test,
  ui,
  uniqueUser,
} from './fixtures.js';

/**
 * Five people race for the last two units. This tests the UI's handling of
 * losing, not the oversell invariant — that is proven in integration and
 * stress, where 20 000 attempts cost nothing (docs/PLAN.md §11).
 */
test('racing buyers: two hold an order, the rest see sold out', async ({ request, buyer }) => {
  await seedSale(request, { stock: 2 });

  const pages = await Promise.all(
    Array.from({ length: 5 }, (_, i) => buyer(uniqueUser(`race${i}`))),
  );
  // The pages are independent, so each is checked alongside the others, and
  // labelled: every page has the same locators, so a failure would not
  // otherwise say which buyer it was.
  await Promise.all(
    pages.map(async (page, i) => {
      await expectConnected(page, `buyer ${i}`);
      await expect(ui(page).buy, `buyer ${i}`).toBeEnabled();
    }),
  );

  await Promise.all(pages.map((page) => ui(page).buy.click()));

  const settled = new RegExp(`${HELD.source}|^${SOLD_OUT}$`);
  await Promise.all(
    pages.map((page, i) => expect(ui(page).status, `buyer ${i}`).toHaveText(settled)),
  );

  const outcomes = await Promise.all(pages.map((page) => ui(page).status.textContent()));
  expect(outcomes.filter((text) => HELD.test(text ?? ''))).toHaveLength(2);
  expect(outcomes.filter((text) => text === SOLD_OUT)).toHaveLength(3);
});
