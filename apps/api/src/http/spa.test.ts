import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative as relativePath } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestServer } from '../testing/support.js';

/** A built SPA as Vite leaves it: a shell plus a hashed asset. */
function buildWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'flash-sale-web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  return root;
}

describe('serving the SPA from the API', () => {
  let webRoot: string;
  let app: FastifyInstance;

  beforeAll(() => {
    webRoot = buildWebRoot();
  });

  afterEach(async () => {
    await app.close();
  });

  const html = { accept: 'text/html' };

  it('serves the shell at the root', async () => {
    ({ app } = await createTestServer({ webRoot }));
    const res = await app.inject({ method: 'GET', url: '/', headers: html });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root">');
  });

  it('never caches the shell, because it names the hashed assets', async () => {
    ({ app } = await createTestServer({ webRoot }));
    const res = await app.inject({ method: 'GET', url: '/index.html', headers: html });

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('caches hashed assets permanently', async () => {
    ({ app } = await createTestServer({ webRoot }));
    const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves the shell for a client-side route', async () => {
    ({ app } = await createTestServer({ webRoot }));
    const res = await app.inject({ method: 'GET', url: '/some/client/route', headers: html });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root">');
  });

  // The failure this guards against is quiet: a wildcard static route answers
  // unknown API paths with the shell, so a typo'd endpoint returns 200 and
  // HTML, and the client parses it as JSON somewhere far from the cause.
  it('leaves unknown API paths as a JSON 404', async () => {
    ({ app } = await createTestServer({ webRoot }));
    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: html });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('does not answer a non-navigation request with the shell', async () => {
    ({ app } = await createTestServer({ webRoot }));
    const res = await app.inject({
      method: 'GET',
      url: '/some/client/route',
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(404);
  });

  // The plugin rejects a relative root at boot, and `WEB_ROOT=apps/web/dist`
  // is what anyone starting the process by hand would write.
  it('accepts a web root relative to the working directory', async () => {
    const relative = relativePath(process.cwd(), webRoot);
    ({ app } = await createTestServer({ webRoot: relative }));
    const res = await app.inject({ method: 'GET', url: '/', headers: html });

    expect(res.statusCode).toBe(200);
  });

  it('is a pure API when no web root is configured', async () => {
    ({ app } = await createTestServer({}));
    const res = await app.inject({ method: 'GET', url: '/', headers: html });

    expect(res.statusCode).toBe(404);
  });
});
