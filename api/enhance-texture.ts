// POST /api/enhance-texture
// Accepts a base64 JPEG diffuse texture, returns an AI-enhanced version.
// Enhancement goals: neutral flat lighting, sharp weave detail, colour fidelity.
//
// Tiling is deliberately NOT asked for here. This prompt used to open with
// "SEAMLESS EDGES: make all four edges perfectly seamless", and measurement
// showed the model does not deliver it: on Chaise "Persimmon" the enhanced
// output's left-to-right edge difference was 34.6 versus 30.4 for the original,
// against an interior baseline of ~33 — i.e. no better than an arbitrary crop,
// before and after. Seamlessness is now handled deterministically downstream by
// makeSeamlessTexture() in materials.js, which measures out at 10.0 on the same
// test. Asking for it here only risked the model altering pattern content in
// pursuit of a goal it wasn't achieving.
import { GoogleGenAI } from '@google/genai';

const ENHANCE_PROMPT = `You are a 3D texture artist specialising in PBR material authoring.

The input image is a fabric/textile diffuse (albedo) texture that will tile on a 3D furniture model.
A later processing step handles edge tiling — do NOT modify the edges or try to make them wrap.

Enhance it with these goals — preserve everything else exactly:
1. NEUTRAL LIGHTING: Remove any baked-in shadows, highlights, vignettes, or directional lighting gradients. The output should be evenly lit as if under a perfectly diffuse studio light — no dark corners, no shiny patches.
2. SHARPNESS: Increase clarity and micro-detail of the weave structure, yarn, pile or grain. The fabric threads or surface texture should be crisp.
3. COLOUR ACCURACY: Preserve the exact hue, saturation, and value of the fabric. Do not shift the colour temperature or add any toning.
4. PATTERN INTEGRITY: Keep the exact same weave pattern, repeat size, and fabric structure. Do not invent or remove any pattern elements.

Output a square image at the same resolution as the input.`;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageData } = req.body || {};
  if (!imageData) return res.status(400).json({ error: 'Missing imageData' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });

  try {
    const ai = new GoogleGenAI({ apiKey });

    // Strip data-URL prefix if present
    const base64 = imageData.replace(/^data:image\/[a-z]+;base64,/, '');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          { inlineData: { data: base64, mimeType: 'image/jpeg' } },
          { text: ENHANCE_PROMPT },
        ],
      },
    });

    let enhancedB64: string | null = null;
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if ((part as any).inlineData) {
        enhancedB64 = (part as any).inlineData.data;
        break;
      }
    }

    if (!enhancedB64) return res.status(500).json({ error: 'No image returned from model' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ imageData: `data:image/png;base64,${enhancedB64}` });
  } catch (err: any) {
    console.error('[enhance-texture]', err?.message);
    return res.status(500).json({ error: err?.message || 'Enhancement failed' });
  }
}
