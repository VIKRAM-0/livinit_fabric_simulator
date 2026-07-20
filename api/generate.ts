import { GoogleGenAI } from '@google/genai';

const PRODUCT_PROMPT = `You are a professional interior design renderer. Place this furniture piece as the clear focal point in a beautifully staged, modern living room.

Rules you must follow:
- The furniture must face the camera directly — never face away from the viewer
- The furniture is the hero of the image — centred, well-lit, and dominant in the frame
- The living room is staged around the furniture: a rug beneath it, soft ambient lighting from above and the sides, a tasteful background with walls, artwork, and plants
- NO television, screens, or media units in the scene — this is a showroom-style render
- The camera angle is a slight 3/4 front view at eye level, as if a customer is viewing it in a showroom
- Preserve the furniture's exact fabric texture, colour, pattern, and material from the input image — do not change or improve it
- Photorealistic, 8K quality, soft natural lighting`;

const FURNITURE_RENDER_PROMPT = `You are a professional furniture product photographer. Convert this 3D render into a photorealistic product photograph.

The input may show furniture only (sofa, chair, or bed), or furniture together with curtain panels behind/beside it — treat curtains exactly like the furniture pieces for these rules.

RULES:
- Preserve the EXACT shape, silhouette, proportions, and structural design of every piece exactly as shown — do not redesign, restyle, resize, or reinterpret the arms, legs, backrest, frame, cushions, or curtain drape/pleats in any way. Only the surface rendering (lighting, material realism) should change; the form must stay identical.
- Preserve the EXACT fabric/material color, pattern, texture, and weave of every piece (including curtains, if present) — do not change or improve any material
- Apply professional studio lighting: soft key light from the upper-front, gentle fill from the sides — even, flattering, no harsh shadows
- Add a soft realistic contact shadow directly beneath each furniture piece
- Keep the background clean, plain, and neutral (warm white or soft cream) — NO room walls, floor props, plants, rugs, or any background elements other than what's described above
- Show every piece present in the input (furniture and/or curtains) clearly in the frame, in the same pose, position, and arrangement as the input
- Output should look like a professional furniture catalogue product photograph

Do NOT add a room. Do NOT add any background objects. Only the piece(s) shown, on a clean neutral background, with their exact original shape preserved.`;

const ROOM_PROMPT = `You are a professional interior photography renderer. The input image is a 3D scene of a living room. Convert it into a photorealistic, bright, magazine-quality interior photograph.

STRICT PRESERVATION (do not change):
- The exact camera angle, framing, and composition
- The exact placement, size, and rotation of the sofa, accent chair, ottoman, coffee table, side table, shelves, plants, rug, and curtains
- The exact fabric colour, pattern, and texture of the sofa and accent chair upholstery
- The wall colour and shelving layout
- The rug shape, colour, and position under the furniture

REALISM UPGRADES (apply these):
- Bright, even, natural daylight flooding in from the left windows with soft warm ambient fill across the room
- Photorealistic fabric weave on upholstery, realistic wood grain on legs and shelving, ceramic and pottery with accurate sheen
- Soft contact shadows directly under every piece of furniture
- Subtle global illumination and bounce light
- Clean, white-balanced exposure — never dim, never moody, never dark
- Sharp focus across the whole scene, no heavy depth-of-field blur
- Editorial magazine styling — think West Elm or Crate & Barrel catalogue photography

FORBIDDEN:
- Do NOT add, remove, or rearrange furniture
- Do NOT change fabric colours, patterns, or materials
- Do NOT add a TV, screen, media unit, or ceiling pendant that isn't already in the scene
- Do NOT crop in or out — keep the exact same framing
- Do NOT stylise, cartoonify, or apply vintage/dark filters`;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageData, mode } = req.body || {};
  if (!imageData) {
    return res.status(400).json({ error: 'Missing imageData' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY environment variable' });
  }

  const prompt = mode === 'room' ? ROOM_PROMPT : mode === 'furniture' ? FURNITURE_RENDER_PROMPT : PRODUCT_PROMPT;
  const model  = mode === 'room' ? 'gemini-3.1-flash-image-preview' : 'gemini-2.5-flash-image';

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [
          {
            inlineData: {
              data: imageData,
              mimeType: 'image/jpeg',
            },
          },
          { text: prompt },
        ],
      },
    });

    let generatedImageUrl: string | null = null;
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        generatedImageUrl = `data:image/png;base64,${part.inlineData.data}`;
        break;
      }
    }

    if (!generatedImageUrl) {
      return res.status(500).json({ error: 'No generated image returned' });
    }

    return res.status(200).json({ imageUrl: generatedImageUrl });
  } catch (error) {
    console.error('generate API error:', error);
    return res.status(500).json({ error: 'Failed to generate image' });
  }
}
