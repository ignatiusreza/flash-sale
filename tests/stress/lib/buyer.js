import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { clearTimeout, setTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';

/**
 * Outcomes, counted rather than inferred. Every attempt lands in exactly one
 * `attempts_*` counter; every accepted one, in exactly one `results_*`.
 */
export const metrics = {
  accepted: new Counter('attempts_accepted'), // 202: queued
  refused: new Counter('attempts_refused'), // 409: sold out or closed, before the queue
  limited: new Counter('attempts_limited'), // 429
  shed: new Counter('attempts_shed'), // 503: queue at its bound
  failed: new Counter('attempts_failed'), // anything else, including socket errors
  confirmed: new Counter('results_confirmed'),
  soldOut: new Counter('results_sold_out'),
  otherResult: new Counter('results_other'),
  missing: new Counter('results_missing'), // accepted, but no result in time
  latency: new Trend('result_latency', true), // POST sent → result received
  timed: new Counter('results_timed'), // samples behind `result_latency`: a p99 of ten means nothing
};

// 409, 429 and 503 are answers, not failures: keep them out of http_req_failed.
http.setResponseCallback(http.expectedStatuses(202, 409, 429, 503));

/** A client address per buyer, so the per-IP rate limit sees many clients. */
export function addressFor(n) {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/** Records the answer to a POST; returns the attempt id when it was queued. */
export function recordAttempt(response) {
  switch (response.status) {
    case 202:
      metrics.accepted.add(1);
      return response.json('attemptId');
    case 409:
      metrics.refused.add(1);
      return undefined;
    case 429:
      metrics.limited.add(1);
      return undefined;
    case 503:
      metrics.shed.add(1);
      return undefined;
    default:
      metrics.failed.add(1);
      return undefined;
  }
}

export function postAttempt(apiUrl, userId, ip) {
  return http.post(`${apiUrl}/api/orders`, JSON.stringify({ userId }), {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    tags: { name: 'POST /api/orders' },
  });
}

/**
 * One person buying, end to end: connected first — as a visitor already is
 * when the sale opens — then the POST, then the result over the socket. The
 * latency is POST to result, so it is the user's wait, not time-to-202.
 *
 * Socket.IO v4 over a raw WebSocket, since k6 has no Socket.IO client:
 * Engine.IO sends `0{…}` on open; `40{auth}` connects the namespace and `40{…}`
 * acknowledges it (`44{…}` refuses); `2` is a ping answered with `3`; events
 * arrive as `42["name",payload]`.
 */
export function buy({ wsUrl, apiUrl, userId, ip, resultTimeoutMs = 30_000 }) {
  const ws = new WebSocket(`${wsUrl}/socket.io/?EIO=4&transport=websocket`);
  let attemptId;
  let sentAt = 0;

  const giveUp = setTimeout(() => {
    if (attemptId) metrics.missing.add(1);
    else metrics.failed.add(1);
    ws.close();
  }, resultTimeoutMs);
  const done = () => {
    clearTimeout(giveUp);
    ws.close();
  };

  ws.onmessage = (event) => {
    const message = String(event.data);

    if (message === '2') {
      ws.send('3');
    } else if (message.startsWith('0')) {
      ws.send(`40${JSON.stringify({ userId })}`);
    } else if (message.startsWith('44')) {
      metrics.failed.add(1);
      done();
    } else if (message.startsWith('40')) {
      sentAt = Date.now();
      attemptId = recordAttempt(postAttempt(apiUrl, userId, ip));
      if (!attemptId) done();
    } else if (message.startsWith('42["purchase:result"')) {
      const [, result] = JSON.parse(message.slice(2));
      if (result.attemptId !== attemptId) return;
      metrics.latency.add(Date.now() - sentAt);
      metrics.timed.add(1);
      if (result.status === 'confirmed') metrics.confirmed.add(1);
      else if (result.status === 'sold_out') metrics.soldOut.add(1);
      else metrics.otherResult.add(1);
      done();
    }
  };
  ws.onerror = () => {
    metrics.failed.add(1);
    done();
  };
}
