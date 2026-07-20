#!/usr/bin/env node
// One-time Gemini PBR map generation: one normal map + one roughness map per
// fabric series (14 series, 28 images total), generated from ONE representative
// color photo per series and reused across every color in that series.
// Run manually: node scripts/generate-fabric-maps.mjs
//
// Uses gemini-3.1-flash-image-preview (same model already used elsewhere in
// this codebase for photorealistic image tasks — api/generate.ts, api/gemini-room.ts).
// Not deployed as an API route — this is an offline authoring step, run once
// before the fabric maps are uploaded to S3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.resolve(REPO_ROOT, '..'); // /home/livinit-algo/fabric_new
const OUT_DIR = path.join(__dirname, 'generated-maps');

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
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
const BUCKET = env.S3_BUCKET;
const PREFIX = 'fabric_assets_v2';
const MODEL = 'gemini-3.1-flash-image-preview';

// One representative color per series — first file alphabetically (deterministic,
// matches the order already baked into catalog.js's FABRIC_SERIES arrays).
const SERIES = {
  'Allante':          'Autumn Rain.jpg',
  'Bali':              'Elephant.jpg',
  'Carson':            'carson_cv-airy.jpg',
  'Chaise':            'Cocoa.jpg',
  'Cinema':            'Apricot.jpg',
  'Crypton':           'Alabaster.jpg',
  'Heirloom':          'Autumn.jpg',
  'Linum':             'Ash.jpg',
  'Milano Stitch':     'Bark.jpg',
  'Natural Linen':     'Bamboo.jpg',
  'Parlour':           'Biscotti.jpg',
  'Rivulet':           'Apricot.jpg',
  'Rivulet Pattern':   'Beach.jpg',
  'Twist':             'Bamboo.jpg',
};

const ROUGHNESS_PROMPT = `You are a 3D PBR texture artist. The input image is a photograph of an upholstery fabric swatch.

Generate a seamless, tileable GREYSCALE ROUGHNESS MAP for this fabric's surface — capturing its micro-surface roughness variation (weave texture, thread pattern, grain), NOT its color.

Rules:
- Output must be GREYSCALE only — no color/hue information whatsoever.
- White = maximum roughness (matte), black = minimum roughness (glossy). Most fabric weaves should read as mid-to-light grey with texture-driven variation, not flat.
- Remove all color, shadows, and directional lighting from the input — the output must be evenly lit, as if photographed under flat diffuse studio light.
- The output must be PERFECTLY SEAMLESS: all four edges must match exactly so the image tiles with no visible seam when repeated in a grid.
- Preserve the exact weave/thread/grain pattern and its repeat scale from the input photo — do not invent a different texture.
- Output a square image at the same resolution as the input.`;

const NORMAL_PROMPT = `You are a 3D PBR texture artist. The input image is a photograph of an upholstery fabric swatch.

Generate a seamless, tileable TANGENT-SPACE NORMAL MAP (OpenGL convention, Y+ green channel) encoding this fabric's weave/thread surface structure as bump detail.

Rules:
- Output must use standard normal-map colors: predominantly blue/violet (RGB around 128,128,255 as the flat baseline), with the red and green channels varying to encode the X/Y surface slope of the weave, thread crossings, and grain visible in the input photo.
- Do NOT include any diffuse color/albedo information in the output — this is a pure normal-map encoding, not a color image.
- The output must be PERFECTLY SEAMLESS: all four edges must match exactly so the image tiles with no visible seam when repeated in a grid.
- Match the exact weave/thread pattern and repeat scale visible in the input photo — encode that structure's depth as normal-map bump detail.
- Output a square image at the same resolution as the input.`;

// Fallback for the rare case Gemini's IMAGE_RECITATION safety filter blocks the
// primary prompt (seen on some tightly-patterned quilted/stitched fabrics) —
// softer wording, same intent, generic weave instead of "exact" pattern matching.
const NORMAL_PROMPT_FALLBACK = `Generate an abstract seamless tileable normal map texture suitable for a woven upholstery fabric surface in a 3D renderer. Use standard tangent-space normal map colors (flat baseline around RGB 128,128,255, blue-dominant) with subtle red/green variation suggesting a fine woven fabric grain. No diffuse color. Must tile seamlessly at all edges. Square image, same resolution as input.`;

function readImageAsBase64(localPath) {
  const buf = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { data: buf.toString('base64'), mimeType };
}

// Returns { buf, ext } — ext is derived from the API's actual declared
// mimeType (observed to be image/jpeg in practice, regardless of what the
// generic data-URL wrapping elsewhere in this codebase, e.g. api/generate.ts,
// hardcodes for browser display) so the saved/uploaded file format is honest.
async function _generateOnce(imagePart, prompt) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: { parts: [{ inlineData: imagePart }, { text: prompt }] },
  });
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      return { buf: Buffer.from(part.inlineData.data, 'base64'), mimeType, ext };
    }
  }
  const textPart = parts.find(p => p.text)?.text;
  const finishReason = response.candidates?.[0]?.finishReason;
  throw new Error(`No inlineData in response (finishReason=${finishReason}${textPart ? `, text="${textPart.slice(0,200)}"` : ''})`);
}

// fallbackPrompt (optional): tried once if every attempt with the primary
// prompt is blocked by Gemini's IMAGE_RECITATION safety filter (seen on a
// few tightly-patterned fabrics) — softer generic wording, same intent.
async function generateMap(imagePart, prompt, label, fallbackPrompt) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await _generateOnce(imagePart, prompt);
    } catch (e) {
      lastErr = e;
      console.warn(`  [${label}] attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  if (fallbackPrompt && /IMAGE_RECITATION/.test(lastErr.message)) {
    console.warn(`  [${label}] retrying with fallback prompt...`);
    try {
      return await _generateOnce(imagePart, fallbackPrompt);
    } catch (e) {
      console.warn(`  [${label}] fallback also failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

async function uploadToS3(localBuf, key, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: localBuf, ContentType: contentType,
  }));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Optional CLI args: filter to specific series names, e.g.
  //   node scripts/generate-fabric-maps.mjs Crypton "Milano Stitch"
  const filter = process.argv.slice(2);
  const entries = Object.entries(SERIES).filter(([s]) => !filter.length || filter.includes(s));
  console.log(`Generating PBR maps for ${entries.length} series (${entries.length * 2} Gemini calls)...\n`);

  const failed = [];
  const results = {};
  for (const [series, file] of entries) {
    const localImgPath = path.join(SOURCE_ROOT, 'fabrics', series, file);
    if (!fs.existsSync(localImgPath)) {
      console.error(`SKIP ${series}: representative image not found at ${localImgPath}`);
      failed.push(series);
      continue;
    }
    console.log(`== ${series} (from ${file}) ==`);
    try {
      const imagePart = readImageAsBase64(localImgPath);

      const seriesOutDir = path.join(OUT_DIR, series);
      fs.mkdirSync(seriesOutDir, { recursive: true });

      const rough = await generateMap(imagePart, ROUGHNESS_PROMPT, `${series} roughness`);
      fs.writeFileSync(path.join(seriesOutDir, `roughness.${rough.ext}`), rough.buf);
      console.log(`  roughness.${rough.ext} saved (${(rough.buf.length / 1024).toFixed(0)} KB)`);

      const norm = await generateMap(imagePart, NORMAL_PROMPT, `${series} normal`, NORMAL_PROMPT_FALLBACK);
      fs.writeFileSync(path.join(seriesOutDir, `normal.${norm.ext}`), norm.buf);
      console.log(`  normal.${norm.ext} saved (${(norm.buf.length / 1024).toFixed(0)} KB)`);

      // Literal series name as the S3 key (real space, not percent-encoded) —
      // matches how upload-assets.mjs uploaded the fabric swatches, and how
      // catalog.js's seriesMaps() percent-encodes it back for the request URL
      // (the browser/s3proxy round-trip decodes %20 back to a real space).
      await uploadToS3(rough.buf, `${PREFIX}/fabric_maps/${series}/roughness.${rough.ext}`, rough.mimeType);
      await uploadToS3(norm.buf, `${PREFIX}/fabric_maps/${series}/normal.${norm.ext}`, norm.mimeType);
      console.log(`  uploaded to s3://${BUCKET}/${PREFIX}/fabric_maps/${series}/  (rough.${rough.ext}, norm.${norm.ext})\n`);
      results[series] = { roughExt: rough.ext, normExt: norm.ext };
    } catch (e) {
      console.error(`  FAILED ${series}: ${e.message}\n`);
      failed.push(series);
    }
  }

  // Persist a manifest of actual file extensions used per series — catalog.js
  // must reference the same extension the file was actually uploaded with.
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  fs.writeFileSync(manifestPath, JSON.stringify({ ...existing, ...results }, null, 2));

  console.log(`Done. Review local copies under ${OUT_DIR}/<series>/ before trusting the uploaded versions.`);
  console.log(`Manifest written to ${manifestPath}`);
  if (failed.length) {
    console.log(`\nFailed series (retry with: node scripts/generate-fabric-maps.mjs ${failed.map(s => `"${s}"`).join(' ')}):`);
    failed.forEach(s => console.log(`  - ${s}`));
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
