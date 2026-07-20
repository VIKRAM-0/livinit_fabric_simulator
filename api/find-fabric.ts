import { GoogleGenAI } from '@google/genai';

export default async function handler(req: any, res: any) {
  if (req.method === 'HEAD') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageData } = req.body || {};
  if (!imageData) {
    return res.status(400).json({ error: 'Missing imageData' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
  }

  const prompt = `You are a 3D materials expert. Analyze this fabric/material image and return PBR rendering properties.

Return ONLY valid JSON with no markdown fences, no explanation:
{
  "name": "Short fabric name (2-4 words, e.g. Woven Linen Beige)",
  "type": "fabric",
  "roughness": 0.72,
  "sheen": 0.10,
  "metalness": 0.0,
  "scale": 10.0,
  "norm": 1.0,
  "hex": "#c4b090",
  "description": "Brief 1-sentence description"
}

Rules:
- "type": one of fabric | linen | leather | vinyl | pu | suede | velvet | cotton | canvas | denim | wood | carpet
- "roughness": 0.0 (glossy) to 1.0 (matte). Most fabrics 0.65–0.90, leather 0.45–0.70, vinyl 0.30–0.55
- "sheen": 0.0 to 1.0. Use 0.15–0.35 for velvet/suede, 0.05–0.15 for most fabrics, 0.0 for leather/vinyl
- "metalness": always 0.0 for fabric/textile; 0.0–0.05 for coated materials
- "scale": UV tile scale 6.0–18.0. Fine weaves ~8–12, large patterns ~4–7, coarse textures ~12–16
- "norm": normal map intensity 0.5–2.0. Smooth fabrics ~0.8, heavily textured ~1.5–2.0
- "hex": dominant average color of the fabric as a 6-digit hex code`;

  try {
    const ai = new GoogleGenAI({ apiKey });

    const parts: any[] = [
      { inlineData: { data: imageData, mimeType: 'image/jpeg' } },
      { text: prompt },
    ];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts },
    });

    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(200).json({ name: '', type: 'fabric', roughness: 0.72, sheen: 0.1, metalness: 0, scale: 10, norm: 1, hex: '#c8c0b8' });
    }

    const d = JSON.parse(jsonMatch[0]);
    return res.status(200).json({
      name:      typeof d.name       === 'string' ? d.name       : '',
      type:      typeof d.type       === 'string' ? d.type       : 'fabric',
      roughness: typeof d.roughness  === 'number' ? d.roughness  : 0.72,
      sheen:     typeof d.sheen      === 'number' ? d.sheen      : 0.10,
      metalness: typeof d.metalness  === 'number' ? d.metalness  : 0.0,
      scale:     typeof d.scale      === 'number' ? d.scale      : 10.0,
      norm:      typeof d.norm       === 'number' ? d.norm       : 1.0,
      hex:       typeof d.hex        === 'string' ? d.hex        : '#c8c0b8',
      description: typeof d.description === 'string' ? d.description : '',
    });
  } catch (error: any) {
    console.error('find-fabric error:', error);
    return res.status(200).json({
      name: '', type: 'fabric', roughness: 0.72, sheen: 0.1,
      metalness: 0, scale: 10, norm: 1, hex: '#c8c0b8',
    });
  }
}
