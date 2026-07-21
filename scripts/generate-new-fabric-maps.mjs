#!/usr/bin/env node
// One-off PBR map generation for the three NEWLY-SCRAPED patterns
// (Thalassa, Challenger, Douglass 7693). One normal + one roughness map per
// pattern, generated from a mid-tone representative swatch and reused across
// every colorway in that pattern — same design as generate-fabric-maps.mjs.
//
// DIFFERENCE FROM generate-fabric-maps.mjs: this script does NOT upload to S3.
// Outputs land in ../../new_fabrics/<Pattern>/maps/ for manual review first.
// Uploading + catalog wiring happens only after the user verifies the maps.
//
//   node scripts/generate-new-fabric-maps.mjs            (all three)
//   node scripts/generate-new-fabric-maps.mjs Thalassa   (subset)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.resolve(REPO_ROOT, '..');            // /home/livinit-algo/fabric_new
const NEW_FABRICS = path.join(SOURCE_ROOT, 'new_fabrics');

function loadEnv(envPath) {
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const env = loadEnv(path.join(REPO_ROOT, '.env'));
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const MODEL = 'gemini-3.1-flash-image-preview';

// Per-pattern config. `surface` is spliced into both prompts so the model is
// told what it is actually looking at — a smooth vinyl must not be described as
// a woven textile, and each pattern's dominant grain direction is called out so
// the normal map respects it. `roughNote` tunes the roughness base level:
// matte woven fabric reads light-grey (rough); semi-gloss vinyl reads darker.
const PATTERNS = {
  'Thalassa': {
    dir: 'Thalassa', seed: 'swatches/Pebble.jpg',
    surface: 'a woven chenille upholstery fabric with a pronounced HORIZONTAL ribbed weave and fine slub yarn variation running left-to-right',
    roughNote: 'This is a matte woven chenille — the roughness should read as light-to-mid grey overall, with the horizontal rib picked out as brighter/darker banding.',
  },
  'Challenger': {
    // gemini-3.1-flash-image-preview's recitation filter blocks every prompt
    // for this plain pebbled-vinyl (deterministic across the woven-fabric wording
    // AND a fully-synthetic fallback). gemini-2.5-flash-image does not, so this
    // pattern overrides the model. Seed is the LIGHT Fog swatch, not a dark one:
    // the model follows input luminance, so a dark seed (Raven) yields a near-black
    // roughness that reads as glossy — wrong. Fog gives a correct mid-grey base.
    model: 'gemini-2.5-flash-image',
    dir: 'Challenger', seed: 'swatches/Fog.jpg',
    surface: 'a smooth marine-grade upholstery VINYL / faux-leather with a fine uniform pebbled grain (this is NOT a woven textile — there are no threads, only a subtle embossed pebble/leather grain)',
    roughNote: 'This is a semi-matte vinyl, not a fabric — the roughness should read as mid-to-slightly-dark grey (some sheen) and very uniform, with only faint pebble-grain variation. Do NOT add weave/thread banding.',
  },
  'Kimono': {
    // Douglass pattern 5316 ("7693"), branded "Kimono" in the catalog.
    dir: 'Kimono', seed: 'swatches/Aragon.jpg',
    surface: 'a woven linen-look upholstery fabric with a fine VERTICAL slub weave (subtle irregular yarn thickening running top-to-bottom)',
    roughNote: 'This is a matte woven linen-look fabric — the roughness should read as light-to-mid grey overall with fine vertical slub variation.',
  },
};

const roughnessPrompt = (p) => `You are a 3D PBR texture artist. The input image is a photograph of ${p.surface}.

Generate a seamless, tileable GREYSCALE ROUGHNESS MAP for this surface — capturing its micro-surface roughness variation, NOT its color.

Rules:
- Output must be GREYSCALE only — no color/hue information whatsoever.
- White = maximum roughness (matte), black = minimum roughness (glossy). ${p.roughNote}
- Remove all color, shadows, and directional lighting from the input — the output must be evenly lit, as if photographed under flat diffuse studio light.
- The output must be PERFECTLY SEAMLESS: all four edges must match exactly so the image tiles with no visible seam when repeated in a grid.
- Preserve the exact surface structure and its repeat scale from the input photo — do not invent a different texture, and keep the dominant grain direction described above.
- Output a square image at the same resolution as the input.`;

const normalPrompt = (p) => `You are a 3D PBR texture artist. The input image is a photograph of ${p.surface}.

Generate a seamless, tileable TANGENT-SPACE NORMAL MAP (OpenGL convention, Y+ green channel) encoding this surface's structure as bump detail.

Rules:
- Output must use standard normal-map colors: predominantly blue/violet (RGB around 128,128,255 as the flat baseline), with the red and green channels varying to encode the X/Y surface slope of the structure visible in the input photo.
- Do NOT include any diffuse color/albedo information in the output — this is a pure normal-map encoding, not a color image.
- The output must be PERFECTLY SEAMLESS: all four edges must match exactly so the image tiles with no visible seam when repeated in a grid.
- Match the exact structure and repeat scale visible in the input photo, respecting the dominant grain direction described above — encode that structure's depth as normal-map bump detail. Keep the bump SUBTLE for a smooth vinyl, more pronounced for a textured weave.
- Output a square image at the same resolution as the input.`;

const NORMAL_FALLBACK = `Generate an abstract seamless tileable normal map texture suitable for an upholstery surface in a 3D renderer. Use standard tangent-space normal map colors (flat baseline around RGB 128,128,255, blue-dominant) with subtle red/green variation suggesting a fine surface grain. No diffuse color. Must tile seamlessly at all edges. Square image, same resolution as input.`;

// Roughness fallback — softer generic wording for when IMAGE_RECITATION blocks
// the primary prompt (seen on plain vinyl swatches). Same intent, no "exact
// copy of the input" phrasing that trips the filter.
const ROUGH_FALLBACK = `Create a brand-new SYNTHETIC greyscale roughness map from scratch for a 3D renderer — do NOT copy or reproduce the reference image, invent a fresh texture. Subject: a smooth semi-matte marine vinyl / faux-leather with a fine embossed pebble grain. Greyscale only, no color. Base tone mid-to-slightly-dark grey (semi-gloss sheen) with a faint, uniform, randomly-distributed pebble-grain speckle — no weave, no threads, no banding, no directional lines. Perfectly seamless and tileable at all four edges. Square, 1024x1024.`;

function readImageAsBase64(localPath) {
  const buf = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase();
  return { data: buf.toString('base64'), mimeType: ext === '.png' ? 'image/png' : 'image/jpeg' };
}

async function _generateOnce(imagePart, prompt, model = MODEL) {
  const response = await ai.models.generateContent({
    model, contents: { parts: [{ inlineData: imagePart }, { text: prompt }] },
  });
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return { buf: Buffer.from(part.inlineData.data, 'base64'), mimeType, ext: mimeType.includes('png') ? 'png' : 'jpg' };
    }
  }
  const textPart = parts.find(p => p.text)?.text;
  const finishReason = response.candidates?.[0]?.finishReason;
  throw new Error(`No inlineData (finishReason=${finishReason}${textPart ? `, text="${textPart.slice(0, 200)}"` : ''})`);
}

async function generateMap(imagePart, prompt, label, fallbackPrompt, model = MODEL) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await _generateOnce(imagePart, prompt, model); }
    catch (e) {
      lastErr = e;
      console.warn(`  [${label}] attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  if (fallbackPrompt && /IMAGE_RECITATION/.test(lastErr.message)) {
    console.warn(`  [${label}] retrying with fallback prompt...`);
    try { return await _generateOnce(imagePart, fallbackPrompt, model); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function main() {
  const filter = process.argv.slice(2);
  const entries = Object.entries(PATTERNS).filter(([name]) => !filter.length || filter.includes(name));
  console.log(`Generating PBR maps for ${entries.length} pattern(s) — ${entries.length * 2} Gemini calls. NO S3 upload.\n`);

  const failed = [];
  for (const [name, p] of entries) {
    const seedPath = path.join(NEW_FABRICS, p.dir, p.seed);
    if (!fs.existsSync(seedPath)) { console.error(`SKIP ${name}: seed not found ${seedPath}`); failed.push(name); continue; }
    console.log(`== ${name} (seed: ${p.seed}) ==`);
    const outDir = path.join(NEW_FABRICS, p.dir, 'maps');
    fs.mkdirSync(outDir, { recursive: true });
    try {
      const imagePart = readImageAsBase64(seedPath);
      const model = p.model || MODEL;
      const rough = await generateMap(imagePart, roughnessPrompt(p), `${name} roughness`, ROUGH_FALLBACK, model);
      fs.writeFileSync(path.join(outDir, `roughness.${rough.ext}`), rough.buf);
      console.log(`  roughness.${rough.ext} saved (${(rough.buf.length / 1024).toFixed(0)} KB)`);
      const norm = await generateMap(imagePart, normalPrompt(p), `${name} normal`, NORMAL_FALLBACK, model);
      fs.writeFileSync(path.join(outDir, `normal.${norm.ext}`), norm.buf);
      console.log(`  normal.${norm.ext} saved (${(norm.buf.length / 1024).toFixed(0)} KB)\n`);
    } catch (e) { console.error(`  FAILED ${name}: ${e.message}\n`); failed.push(name); }
  }
  console.log('Done. Review local maps under new_fabrics/<Pattern>/maps/ before any upload.');
  if (failed.length) { console.log(`Failed: ${failed.join(', ')}`); process.exitCode = 1; }
}

main().catch(e => { console.error(e); process.exit(1); });
