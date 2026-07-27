import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export default async function handler(req: any, res: any) {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'missing key' });

  // Only the two public asset prefixes are servable — the bucket also holds
  // mutable admin-written objects that must not become edge-cached public reads.
  if (!key.startsWith('fabric_assets/') && !key.startsWith('fabric_assets_v2/')) {
    return res.status(403).json({ error: 'forbidden key' });
  }

  // Full bucket-relative key is supplied by the caller (catalog.js) — no
  // implicit prefix. Legacy-reused assets (Room GLB, wood textures) carry an
  // explicit 'fabric_assets/' prefix in their key string; new assets carry
  // 'fabric_assets_v2/'.
  const s3Key = key;

  try {
    const { Body, ContentType, ContentLength } = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: s3Key })
    );

    if (!Body) return res.status(404).json({ error: 'not found' });

    res.setHeader('Content-Type', ContentType || 'application/octet-stream');
    if (ContentLength) res.setHeader('Content-Length', String(ContentLength));
    // s-maxage: cache at the CDN/edge (max-age alone never did — every user
    // re-streamed 7-9 MB GLBs through this function; measured ~13 s each).
    // Assets under fabric_assets* are replace-rarely: 1 day edge TTL + SWR.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');

    if (Body instanceof Readable) {
      Body.pipe(res);
    } else {
      const reader = (Body as any).getReader();
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
        return pump();
      };
      await pump();
    }
  } catch (e: any) {
    res.status(e.$metadata?.httpStatusCode || 500).json({ error: e.message });
  }
}
