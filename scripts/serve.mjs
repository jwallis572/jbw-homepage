// Minimal local server for tests and dev: serves static files and routes /api/<name> to api/<name>.js,
// the same way Vercel does in production.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const api = pathname.match(/^\/api\/([\w-]+)$/);
    if (api) {
      const mod = await import(pathToFileURL(join(ROOT, 'api', `${api[1]}.js`)).href);
      return await mod.default(req, res);
    }
    // Same clean URLs as vercel.json's rewrites.
    const routes = { '/': '/index.html', '/projects': '/projects.html' };
    const rel = normalize(routes[pathname] || decodeURIComponent(pathname));
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || /[\/](\.|node_modules)/.test(rel)) throw Object.assign(new Error(), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' || err.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500);
    res.end();
  }
}).listen(PORT, () => console.log(`Serving ${ROOT} on http://localhost:${PORT}`));
