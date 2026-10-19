import { test, expect } from '@playwright/test';
import handler from '../api/suggest.js';

// Unit tests for the serverless function with the upstream fetch mocked (no browser).
function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b = '') { this.body = b; },
  };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('returns suggestion strings from upstream with a cache header', async () => {
  let calledWith;
  globalThis.fetch = async url => {
    calledWith = url;
    return new Response(JSON.stringify(['cardiac', ['cardiac arrest', 'cardiac tamponade', 42]]), { status: 200 });
  };
  const res = fakeRes();
  await handler({ url: '/api/suggest?q=cardiac%20a' }, res);
  expect(calledWith).toBe('https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=cardiac%20a');
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/json');
  expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  expect(JSON.parse(res.body)).toEqual(['cardiac arrest', 'cardiac tamponade']);
});

test('empty query returns [] without calling upstream', async () => {
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  const res = fakeRes();
  await handler({ url: '/api/suggest?q=%20' }, res);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual([]);
});

test('upstream failure returns 502 with []', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 503 });
  const res = fakeRes();
  await handler({ url: '/api/suggest?q=abc' }, res);
  expect(res.statusCode).toBe(502);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(res.body)).toEqual([]);
});
