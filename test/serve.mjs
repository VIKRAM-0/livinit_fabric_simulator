// Local dev/test server: static files from repo root + /api/* routes run
// in-process (Node's native TypeScript support imports api/*.ts directly —
// no Vercel CLI / project link required). This repo has no live deployment
// yet, so unlike the old app's serve.mjs (which proxied to a production
// Vercel URL), this one runs the real handlers against the real S3 bucket
// and Gemini API using credentials from .env.
// Usage: node test/serve.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2]) || 8123;
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname);

// Load .env into process.env so the api/*.ts handlers (which read
// process.env.AWS_REGION etc. directly) see real credentials.
async function loadEnv(envPath) {
  try {
    const raw = await readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
  } catch { /* no .env — handlers will report missing keys themselves */ }
}
await loadEnv(join(ROOT, '.env'));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
};

// Maps /api/foo -> api/foo.ts's default-exported (req, res) => ... handler,
// same signature Vercel Node functions use.
const apiHandlers = new Map();
async function getHandler(name) {
  if (!apiHandlers.has(name)) {
    const mod = await import(`../api/${name}.ts?t=${Date.now()}`); // cache-bust across restarts isn't needed, but keeps this simple
    apiHandlers.set(name, mod.default);
  }
  return apiHandlers.get(name);
}

function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice('/api/'.length);
      let handler;
      try {
        handler = await getHandler(name);
      } catch (e) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `No api/${name}.ts` }));
      }
      req.query = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') req.body = await readJsonBody(req);
      wrapRes(res);
      return await handler(req, res);
    }
    const path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(String(e.message || e));
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on :${PORT}, /api/* running in-process`));
