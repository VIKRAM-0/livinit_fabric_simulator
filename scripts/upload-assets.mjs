#!/usr/bin/env node
// One-time upload: fixed_glbs/ + fabrics/ -> S3 under fabric_assets_v2/
// Run manually: node scripts/upload-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.resolve(REPO_ROOT, '..'); // /home/livinit-algo/fabric_new

function loadEnv(envPath) {
  const out = {};
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const env = loadEnv(path.join(SOURCE_ROOT, '.env'));
const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
const BUCKET = env.S3_BUCKET;
const PREFIX = 'fabric_assets_v2';

const CONTENT_TYPES = { '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function uploadFile(localPath, key) {
  const ext = path.extname(localPath).toLowerCase();
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body,
    ContentType: CONTENT_TYPES[ext] || 'application/octet-stream',
  }));
  console.log(`  uploaded  ${key}  (${(body.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  let count = 0;

  // 1. GLBs
  console.log('== GLBs ==');
  const glbDir = path.join(SOURCE_ROOT, 'fixed_glbs');
  for (const file of fs.readdirSync(glbDir)) {
    if (!file.endsWith('.glb')) continue;
    await uploadFile(path.join(glbDir, file), `${PREFIX}/glbs/${file}`);
    count++;
  }

  // 2. Fabric swatch images
  console.log('== Fabric swatches ==');
  const fabricsDir = path.join(SOURCE_ROOT, 'fabrics');
  for (const series of fs.readdirSync(fabricsDir)) {
    const seriesDir = path.join(fabricsDir, series);
    if (!fs.statSync(seriesDir).isDirectory()) continue;
    for (const file of fs.readdirSync(seriesDir)) {
      const localPath = path.join(seriesDir, file);
      if (!fs.statSync(localPath).isFile()) continue;
      const key = `${PREFIX}/fabrics/${series}/${file}`;
      await uploadFile(localPath, key);
      count++;
    }
  }

  console.log(`\nDone. ${count} files uploaded under s3://${BUCKET}/${PREFIX}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
