// Per-product locked camera viewpoints, shared across every visitor.
//
//   GET  /api/viewpoints            → public read of the whole map (JSON)
//   POST /api/viewpoints            → admin-gated write of ONE product's viewpoint
//
// Storage is a single JSON object in S3 at fabric_assets_v2/config/viewpoints.json:
//   { "chair": {"theta":0.4,"phi":1.1,"r":1.9,"tgt":[0,0.1,0]}, ... }
//
// The lock icon in the viewport (admin only) POSTs the current camera pose here;
// every visitor's client GETs this map on boot and, per product, snaps to the
// locked pose and treats the locked radius as the closest allowed zoom. This is
// why "once it is set it is done for anyone accessing the website" — the state
// lives server-side in S3, not in any one browser.
//
// Writes require the x-admin-key header to equal process.env.ADMIN_KEY. If
// ADMIN_KEY is unset the write path is disabled (503) — reads still work. Set
// ADMIN_KEY in the Vercel project env (and .env for local test/serve.mjs).
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const KEY = 'fabric_assets_v2/config/viewpoints.json';
const PRODUCTS = ['chair', 'accent_chair', 'sofa'];

type Viewpoint = { theta: number; phi: number; r: number; tgt: [number, number, number] };

async function streamToString(body: any): Promise<string> {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function readAll(): Promise<Record<string, Viewpoint>> {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: KEY }));
    const txt = await streamToString(Body);
    const obj = txt ? JSON.parse(txt) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e: any) {
    // Missing object (first-ever run) is normal — start from empty.
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return {};
    throw e;
  }
}

// Coerce an arbitrary body into a clean, bounded Viewpoint or return null.
function sanitize(v: any): Viewpoint | null {
  if (!v || typeof v !== 'object') return null;
  const num = (x: any, lo: number, hi: number) =>
    typeof x === 'number' && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null;
  const theta = num(v.theta, -Math.PI * 4, Math.PI * 4);
  const phi = num(v.phi, 0.05, Math.PI - 0.05);
  const r = num(v.r, 0.3, 30);
  const t = Array.isArray(v.tgt) ? v.tgt : [0, 0, 0];
  const tgt = [num(t[0], -50, 50), num(t[1], -50, 50), num(t[2], -50, 50)];
  if (theta === null || phi === null || r === null || tgt.some(n => n === null)) return null;
  return { theta, phi, r, tgt: tgt as [number, number, number] };
}

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    try {
      const all = await readAll();
      res.setHeader('Content-Type', 'application/json');
      // Short cache: visitors pick up a freshly-locked viewpoint within a minute.
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
      return res.status(200).json(all);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(503).json({ error: 'Locking disabled — ADMIN_KEY not configured' });
    const sent = req.headers['x-admin-key'] || (req.body && req.body.adminKey);
    if (sent !== adminKey) return res.status(401).json({ error: 'Unauthorized' });

    const { product, viewpoint } = req.body || {};
    if (!PRODUCTS.includes(product)) return res.status(400).json({ error: 'Unknown product' });
    const clean = sanitize(viewpoint);
    if (!clean) return res.status(400).json({ error: 'Invalid viewpoint' });

    try {
      const all = await readAll();
      all[product] = clean;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET!,
        Key: KEY,
        Body: JSON.stringify(all, null, 2),
        ContentType: 'application/json',
        CacheControl: 'public, max-age=60',
      }));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, viewpoints: all });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE clears one product's lock (admin-gated) — handy for re-framing.
  if (req.method === 'DELETE') {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(503).json({ error: 'Locking disabled — ADMIN_KEY not configured' });
    const sent = req.headers['x-admin-key'] || (req.query && req.query.adminKey);
    if (sent !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
    const product = req.query?.product;
    if (!PRODUCTS.includes(product)) return res.status(400).json({ error: 'Unknown product' });
    try {
      const all = await readAll();
      delete all[product];
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET!, Key: KEY,
        Body: JSON.stringify(all, null, 2), ContentType: 'application/json',
        CacheControl: 'public, max-age=60',
      }));
      return res.status(200).json({ ok: true, viewpoints: all });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
