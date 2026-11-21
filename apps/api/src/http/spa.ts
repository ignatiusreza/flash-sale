import { resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Paths the server owns. A miss under these is a 404, never the SPA shell. */
const API_PREFIXES = ['/api', '/socket.io', '/docs', '/health', '/metrics'];

/**
 * Serves the built single-page app alongside the API, on one origin.
 *
 * Routing a browser to a SPA and an API is a deployment concern, so it belongs
 * wherever the topology is already described — an Ingress or HTTPRoute in
 * Kubernetes, a CDN in front of the origin, the Vite proxy in development.
 * Baking it into a reverse proxy image instead would hard-code one topology
 * and duplicate rules the gateway already expresses (docs/PLAN.md §12.1).
 *
 * `webRoot` is therefore optional: unset, this is a pure API process and `/`
 * belongs to whatever the gateway routes it to.
 */
export async function spa(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    // Resolved because the plugin rejects a relative path outright, and a
    // relative one is the natural thing to write when starting the process by
    // hand next to the build output.
    root: resolve(webRoot),
    // No wildcard route, so a miss reaches the handler below rather than being
    // answered by the static plugin — which is what keeps unknown `/api` paths
    // returning the API's own 404 instead of the SPA shell.
    wildcard: false,
    setHeaders(reply, path) {
      // Vite emits hashed filenames, so assets can be cached permanently. The
      // shell cannot: it is what points at those hashes, and a cached copy
      // keeps serving a deploy that no longer exists.
      if (path.endsWith('index.html')) {
        reply.header('cache-control', 'no-store');
      } else {
        reply.header('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const owned = API_PREFIXES.some(
      (prefix) => request.url === prefix || request.url.startsWith(`${prefix}/`),
    );
    const navigation =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (request.headers.accept?.includes('text/html') ?? false);

    if (!owned && navigation) return reply.sendFile('index.html');

    return reply.code(404).send({ error: 'not_found' });
  });
}
