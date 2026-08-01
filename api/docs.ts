// GET /api/docs — Swagger UI for the simulator API.
// Lives under /api/ on purpose: the vercel.json rewrite sends every non-/api/*
// path to index.html, so a static docs.html at the root would never be served.
// The spec itself comes from /api/openapi (api/openapi.ts); UI assets load from
// the unpkg CDN — this page is a public doc, not part of the app bundle.

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Livinit Fabric Simulator API — Swagger</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/openapi',
      dom_id: '#swagger-ui',
      deepLinking: true,
      defaultModelsExpandDepth: 0,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;

export default function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  // res.end, not res.send: the local test/serve.mjs shim only provides
  // status/json on top of Node's native response.
  res.status(200);
  return res.end(html);
}
