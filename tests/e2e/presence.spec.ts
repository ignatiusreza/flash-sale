import { expect, seedSale, test, ui, uniqueUser } from './fixtures.js';

/**
 * The viewer count is aggregated across API instances through a fanout and
 * rebroadcast every few seconds (docs/PLAN.md §8); this is its only honest
 * test. Hence the timeouts: the count converges, it does not jump.
 */
test('the viewer count follows people arriving and leaving', async ({ request, buyer }) => {
  await seedSale(request);
  const converges = { timeout: 10_000 };

  const people = await Promise.all(
    ['alice', 'bob', 'carol'].map(async (name) => ({ name, page: await buyer(uniqueUser(name)) })),
  );
  // Labelled, because every page has the same locators and a failure would
  // not otherwise say whose count was wrong.
  const expectCount = (present: typeof people, text: string) =>
    Promise.all(
      present.map(({ name, page }) => expect(ui(page).viewers, name).toHaveText(text, converges)),
    );

  await expectCount(people, '3 people here');

  // The last of them (carol) leaves.
  const stayed = people.slice(0, -1);
  await people.at(-1)?.page.context().close();

  await expectCount(stayed, '2 people here');
});
