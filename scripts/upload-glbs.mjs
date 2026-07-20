#!/usr/bin/env node
// Replace ONLY the three product GLBs under fabric_assets_v2/glbs/ with the
// Draco-compressed builds. Nothing else in the bucket is touched: the key list
// below is hard-coded, there is no directory walk, and no delete is ever issued.
//
//   node scripts/upload-glbs.mjs --dry-run   (inspect what is live, upload nothing)
//   node scripts/upload-glbs.mjs             (perform the replacement)
//
// Rollback: the currently-live uncompressed builds are the files in
// ../fixed_glbs/ (verified byte-identical by md5 earlier). To revert, re-run
// this with SOURCE_DIR pointed at that folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.resolve(REPO_ROOT, '..', 'fixed_glbs_v5_draco');

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const env = loadEnv(path.join(REPO_ROOT, '.env'));
const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
const BUCKET = env.S3_BUCKET;

// The only keys this script will ever write.
const FILES = ['chair.glb', 'accent_chair_fabric.glb', 'sofa.glb'];
const keyFor = (f) => `fabric_assets_v2/glbs/${f}`;

const DRY = process.argv.includes('--dry-run');

async function head(key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: r.ContentLength, etag: r.ETag, modified: r.LastModified };
  } catch { return null; }
}

async function main() {
  console.log(`bucket: ${BUCKET}`);
  console.log(`source: ${SOURCE_DIR}`);
  console.log(`mode:   ${DRY ? 'DRY RUN — nothing will be written' : 'LIVE — will overwrite'}\n`);

  try {
    const v = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
    console.log(`bucket versioning: ${v.Status || 'not enabled'}` +
      (v.Status === 'Enabled' ? '  (previous versions recoverable)' : '  (overwrite is final — rollback is via ../fixed_glbs/)') + '\n');
  } catch (e) {
    console.log(`bucket versioning: could not determine (${e.name})\n`);
  }

  // Confirm every local file exists before touching anything remote.
  for (const f of FILES) {
    const p = path.join(SOURCE_DIR, f);
    if (!fs.existsSync(p)) throw new Error(`missing local file: ${p}`);
  }

  for (const f of FILES) {
    const key = keyFor(f);
    const local = path.join(SOURCE_DIR, f);
    const body = fs.readFileSync(local);
    const md5 = crypto.createHash('md5').update(body).digest('hex');
    const before = await head(key);

    console.log(`${key}`);
    console.log(`  live now : ${before ? (before.size / 1e6).toFixed(1) + ' MB  ' + before.etag : '(absent)'}`);
    console.log(`  uploading: ${(body.length / 1e6).toFixed(1)} MB  md5=${md5}`);

    if (DRY) { console.log('  skipped (dry run)\n'); continue; }

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body,
      ContentType: 'model/gltf-binary',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    const after = await head(key);
    const ok = after && after.size === body.length;
    console.log(`  result   : ${ok ? 'OK' : 'MISMATCH'} — now ${(after.size / 1e6).toFixed(1)} MB\n`);
    if (!ok) throw new Error(`verification failed for ${key}`);
  }

  console.log(DRY ? 'Dry run complete — no objects written.' : `Done. ${FILES.length} objects replaced, nothing else touched.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
