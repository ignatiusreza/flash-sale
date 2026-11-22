import { expect, seedSale, test, ui, uniqueUser } from './fixtures.js';

/**
 * docs/PLAN.md §9.1 separates two failures. A wrong *timezone* only corrupts
 * display, so the same instant must render as each viewer's own wall clock,
 * labelled. A wrong *clock* corrupts the instant itself, so the countdown is
 * anchored to the server's time and must survive a browser that is hours off.
 */
test('the opening time renders in each viewer’s own zone, labelled', async ({ request, buyer }) => {
  const sale = await seedSale(request, { startsInMs: 3 * 3_600_000, durationMs: 3_600_000 });
  // The page formats with exactly these options, in the browser's zone.
  const local = (timeZone: string) =>
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
    }).format(new Date(sale.startAt));

  for (const timezoneId of ['Asia/Tokyo', 'America/St_Johns']) {
    const page = await buyer(uniqueUser('tz'), { timezoneId, locale: 'en-US' });
    await expect(ui(page).sale.locator('small')).toHaveText(local(timezoneId));
  }

  // Half an hour apart in offset as well as the date line: one instant, two clocks.
  expect(local('Asia/Tokyo')).not.toEqual(local('America/St_Johns'));
});

test('a browser clock two hours fast does not move the countdown', async ({ page, request }) => {
  await seedSale(request, { startsInMs: -1_000, durationMs: 10 * 60_000 });
  // Read by the local clock alone, ten minutes left would show as long gone.
  await page.clock.install({ time: new Date(Date.now() + 2 * 3_600_000) });

  await page.goto('/');

  await expect(ui(page).sale).toHaveAttribute('data-status', 'active');
  await expect(ui(page).countdown).toHaveText(/^(10:00|09:[0-5]\d)$/);
});
