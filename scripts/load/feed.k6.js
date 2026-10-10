// Load test for the feed and for account search (SC-003, research R9).
//
//   k6 run -e BASE_URL=https://reels.staging.example.sa \
//          -e SIGNED_IN_TOKENS='Bearer 11|aaaa,Bearer 12|bbbb' \
//          -e SEARCH_TOKEN='Bearer 11|aaaa' scripts/load/feed.k6.js
//
// Run it against a staging stack in the Kingdom that holds production-sized data, never against
// production. Two scenarios:
//   feed    500 virtual users for 5 minutes page through GET /api/reels, a mix of signed-in viewers
//           (round-robin over SIGNED_IN_TOKENS) and guests, each with its own installation id.
//           Threshold: p95 under 1000 ms (SC-003).
//   search  20 virtual users for 5 minutes call GET /api/users/search with SEARCH_TOKEN.
//           Threshold: p95 under 300 ms (research R9). If it fails, the fix is a token collection
//           built like hashtag_stats.
//
// SIGNED_IN_TOKENS are real China Parts Sanctum tokens: `Bearer <id>|<secret>`.
// Raise IP_RATE_LIMIT_PER_MINUTE and USER_RATE_LIMIT_PER_MINUTE on the staging stack first: 500
// users from one machine would otherwise measure the throttle, not the feed (docs/operations.md).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3010';
const TOKENS = new SharedArray('tokens', () =>
  (__ENV.SIGNED_IN_TOKENS || '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0),
);
const SEARCH_TOKEN = __ENV.SEARCH_TOKEN || (TOKENS.length > 0 ? TOKENS[0] : '');
/** Names that exist in an Arabic and an English catalog, to make the substring scan do real work. */
const QUERIES = ['احمد', 'محمد', 'قطع', 'auto', 'parts', 'sara', 'shop', 'ali'];

export const options = {
  scenarios: {
    feed: {
      executor: 'constant-vus',
      exec: 'feed',
      vus: 500,
      duration: '5m',
      tags: { scenario: 'feed' },
    },
    search: {
      executor: 'constant-vus',
      exec: 'search',
      vus: 20,
      duration: '5m',
      tags: { scenario: 'search' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:feed}': ['p(95)<1000'],
    'http_req_duration{scenario:search}': ['p(95)<300'],
    'http_req_failed{scenario:feed}': ['rate<0.01'],
    'http_req_failed{scenario:search}': ['rate<0.01'],
  },
};

function uuid() {
  // A v4 UUID, which is what the apps send as the installation id.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// One identity per virtual user: either a real account or a guest with its own installation id.
const identity = {};
function headersFor(vu) {
  if (!identity[vu]) {
    const signedIn = TOKENS.length > 0 && vu % 2 === 0;
    identity[vu] = signedIn
      ? { Authorization: TOKENS[vu % TOKENS.length] }
      : { 'X-Installation-Id': uuid() };
  }
  return identity[vu];
}

export function feed() {
  const headers = headersFor(__VU);
  let cursor = '';
  // A viewer scrolls through a handful of pages, with a pause in between like a person watching.
  for (let page = 0; page < 8; page += 1) {
    const url = `${BASE_URL}/api/reels?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = http.get(url, { headers, tags: { name: 'GET /api/reels' } });
    check(res, { 'feed is 200': (r) => r.status === 200 });
    const body = res.json();
    cursor = body && body.data ? body.data.nextCursor : '';
    if (!cursor) break;
    sleep(1 + Math.random() * 2);
  }
}

export function search() {
  if (!SEARCH_TOKEN) return;
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const res = http.get(
    `${BASE_URL}/api/users/search?q=${encodeURIComponent(q)}&limit=25`,
    {
      headers: { Authorization: SEARCH_TOKEN },
      tags: { name: 'GET /api/users/search' },
    },
  );
  check(res, { 'search is 200': (r) => r.status === 200 });
  sleep(1);
}
