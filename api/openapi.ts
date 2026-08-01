// GET /api/openapi — OpenAPI 3.0 spec for the simulator's serverless API.
// Rendered by the Swagger UI page at /api/docs. Keep this in sync by hand when
// an api/*.ts handler changes — there is no framework generating it.

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Livinit Fabric Simulator API',
    version: '1.0.0',
    description:
      'Serverless API behind the fabric simulator (Vercel functions in `api/`). ' +
      'Four endpoints wrap Gemini image models, two wrap S3. ' +
      'The Gemini endpoints are unauthenticated; `/api/viewpoints` writes require the `x-admin-key` header.',
  },
  servers: [
    { url: 'https://web.simulator.livinit.ai', description: 'Production' },
    { url: 'http://localhost:8000', description: 'Local (test/serve.mjs)' },
  ],
  tags: [
    { name: 'AI', description: 'Gemini-backed image generation and analysis' },
    { name: 'Assets', description: 'S3-backed asset delivery and shared config' },
  ],
  paths: {
    '/api/generate': {
      post: {
        tags: ['AI'],
        summary: 'Render an image via Gemini (product / furniture / room modes)',
        description:
          'Sends one input image plus a mode-selected prompt to a Gemini image model. ' +
          '`mode: "room"` converts a 3D room scene into a photorealistic interior photo; ' +
          '`mode: "furniture"` converts a 3D furniture render into a clean catalogue product shot; ' +
          'any other value (or omitted) stages the piece in a showroom-style living room.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['imageData'],
                properties: {
                  imageData: {
                    type: 'string',
                    description: 'Raw base64-encoded JPEG (no data-URL prefix).',
                  },
                  mode: {
                    type: 'string',
                    enum: ['room', 'furniture', 'product'],
                    description: 'Prompt/model selector. Omitted or unknown values fall back to product mode.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Generated image',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ImageUrlResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '405': { $ref: '#/components/responses/MethodNotAllowed' },
          '500': { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/gemini-room': {
      post: {
        tags: ['AI'],
        summary: 'Composite custom furniture into a photo of the user’s room ("View in My Room")',
        description:
          'Takes a real room photo plus a photorealistic furniture render and returns one composited image. ' +
          'If the room already contains a matching piece it is replaced in place; otherwise the piece is added. ' +
          'Optional curtain text/reference-image extends the edit to window curtains.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['roomPhoto', 'furnitureRender'],
                properties: {
                  roomPhoto: { $ref: '#/components/schemas/Base64Image' },
                  furnitureRender: { $ref: '#/components/schemas/Base64Image' },
                  assetLabel: {
                    type: 'string',
                    description: 'Human label of the single piece being placed (e.g. "accent chair"). Used in the prompt.',
                    example: 'accent chair',
                  },
                  singleAsset: {
                    type: 'boolean',
                    description: 'true = targeted single-item edit; false/omitted = sofa-and/or-chair placement rules.',
                  },
                  curtainText: { type: 'string', description: 'Optional user description of desired curtains.' },
                  curtainImage: {
                    allOf: [{ $ref: '#/components/schemas/Base64Image' }],
                    description: 'Optional reference photo of the desired curtain style/fabric.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Composited room image',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ImageUrlResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '405': { $ref: '#/components/responses/MethodNotAllowed' },
          '500': { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/enhance-texture': {
      post: {
        tags: ['AI'],
        summary: 'Clean up a fabric diffuse texture for PBR use',
        description:
          'Neutralises baked-in lighting, sharpens weave detail, and preserves colour/pattern. ' +
          'Edge tiling is deliberately NOT requested here — it is handled deterministically ' +
          'client-side by makeSeamlessTexture() in materials.js.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['imageData'],
                properties: {
                  imageData: {
                    allOf: [{ $ref: '#/components/schemas/Base64Image' }],
                    description: 'Square JPEG diffuse texture, as a data URL or raw base64.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Enhanced texture (never cached)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    imageData: { type: 'string', description: 'PNG data URL of the enhanced texture.' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '405': { $ref: '#/components/responses/MethodNotAllowed' },
          '500': { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/find-fabric': {
      post: {
        tags: ['AI'],
        summary: 'Analyse a fabric photo into PBR material parameters',
        description:
          'Vision analysis of a fabric/material photo. Always returns HTTP 200 with a usable parameter set: ' +
          'on any model failure or unparseable output it falls back to neutral defaults rather than erroring, ' +
          'so callers can apply the result unconditionally. Also answers HEAD 200 as a reachability probe.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['imageData'],
                properties: {
                  imageData: {
                    type: 'string',
                    description: 'Raw base64-encoded JPEG (no data-URL prefix).',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'PBR material parameters (real analysis, or neutral defaults on internal failure)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FabricAnalysis' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '405': { $ref: '#/components/responses/MethodNotAllowed' },
        },
      },
      head: {
        tags: ['AI'],
        summary: 'Reachability probe',
        responses: { '200': { description: 'API reachable' } },
      },
    },
    '/api/s3proxy': {
      get: {
        tags: ['Assets'],
        summary: 'Stream a public simulator asset from S3',
        description:
          'Streams one object from the asset bucket. Only keys under `fabric_assets/` or `fabric_assets_v2/` ' +
          'are servable — anything else is 403 (the bucket also holds mutable admin-written objects that must ' +
          'not become edge-cached public reads). Responses edge-cache for 1 day with 7-day stale-while-revalidate.',
        parameters: [
          {
            name: 'key',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Full bucket-relative object key.',
            example: 'fabric_assets_v2/models/sofa.glb',
          },
        ],
        responses: {
          '200': {
            description: 'The object body, with its stored Content-Type',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          '400': { description: 'Missing key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Key outside the allowed prefixes', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Object not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/viewpoints': {
      get: {
        tags: ['Assets'],
        summary: 'Read all locked camera viewpoints',
        description:
          'Public read of the per-product locked camera pose map, stored as one JSON object in S3. ' +
          'Clients fetch this on boot, snap each product to its locked pose, and treat the locked radius ' +
          'as the closest allowed zoom. Cached 60 s.',
        responses: {
          '200': {
            description: 'Map of product id → viewpoint (empty object if none locked yet)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: { $ref: '#/components/schemas/Viewpoint' },
                  example: { chair: { theta: 0.4, phi: 1.1, r: 1.9, tgt: [0, 0.1, 0] } },
                },
              },
            },
          },
          '500': { $ref: '#/components/responses/ServerError' },
        },
      },
      post: {
        tags: ['Assets'],
        summary: 'Lock one product’s camera viewpoint (admin)',
        security: [{ AdminKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['product', 'viewpoint'],
                properties: {
                  product: { $ref: '#/components/schemas/ProductId' },
                  viewpoint: { $ref: '#/components/schemas/Viewpoint' },
                  adminKey: { type: 'string', description: 'Alternative to the x-admin-key header.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Saved; returns the full updated map',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ViewpointsWriteResponse' } } },
          },
          '400': { description: 'Unknown product or out-of-bounds viewpoint', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '503': { $ref: '#/components/responses/LockingDisabled' },
        },
      },
      delete: {
        tags: ['Assets'],
        summary: 'Clear one product’s locked viewpoint (admin)',
        security: [{ AdminKey: [] }],
        parameters: [
          { name: 'product', in: 'query', required: true, schema: { $ref: '#/components/schemas/ProductId' } },
          { name: 'adminKey', in: 'query', required: false, schema: { type: 'string' }, description: 'Alternative to the x-admin-key header.' },
        ],
        responses: {
          '200': {
            description: 'Cleared; returns the full updated map',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ViewpointsWriteResponse' } } },
          },
          '400': { description: 'Unknown product', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '503': { $ref: '#/components/responses/LockingDisabled' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      AdminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-key',
        description: 'Must equal the ADMIN_KEY env var. If ADMIN_KEY is unset, writes are disabled (503) but reads still work.',
      },
    },
    schemas: {
      Base64Image: {
        type: 'string',
        description: 'Image as a data URL (`data:image/jpeg;base64,...` or png) or raw base64. Data-URL prefixes are stripped server-side.',
      },
      ImageUrlResponse: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string', description: 'Generated image as a PNG data URL.' },
        },
      },
      FabricAnalysis: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Woven Linen Beige', description: 'Short fabric name; empty string on fallback.' },
          type: {
            type: 'string',
            enum: ['fabric', 'linen', 'leather', 'vinyl', 'pu', 'suede', 'velvet', 'cotton', 'canvas', 'denim', 'wood', 'carpet'],
          },
          roughness: { type: 'number', minimum: 0, maximum: 1, example: 0.72 },
          sheen: { type: 'number', minimum: 0, maximum: 1, example: 0.1 },
          metalness: { type: 'number', minimum: 0, maximum: 1, example: 0 },
          scale: { type: 'number', description: 'UV tile scale, typically 4–18.', example: 10 },
          norm: { type: 'number', description: 'Normal map intensity, typically 0.5–2.0.', example: 1 },
          hex: { type: 'string', example: '#c4b090', description: 'Dominant average colour.' },
          description: { type: 'string', description: 'One-sentence description; may be absent on fallback.' },
        },
      },
      ProductId: {
        type: 'string',
        enum: ['chair', 'accent_chair', 'sofa'],
      },
      Viewpoint: {
        type: 'object',
        required: ['theta', 'phi', 'r', 'tgt'],
        properties: {
          theta: { type: 'number', description: 'Orbit azimuth (radians). Clamped to ±4π.' },
          phi: { type: 'number', description: 'Orbit polar angle (radians). Clamped to (0.05, π−0.05).' },
          r: { type: 'number', description: 'Orbit radius. Clamped to [0.3, 30]. Also the closest allowed zoom for visitors.' },
          tgt: {
            type: 'array',
            items: { type: 'number' },
            minItems: 3,
            maxItems: 3,
            description: 'Camera target [x, y, z]. Each component clamped to ±50.',
          },
        },
      },
      ViewpointsWriteResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          viewpoints: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/Viewpoint' },
          },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
    responses: {
      BadRequest: {
        description: 'Missing or invalid request body',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: {
        description: 'x-admin-key missing or wrong',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      MethodNotAllowed: {
        description: 'Wrong HTTP method',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      LockingDisabled: {
        description: 'ADMIN_KEY not configured on the deployment — write path disabled',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      ServerError: {
        description: 'Upstream (Gemini/S3) or internal failure',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
};

export default function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  return res.status(200).json(spec);
}
