#!/usr/bin/env node
// Upload the three NEWLY-SCRAPED fabric series (Thalassa, Challenger, Kimono)
// to S3. Touches ONLY these prefixes, nothing else in the bucket:
//   fabric_assets_v2/fabrics/<Series>/<Color>.jpg      (colour swatches)
//   fabric_assets_v2/fabric_maps/<Series>/normal.jpg   (shared PBR maps)
//   fabric_assets_v2/fabric_maps/<Series>/roughness.jpg
//
// Discipline (same as upload-glbs.mjs): the series list is hard-coded, only the
// two known subfolders (swatches/, maps/) of each are read, there is no walk
// anywhere else, and no delete is ever issued. Every PUT is size-verified.
//
//   node scripts/upload-new-fabrics.mjs --dry-run   (list what would upload)
//   node scripts/upload-new-fabrics.mjs             (perform the upload)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NEW_FABRICS = path.resolve(REPO_ROOT, '..', 'new_fabrics');

// Local staging dir name -> S3 series name. Kimono is staged under new_fabrics/Kimono.
const SERIES = ['Thalassa', 'Challenger', 'Kimono'];

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
const DRY = process.argv.includes('--dry-run');

// Build the explicit upload list: for each series, every swatch jpg + the two
// map jpgs. Real spaces in keys (s3proxy uses the key verbatim; catalog.js
// percent-encodes for the request URL, the round-trip decodes back to a space).
function buildJobs() {
  const jobs = [];
  for (const series of SERIES) {
    const base = path.join(NEW_FABRICS, series);
    const swDir = path.join(base, 'swatches');
    const mapDir = path.join(base, 'maps');
    if (!fs.existsSync(swDir)) throw new Error(`missing swatches dir: ${swDir}`);
    if (!fs.existsSync(mapDir)) throw new Error(`missing maps dir: ${mapDir}`);
    for (const f of fs.readdirSync(swDir).filter(f => /\.jpg$/i.test(f)).sort()) {
      jobs.push({ local: path.join(swDir, f), key: `fabric_assets_v2/fabrics/${series}/${f}` });
    }
    for (const f of ['normal.jpg', 'roughness.jpg']) {
      const p = path.join(mapDir, f);
      if (!fs.existsSync(p)) throw new Error(`missing map: ${p}`);
      jobs.push({ local: p, key: `fabric_assets_v2/fabric_maps/${series}/${f}` });
    }
  }
  return jobs;
}

async function head(key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: r.ContentLength };
  } catch { return null; }
}

async function main() {
  console.log(`bucket: ${BUCKET}`);
  console.log(`mode:   ${DRY ? 'DRY RUN — nothing will be written' : 'LIVE — will PUT'}\n`);
  try {
    const v = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
    console.log(`bucket versioning: ${v.Status || 'not enabled'}\n`);
  } catch (e) { console.log(`bucket versioning: unknown (${e.name})\n`); }

  const jobs = buildJobs();
  const bySeries = {};
  for (const j of jobs) { const s = j.key.split('/')[2]; (bySeries[s] ||= []).push(j); }
  console.log(`Planned uploads: ${jobs.length} objects`);
  for (const s of SERIES) console.log(`  ${s}: ${bySeries[s].length} objects`);
  console.log('');

  let done = 0, skipped = 0;
  for (const j of jobs) {
    const body = fs.readFileSync(j.local);
    if (DRY) { const ex = await head(j.key); console.log(`  ${ex ? 'REPLACE' : 'NEW    '} ${j.key}  (${(body.length/1024).toFixed(0)} KB)`); continue; }
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: j.key, Body: body,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    const after = await head(j.key);
    if (!after || after.size !== body.length) throw new Error(`verify failed: ${j.key}`);
    done++;
    if (done % 20 === 0) console.log(`  ...${done}/${jobs.length}`);
  }

  if (DRY) console.log(`\nDry run complete — ${jobs.length} objects would be uploaded, nothing written.`);
  else console.log(`\nDone. ${done} objects uploaded, ${skipped} skipped, nothing else touched.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
