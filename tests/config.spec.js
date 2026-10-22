import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Vercel rejects the whole deployment if vercel.json is not valid JSON.
const config = () => JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('vercel.json parses and sets the security headers', () => {
  const { rewrites, headers } = config();
  expect(rewrites).toContainEqual({ source: '/projects', destination: '/projects.html' });
  const site = headers.find(h => h.source === '/(.*)').headers.map(h => h.key);
  expect(site).toEqual(expect.arrayContaining(['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']));
  for (const source of ['/projects', '/projects.html']) {
    const keys = headers.find(h => h.source === source).headers;
    expect(keys).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
    expect(keys).toContainEqual({ key: 'Cache-Control', value: 'no-store' });
  }
});
