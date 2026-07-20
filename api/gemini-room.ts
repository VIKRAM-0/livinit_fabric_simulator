import { GoogleGenAI } from '@google/genai';

const SHAPE_RULES = `SHAPE & DESIGN — CRITICAL, NEVER VIOLATE:
- Preserve the EXACT shape, silhouette, structure, and proportions of the furniture exactly as shown in IMAGE 2. Do not redesign the arms, legs, backrest, frame, headboard, or cushions. Do not reinterpret the style, resize the piece, or "improve" its form.
- The only differences between IMAGE 2's furniture and how it appears in your output should be lighting, shadow, reflection, and perspective from being placed in a real room. The design itself — every curve, edge, and proportion — must match IMAGE 2 exactly.`;

const PHOTOREALISM_RULES = `━━━ PHOTOREALISM — APPLY ALL OF THESE ━━━

LIGHTING:
- Analyse IMAGE 1 carefully: identify every light source (windows, ceiling lights, lamps), the direction, colour temperature, and intensity of each.
- Re-light the furniture from IMAGE 2 under this exact same lighting. If IMAGE 1 has warm sunlight coming from the left window, the furniture must have warm highlights on its left faces and cooler shadow on its right faces.
- Match the white balance and colour cast of IMAGE 1 exactly — if the room is warm (3000K), the furniture should carry the same warmth; if cool (6500K daylight), match that.

SHADOWS:
- Cast realistic directional shadows from the furniture onto the floor. The shadow direction, length, and softness must exactly match the shadows of other objects already in IMAGE 1.
- Add tight, dark ambient occlusion where the furniture base/legs meet the floor — this is the most important grounding element.
- If there are multiple light sources, the furniture casts multiple overlapping shadows, just like everything else in the room.

PERSPECTIVE & GEOMETRY:
- The furniture must align perfectly with the room's perspective grid — vanishing points, horizon line, floor plane. A piece that appears to defy the room's perspective immediately reads as fake.
- The furniture must sit flat on the floor plane — no floating, no sinking.
- Match the apparent focal length / lens perspective of IMAGE 1.

SURFACE INTERACTION:
- If the floor is shiny hardwood or polished tile, show a subtle, blurred reflection of the furniture underside in the floor surface.
- If the floor has texture (carpet, wood grain), the furniture legs should compress or interact with it slightly.
- The furniture should show subtle bounce light from the floor and nearby walls — coloured by the room's dominant surface colours.

FABRIC & MATERIAL:
- The fabric color, pattern, texture, and weave from IMAGE 2 must be preserved exactly — this is the user's custom design and must not change.
- Apply lighting effects on top of the fabric (directional shading, specular highlights on shiny threads, soft shadow in folds) but do not alter the underlying pattern or colour.

PHOTO CHARACTERISTICS:
- Match the grain/noise level of IMAGE 1 across the composited furniture.
- If IMAGE 1 has any chromatic aberration, slight vignette, or lens sharpness falloff, apply the same to the composited area.
- The composited area should have identical sharpness, contrast, and saturation to the surrounding real photo — no artificially clean or over-sharpened areas.

FINAL CHECK (apply before output):
- Zoom into the floor contact area — are the shadows correct and the base grounded?
- Check the furniture highlights against the window positions — do they match?
- Is there any halo, hard edge, or colour fringe around the furniture silhouette? Remove it.
- Does the furniture's shape and design still match IMAGE 2 exactly?
- Does the furniture read as part of the original photograph, or as a paste-in? It must read as part of the photograph.`;

function buildPrompt(
  singleAsset: boolean,
  assetLabel: string,
  curtainText: string,
  hasCurtainImage: boolean
): string {
  const hasCurtainRequest = !!curtainText || hasCurtainImage;
  const curtainImageLine = hasCurtainImage
    ? `\nIMAGE 3 = a reference photo showing the curtain style, fabric, and/or color the user wants.`
    : '';

  const intro = `You are a world-class VFX compositor and interior design photographer with 20 years of experience making furniture composites completely indistinguishable from real photographs. Your output will be scrutinised by professional photographers — it must be flawless.

You will receive ${hasCurtainImage ? 'three images' : 'two images'}:
IMAGE 1 = a real photograph of the user's room${singleAsset ? ' (it may already contain other furniture)' : ''}.
IMAGE 2 = a photorealistic product photo of ${singleAsset ? `a single furniture piece — a ${assetLabel}` : 'a sofa and/or accent chair'}, on a neutral background, with the exact custom fabric, material, and shape the user has designed.${curtainImageLine}

YOUR GOAL: Produce one image that looks like IMAGE 1's room was photographed on the same day with IMAGE 2's furniture already sitting inside it — zero evidence of compositing.`;

  const placement = singleAsset
    ? `━━━ PLACEMENT — TARGETED SINGLE-ITEM EDIT ━━━

You are editing ONLY the ${assetLabel} in this room. Do NOT touch, remove, replace, restyle, or move ANY other furniture, object, or decoration already present in IMAGE 1 (other sofas, chairs, beds, tables, rugs, lamps, plants, art, etc.) — leave everything else exactly as it is in IMAGE 1.

CASE A — IMAGE 1 already contains a ${assetLabel} (or a similar piece of the same furniture type):
Remove ONLY that piece and replace it with IMAGE 2's ${assetLabel}, in the EXACT same position, angle, depth, and floor footprint as the original. The replacement must be identical in pose and placement to what it replaced.

CASE B — IMAGE 1 has no existing ${assetLabel}:
Add IMAGE 2's ${assetLabel} into a natural, empty area of the room, facing the camera, at a realistic real-world scale, without disturbing or rearranging any existing furniture already in the room.

Do not add any object types beyond the ${assetLabel} shown in IMAGE 2${hasCurtainRequest ? ' (curtains are handled separately below)' : ''}.`
    : `━━━ PLACEMENT ━━━

CASE A — IMAGE 1 already has a sofa or chair:
Replace each matching piece (sofa → sofa, chair → chair) with the corresponding piece from IMAGE 2 in the EXACT same position, angle, depth, and floor footprint as the original. The replacement must be identical in pose and placement to what it replaced.

CASE B — IMAGE 1 has no sofa or chair:
Place the sofa as the primary piece facing the camera, with the accent chair angled toward it. Use real-world scale: sofa ~200–230 cm wide, chair ~70–80 cm wide. Position them naturally in the available floor space.

In all cases: remove only the furniture being replaced. Keep all permanent architecture (walls, floor, ceiling, windows, fireplace, built-in shelving, wall art). Add no extra objects not in IMAGE 2${hasCurtainRequest ? ' (curtains are handled separately below)' : ''}.`;

  const curtainInstructions = hasCurtainRequest
    ? `\n\n━━━ CURTAINS (OPTIONAL USER REQUEST) ━━━
${hasCurtainImage ? 'Use IMAGE 3 as a visual reference for the curtain fabric, pattern, and color.' : ''}${curtainText ? ` The user described the curtains they want as: "${curtainText}".` : ''}
- If IMAGE 1's room has visible windows with existing curtains, replace those curtains to match this request.
- If IMAGE 1 has visible windows with no curtains, add curtains matching this request in a natural, well-fitted way — proportional to the window, hanging correctly from a rod or track.
- Apply the same lighting/shadow realism rules used for the furniture: the curtain fabric should be lit consistently with the room's light sources.
- Do not alter the windows themselves, the walls, or any other room element beyond adding/changing the curtains.
- If IMAGE 1 has no visible windows at all, skip this instruction entirely — do not invent a window.`
    : '';

  const outro = `OUTPUT: One single photorealistic image — impossible to distinguish from a real interior photograph taken with ${singleAsset ? `this ${assetLabel}` : 'this furniture'} in the room.`;

  return `${intro}\n\n${placement}${curtainInstructions}\n\n${SHAPE_RULES}\n\n${PHOTOREALISM_RULES}\n\n${outro}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { roomPhoto, furnitureRender, assetLabel, singleAsset, curtainText, curtainImage } = req.body || {};
  if (!roomPhoto || !furnitureRender) {
    return res.status(400).json({ error: 'Missing roomPhoto or furnitureRender' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY environment variable' });
  }

  const roomBase64 = roomPhoto.replace(/^data:image\/[a-z]+;base64,/, '');
  const furnBase64 = furnitureRender.replace(/^data:image\/[a-z]+;base64,/, '');
  const roomMime = roomPhoto.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const furnMime = furnitureRender.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

  const parts: any[] = [
    { inlineData: { data: roomBase64, mimeType: roomMime } },
    { inlineData: { data: furnBase64, mimeType: furnMime } },
  ];

  if (curtainImage) {
    const curtainBase64 = curtainImage.replace(/^data:image\/[a-z]+;base64,/, '');
    const curtainMime = curtainImage.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    parts.push({ inlineData: { data: curtainBase64, mimeType: curtainMime } });
  }

  const prompt = buildPrompt(!!singleAsset, assetLabel || 'furniture piece', curtainText || '', !!curtainImage);
  parts.push({ text: prompt });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: { parts },
    });

    let generatedImageUrl: string | null = null;
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        generatedImageUrl = `data:image/png;base64,${part.inlineData.data}`;
        break;
      }
    }

    if (!generatedImageUrl) {
      return res.status(500).json({ error: 'No generated image returned from Gemini' });
    }

    return res.status(200).json({ imageUrl: generatedImageUrl });
  } catch (error: any) {
    console.error('gemini-room error:', error);
    return res.status(500).json({ error: error?.message || 'Failed to generate image' });
  }
}
