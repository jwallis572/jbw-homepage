// Vercel serverless function: GET /api/suggest?q=...
// Proxies Google's suggest endpoint (which blocks browser CORS) and returns a JSON array of strings.

const UPSTREAM = 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!q) {
    res.statusCode = 200;
    res.end('[]');
    return;
  }

  try {
    const upstream = await fetch(UPSTREAM + encodeURIComponent(q), {
      headers: { 'User-Agent': 'Mozilla/5.0 (jbw-homepage suggest proxy)' },
      signal: AbortSignal.timeout(3000),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const data = await upstream.json();
    const items = Array.isArray(data) && Array.isArray(data[1])
      ? data[1].filter(s => typeof s === 'string').slice(0, 10)
      : [];
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.end(JSON.stringify(items));
  } catch {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end('[]');
  }
}
