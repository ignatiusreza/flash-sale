import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

/** What the page says, verbatim — the specs assert on what a person reads. */
export const QUEUED = 'Securing your item…';
export const HELD = /^It’s yours\. Order [0-9a-f-]{36}$/;
export const SOLD_OUT = 'Sold out — every unit is gone.';

export interface SaleView {
  readonly status: 'upcoming' | 'active' | 'ended';
  readonly availability?: string;
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * Wipes and reseeds the one sale through the test-only endpoint. Times are
 * relative to the server's clock, so the suite never depends on its own clock
 * agreeing with the server's. Defaults to open now, for ten minutes.
 */
export async function seedSale(
  request: APIRequestContext,
  sale: { stock?: number; startsInMs?: number; durationMs?: number } = {},
): Promise<SaleView> {
  const response = await request.post('/api/test/sale', {
    data: { stock: 10, startsInMs: -1_000, durationMs: 10 * 60_000, ...sale },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as SaleView;
}

/** Distinct per call, so no two specs ever share a buyer. */
export function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ui(page: Page) {
  return {
    name: page.getByTestId('userId'),
    buy: page.getByTestId('buy'),
    status: page.getByTestId('status'),
    viewers: page.getByTestId('viewers'),
    sale: page.getByTestId('sale'),
    countdown: page.getByTestId('countdown'),
  };
}

/**
 * Waits until the socket is connected and the server has greeted it. Buying
 * before then could send a result to a socket that is not there yet.
 */
export async function expectConnected(page: Page, label?: string): Promise<void> {
  await expect(ui(page).viewers, label).toHaveText(/^[1-9]\d* (person|people) here$/);
}

/** Records Socket.IO frames, for triage: attached to the report on failure. */
function recordFrames(page: Page, label: string, sink: string[]): void {
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/socket.io/')) return;
    ws.on('framesent', (frame) => sink.push(`${label} → ${String(frame.payload)}`));
    ws.on('framereceived', (frame) => sink.push(`${label} ← ${String(frame.payload)}`));
    ws.on('close', () => sink.push(`${label} ✕ closed`));
  });
}

interface Fixtures {
  frames: string[];
  /** A separate person: their own browser context, already identified. */
  buyer: (userId: string, options?: BrowserContextOptions) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // The fixture API requires a destructuring pattern even with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  frames: async ({}, use, testInfo) => {
    const frames: string[] = [];
    await use(frames);
    // UI state is the assertion; frames say whether the server ever sent it.
    if (testInfo.status !== testInfo.expectedStatus && frames.length > 0) {
      await testInfo.attach('socket-frames', {
        body: frames.join('\n'),
        contentType: 'text/plain',
      });
    }
  },

  page: async ({ page, frames }, use) => {
    recordFrames(page, 'page', frames);
    await use(page);
  },

  buyer: async ({ browser, baseURL, frames }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (userId, options = {}) => {
      const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), ...options });
      contexts.push(context);
      await context.addInitScript((id) => localStorage.setItem('flash-sale:userId', id), userId);
      const page = await context.newPage();
      recordFrames(page, userId, frames);
      await page.goto('/');
      return page;
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
});

export { expect };
