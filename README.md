# LIVINIT · Fabric Configurator

> A real-time 3D furniture fabric configurator with AI-powered photorealistic rendering. Customers can drag-and-drop fabric swatches onto 3D furniture models, fine-tune material properties, view their configured furniture inside a staged living room, and generate magazine-quality AI renders — all from the browser.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Pipeline Flow](#pipeline-flow)
  - [1. Initialization & Asset Loading](#1-initialization--asset-loading)
  - [2. Fabric Library System](#2-fabric-library-system)
  - [3. 3D Model Processing](#3-3d-model-processing)
  - [4. Fabric Application Pipeline](#4-fabric-application-pipeline)
  - [5. PBR Material System](#5-pbr-material-system)
  - [6. Room View System](#6-room-view-system)
  - [7. AI Rendering Pipeline](#7-ai-rendering-pipeline)
  - [8. Export Pipeline](#8-export-pipeline)
- [Fabric Data Architecture](#fabric-data-architecture)
- [Material Texture Pipeline](#material-texture-pipeline)
- [Camera & Interaction System](#camera--interaction-system)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Local Development](#local-development)

---

## Overview

The Livinit Fabric Configurator is a single-page web application that enables customers to:

1. **Browse** curated fabric libraries from real-world vendors (MityLite Sierra, Douglass Fabrics, Ennis Fabrics)
2. **Apply** fabrics to individual parts of 3D furniture models via click or drag-and-drop
3. **Fine-tune** material properties (roughness, metalness, brightness, pattern scale, bump strength, fabric fuzz/sheen)
4. **Preview** the configured furniture inside a fully staged 3D living room
5. **Generate** AI-powered photorealistic renders using Google Gemini's image generation models
6. **Export** the configured model as a `.glb` file for downstream use

The application supports two furniture models out of the box — an **Armchair** and a **Sofa** — each with its own curated fabric collection spanning vinyls, leathers, PU, linens, and woven fabrics.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **3D Engine** | [Three.js r128](https://threejs.org/) | WebGL rendering, PBR materials, scene management |
| **3D Formats** | GLB/glTF 2.0 | Furniture and room model format |
| **Mesh Compression** | [Draco](https://google.github.io/draco/) (v1.5.6) | Compressed mesh geometry decoding |
| **PBR Textures** | [Poly Haven API](https://polyhaven.com/) | Physically-based normal & roughness maps |
| **Texture CDN** | [Supabase Storage](https://supabase.com/) | Hosting for GLB models, fabric images, and PBR texture maps |
| **AI Rendering** | [Google Gemini API](https://ai.google.dev/) (`@google/genai`) | Image-to-image photorealistic scene rendering |
| **AI Models** | `gemini-2.5-flash-image` / `gemini-3.1-flash-image-preview` | Product render (cheaper) / Room render (higher fidelity) |
| **Backend** | Vercel Serverless Functions (TypeScript) | API endpoint for Gemini image generation |
| **Frontend** | Vanilla HTML + CSS + JavaScript | Single-file SPA, no framework dependencies |
| **Typography** | [DM Sans](https://fonts.google.com/specimen/DM+Sans) + [DM Serif Display](https://fonts.google.com/specimen/DM+Serif+Display) | UI typography |
| **Hosting** | [Vercel](https://vercel.com/) | Static hosting + serverless API |
| **Language** | TypeScript (API) + JavaScript (Frontend) | |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          BROWSER (Client)                          │
│                                                                     │
│  ┌──────────────┐  ┌───────────────────────┐  ┌──────────────────┐ │
│  │  Left Panel   │  │    3D Viewport         │  │  Right Panel     │ │
│  │  ─────────── │  │    ──────────────      │  │  ──────────────  │ │
│  │  Fabric       │  │    Three.js WebGL      │  │  Parts List      │ │
│  │  Library      │◄─┤    Canvas              │─►│  Material        │ │
│  │  (Swatches)   │  │                        │  │  Sliders         │ │
│  │               │  │    ┌─────────────────┐ │  │  Applied Preview │ │
│  │  - MityLite   │  │    │  GLB Models     │ │  │                  │ │
│  │  - Douglass   │  │    │  - Chair        │ │  │  Room Controls   │ │
│  │  - Ennis      │  │    │  - Sofa         │ │  │  - Toggle walls  │ │
│  │               │  │    │  - Room         │ │  │  - Explode view  │ │
│  └──────┬───────┘  │    └─────────────────┘ │  └──────────────────┘ │
│         │          └───────────┬─────────────┘                      │
│    Drag & Drop           Canvas Capture                             │
│         │                     │                                     │
│         └─────────────────────┘                                     │
│                    │                                                │
└────────────────────┼────────────────────────────────────────────────┘
                     │  POST /api/generate
                     ▼
          ┌─────────────────────┐
          │  Vercel Serverless  │
          │  ─────────────────  │
          │  api/generate.ts    │
          │                     │
          │  ┌───────────────┐  │
          │  │ Google Gemini │  │
          │  │ GenAI SDK     │  │
          │  └───────────────┘  │
          └─────────────────────┘
```

---

## Pipeline Flow

### 1. Initialization & Asset Loading

When the page loads, the following initialization sequence executes:

```
loadScripts() → initThree() → initDragDrop() → buildLibrary() → loadModel(CHAIR_GLB)
                                                                          │
                                                               Pre-load SOFA_GLB silently
```

**Step-by-step:**

1. **Script Loading** — Three.js add-ons are loaded sequentially via dynamic `<script>` injection:
   - `DRACOLoader.js` — Decodes Draco-compressed mesh geometry
   - `GLTFLoader.js` — Parses GLB/glTF 2.0 model files
   - `RoomEnvironment.js` — Generates an IBL environment map for realistic reflections

2. **Three.js Initialization** (`initThree()`)
   - Creates a `WebGLRenderer` with ACES filmic tone mapping, sRGB output encoding, and physically correct lighting
   - Generates a `PMREMGenerator` environment map from `RoomEnvironment` for IBL (image-based lighting)
   - Sets up ambient light (0.5 intensity) + directional light (2.5 intensity) at position `(3, 5, 4)`
   - Attaches orbit/pan/zoom mouse controls to the canvas
   - Starts a `requestAnimationFrame` render loop with a dirty-flag optimization (only re-renders when state changes)

3. **Drag & Drop** (`initDragDrop()`) — Registers global `mousemove` and `mouseup` listeners for fabric drag-and-drop onto the 3D viewport

4. **Library Build** (`buildLibrary()`) — Renders the fabric swatch grid in the left panel based on `currentModelKey` (`'chair'` or `'sofa'`)

5. **Model Load** — Loads the default Armchair GLB from Supabase, processes it via `processGLTF()`, and preloads the Sofa GLB into `roomFurnitureModels.sofa` for instant room-view entry

---

### 2. Fabric Library System

The fabric library is a multi-vendor, multi-series catalogue defined entirely in-memory as JavaScript arrays. Each fabric entry contains:

```javascript
{
  name: 'Abilene Bark',       // Display name
  img:  '...ABILE808V.jpg',   // Swatch thumbnail URL (fabric image servers)
  type: 'vinyl',              // Material type: vinyl | fabric | pu | leather | linen | wood
  series: 'Abilene',          // Series/collection grouping
  hex: '#8b6b48',             // Fallback color (used when img unavailable or for color-only swatches)
  vendor: 'mity',             // Vendor identifier
  pattern: 'Kaleidoscope Neo',// Pattern name (Douglass only)
  patKey: 'kaleid',           // Key into POLY_IDS for PBR texture lookup
}
```

**Vendor breakdown:**

| Vendor | Model | Series Count | Material Types |
|--------|-------|-------------|----------------|
| **MityLite Sierra** | Chair | 12 series (Abilene, All American, Amarillo, Amuse, Anchor, Archetype, Aretha, Artisanal EPU, Berwick Tweed, Beso, Bestie, Faux Wood) | Vinyl, Fabric, PU, Wood |
| **Douglass Fabrics** | Sofa | 2 series (Kaleidoscope Neo #5308, Twist #5881) | Vinyl, Linen |
| **Ennis Fabrics** | Sofa | 2 series (Linum, Challenger) | Linen, Leather |

**Swatch image sources:**
- MityLite fabrics → `https://fabrics.mityinc.com/server/public/fabrics/`
- Douglass fabrics → Supabase bucket: `fabric_assets/fabric_images/douglass/`
- Wood finishes → Supabase bucket: `fabric_assets/wood_texture/custom/`
- Ennis fabrics → Hex-color-only (no swatch images)

---

### 3. 3D Model Processing

When a GLB model loads, `processGLTF()` performs a sophisticated mesh analysis pipeline:

```
GLB Load → Scale to 1.6 units → Center at origin → Traverse meshes
                                                         │
                                        ┌────────────────┴───────────────┐
                                        ▼                                ▼
                                 Per-mesh analysis               Intelligent naming
                                 - Bounding box                  - Spatial heuristics
                                 - Volume ratio                  - Y position → Legs/Base
                                 - Flatness ratio                - Z position → Backrest
                                 - UV scale factor               - X extremes → Armrests
                                        │                        - Volume → Main Body
                                        ▼                        - Flatness → Stitching
                                 Create greyMat clone
                                 (neutral material for
                                  fabric application)
```

**Key processing steps:**

1. **Normalization** — The model is scaled so its largest dimension = 1.6 world units, then centered at the origin

2. **Mesh Traversal** — Every `Mesh` child is traversed, and for each material slot:
   - The original material (`origMat`) is preserved for reset
   - A neutral `greyMat` clone is created with:
     - All textures stripped (map, normalMap, roughnessMap, etc.)
     - Color set to `#d4d0cc` (warm grey)
     - Roughness = 0.75, metalness = 0
     - Double-sided rendering enabled
   - If the original had a diffuse texture, a greyscale version is generated via a canvas filter chain

3. **Intelligent Part Naming** — Each mesh is automatically named using spatial heuristics:
   - **Y < -0.55** → `Legs / Base`
   - **Z < -0.35 && Y > -0.3** → `Backrest`
   - **|X| > 0.55 && Y > -0.4** → `Left/Right Armrest`
   - **Volume ratio > 0.12** → `Main Body`
   - **Flatness < 0.06** → `Stitching`
   - Model-specific renames are then applied (e.g., `Main Body 1` → `Seat Cushion`)

4. **UV Scale Factor** — The largest bounding-box dimension of each mesh is stored as `uvScaleFactor`, used to maintain physically consistent texture tiling across differently-sized parts

---

### 4. Fabric Application Pipeline

Fabric can be applied via two methods:

#### Click-to-Apply (Product Mode)
```
User clicks swatch → applySwatch() → reads checked meshEntries → applySwatchToEntries()
```

#### Drag-and-Drop
```
mousedown on swatch → startDrag() → ghost follows cursor → hover highlights mesh via raycaster
                                                                          │
mouseup over canvas → dropFabricOnCanvas() → raycaster hit test → applySwatchToEntries([hitEntry])
```

The raycast-based drag-and-drop system:
1. Casts a ray from the camera through the mouse position
2. Intersects against all mesh objects in `meshEntries`
3. Highlights the hovered mesh with a green emissive glow (`#2d4a3e`, intensity 0.35)
4. On drop, applies the fabric to the specific mesh under the cursor

---

### 5. PBR Material System

The core of visual quality — `applySwatchToEntries()` builds a physically-based material for each fabric type:

```
                    ┌─────────────────────────────────┐
                    │     Fabric Type Defaults         │
                    │  ──────────────────────────────  │
                    │  wood:    rough=0.55 scale=5.0   │
                    │  vinyl:   rough=0.45 scale=12.0  │
                    │  pu:      rough=0.50 scale=10.0  │
                    │  leather: rough=0.60 scale=8.0   │
                    │  linen:   rough=0.80 scale=14.0  │
                    │  fabric:  rough=0.72 scale=10.0  │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │     Texture Resolution           │
                    │  ──────────────────────────────  │
                    │  1. Try Poly Haven API (1k/2k)   │
                    │  2. Fallback: Supabase CDN       │
                    │  3. Fallback: hex color only      │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │     Material Assembly            │
                    │  ──────────────────────────────  │
                    │  map:          diffuse texture    │
                    │  normalMap:    surface detail     │
                    │  roughnessMap: micro-roughness    │
                    │  roughness:    base roughness     │
                    │  metalness:    metallic quality    │
                    │  sheen:        fabric fuzz/sheen  │
                    └─────────────────────────────────┘
```

**Texture sources hierarchy (with multi-level fallback):**

| Map Type | Primary Source | Fallback Source |
|----------|---------------|-----------------|
| **Diffuse** | Vendor swatch image (`item.img`) | Solid hex color (`item.hex`) |
| **Normal** | Poly Haven API (`nor_gl` key) | Supabase CDN (`cotton_fabric/Normal.jpg`) |
| **Roughness** | Poly Haven API (`Rough` key) | Supabase CDN (`cotton_fabric/Roughness.jpg`) |

**Poly Haven material mapping:**

| Fabric Type | Poly Haven Asset ID |
|-------------|-------------------|
| Fabric | `fabric_pattern_05` |
| Vinyl | `scuba_suede` |
| PU / Leather | `leather_white` |
| Linen | `rough_linen` |
| Wood | `brown_leather` |
| Twist | `hessian_230` |
| Kaleidoscope | `caban` |

**Texture tiling formula:**
```
physicalRepeat = patternScale × (meshUVScaleFactor / BASE_TILE)
```
where `BASE_TILE = 0.3`. This ensures consistent fabric pattern scale regardless of mesh size.

**Caching strategy:**
- `texCache{}` — Caches loaded `THREE.Texture` objects by URL to prevent redundant HTTP requests
- `polyCache{}` — Caches Poly Haven API responses to avoid repeated API calls
- Textures are cloned per-material to allow independent tiling/repeat settings

---

### 6. Room View System

The room view places both furniture models into a staged 3D living room environment:

```
toggleRoomView() ON
        │
        ▼
  Save material snapshot → buildRoom() → Load room.glb
        │                                      │
        │                        ┌─────────────┘
        │                        ▼
        │                  Scale room to 6 units
        │                  Detect floor Y (largest XZ footprint mesh)
        │                  Tag elements (walls, floor, windows, doors, rug, ceiling)
        │                        │
        │                        ▼
        │                  _placeFurnitureInRoom()
        │                        │
        │              ┌─────────┴──────────┐
        │              ▼                    ▼
        │        Active model          Companion model
        │        (currentModelKey)     (load or use cache)
        │              │                    │
        │              ▼                    ▼
        │        _seatOnFloor()        _seatOnFloor()
        │        position, rotate,     position, rotate,
        │        scale per slot        scale per slot
        │
        ▼
  Set room camera:
  θ=-2.32, φ=1.28, r=15.7
  target=(0, -0.72, 0)
```

**Furniture slot configuration:**

| Model | X Position | Z Position | Y Rotation | Scale |
|-------|-----------|-----------|-----------|-------|
| Chair | 2.2 | 0.89 | 3.93 rad (~225°) | 0.7 |
| Sofa | 0.2 | 1.0 | π rad (180°) | 1.2 |

**Floor detection algorithm:**
The system automatically detects the floor surface by traversing all room GLB meshes and finding the one with:
- The largest XZ footprint area
- A very flat profile (height < 5% of width and depth)
- Uses `box.max.y` of that mesh as `roomFloorY`

**Room features:**
- **Element toggles** — Show/hide walls, floor, windows, doors, rug, ceiling independently
- **Explode view** — Smoothly separates furniture parts along their centroid-relative directions
- **Explode animation** — Eased `requestAnimationFrame` animation (1.2s, quadratic ease-in-out)
- **Material persistence** — Fabric selections survive model switching via `modelMaterialSnapshots`

---

### 7. AI Rendering Pipeline

The render pipeline captures the current 3D scene and sends it to Google Gemini for photorealistic image generation:

```
renderScene()
      │
      ├─ Save camera state
      ├─ (Room mode: override to fixed interior camera)
      ├─ Force 2 render passes (flush dirty-flag)
      ├─ Canvas → JPEG data URL (95% quality)
      │
      ├─ Probe /api/generate (HEAD request)
      │     │
      │     ├─ API unavailable → Show raw screenshot as preview
      │     │
      │     └─ API available →
      │           │
      │           ▼
      │     POST /api/generate
      │     { imageData: base64, mode: 'product' | 'room' }
      │           │
      │           ▼
      │     ┌─────────────────────────────────┐
      │     │  Vercel Serverless Function      │
      │     │  ────────────────────────────── │
      │     │  mode='product'                  │
      │     │    → gemini-2.5-flash-image      │
      │     │    → PRODUCT_PROMPT              │
      │     │                                  │
      │     │  mode='room'                     │
      │     │    → gemini-3.1-flash-image-preview │
      │     │    → ROOM_PROMPT                 │
      │     └───────────┬─────────────────────┘
      │                 │
      │                 ▼
      │     Returns base64 PNG image
      │           │
      │           ▼
      │     showRenderedImage() → Full-screen overlay with download
      │
      └─ Restore camera state + background
```

**AI Prompt Design:**

- **Product Mode (`PRODUCT_PROMPT`)**: Places the furniture as the hero subject in a staged showroom-style living room. Rules include:
  - Furniture must face the camera directly
  - 3/4 front view at eye level
  - Preserve exact fabric texture, colour, and material from input
  - No TV/screens in scene
  - 8K photorealistic quality

- **Room Mode (`ROOM_PROMPT`)**: Converts the 3D room scene into a magazine-quality interior photograph. Strict preservation rules:
  - Exact camera angle, framing, composition preserved
  - All furniture placement, fabric colors, and textures preserved
  - Realism upgrades: natural daylight, photorealistic fabric weave, contact shadows, global illumination
  - Editorial magazine styling (West Elm / Crate & Barrel quality)

**Model selection rationale:**
- Product renders use `gemini-2.5-flash-image` (simpler single-subject task, lower cost)
- Room renders use `gemini-3.1-flash-image-preview` (complex scene with layout/texture preservation needs)

---

### 8. Export Pipeline

```
exportGLB()
      │
      ├─ Lazy-load GLTFExporter.js (if not cached)
      ├─ exporter.parse(currentModel, binary: true)
      ├─ Create Blob (application/octet-stream)
      └─ Trigger download: {modelKey}_custom.glb
```

The export preserves all applied fabric textures and material modifications in the output GLB file.

---

## Camera & Interaction System

The application uses a custom spherical coordinate orbit camera:

| Action | Control | Behavior |
|--------|---------|----------|
| **Orbit** | Left-drag on canvas | Modifies `θ` (azimuth) and `φ` (elevation) |
| **Pan** | Right-drag on canvas | Moves `target` vector along camera-relative right/up axes |
| **Zoom** | Scroll wheel | Adjusts `r` (radius), clamped to `[0.3, 30]` |
| **Apply fabric** | Click swatch | Applies to all checked parts |
| **Drag fabric** | Mousedown on swatch → drag to canvas | Applies to specific raycast-hit part |

**Render loop optimization:**
The render loop uses a dirty-flag pattern — `renderer.render()` only executes when `_dirty = true`, which is set by any state change (camera move, material update, model load). This prevents unnecessary GPU work during idle periods.

---

## Deployment

### Vercel (Production)

The project is configured for zero-config Vercel deployment:

1. Push to your Git repository connected to Vercel
2. Set the `GEMINI_API_KEY` environment variable in Vercel project settings
3. Vercel automatically:
   - Serves `index.html` as a static file
   - Deploys `api/generate.ts` as a serverless function
   - Applies the SPA rewrite rule from `vercel.json`

The `vercel.json` configuration:
```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

### Without Vercel

The frontend works standalone — just serve `index.html` from any static file server. The AI rendering feature requires the `/api/generate` endpoint, but the app gracefully degrades by showing a captured screenshot when the API is unavailable.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes (for AI rendering) | Google Gemini API key from [Google AI Studio](https://aistudio.google.com/) |

---

## Project Structure

```
custom_assets_pipeline/
├── index.html          # Single-file SPA (HTML + CSS + JS) — the entire frontend
│                       #   ├── <style> — Full CSS design system (DM Sans/Serif typography)
│                       #   ├── <body>  — Three-panel layout (fabric library | 3D viewport | controls)
│                       #   └── <script>— Complete application logic (~1700 lines)
│                       #       ├── Constants & fabric data (~280 lines)
│                       #       ├── Material application pipeline (~110 lines)
│                       #       ├── Drag & drop system (~100 lines)
│                       #       ├── Slider handlers (~50 lines)
│                       #       ├── Mesh list UI (~70 lines)
│                       #       ├── GLB processing (~150 lines)
│                       #       ├── Model switching & snapshots (~100 lines)
│                       #       ├── Fabric library UI builder (~60 lines)
│                       #       ├── Room view system (~200 lines)
│                       #       ├── AI render pipeline (~100 lines)
│                       #       ├── GLB export (~20 lines)
│                       #       └── Three.js initialization (~100 lines)
│
├── api/
│   └── generate.ts     # Vercel serverless function — Gemini image generation endpoint
│                       #   ├── PRODUCT_PROMPT — Showroom-style product render prompt
│                       #   ├── ROOM_PROMPT — Interior photography render prompt
│                       #   └── handler() — POST endpoint, routes to appropriate Gemini model
│
├── package.json        # Dependencies: @google/genai, typescript, @types/node
├── tsconfig.json       # TypeScript config: ES2022, CommonJS modules
├── vercel.json         # Vercel SPA rewrite rules
└── README.md           # This file
```

---

## Local Development

### Prerequisites

- Node.js ≥ 18
- npm

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd custom_assets_pipeline

# Install dependencies (needed for the API function)
npm install

# Serve the frontend locally (any static server works)
npx serve .
# or
python3 -m http.server 8000
```

### Running with AI Rendering

To test the AI rendering locally, you need the Vercel CLI:

```bash
# Install Vercel CLI
npm i -g vercel

# Set your Gemini API key
export GEMINI_API_KEY=your_key_here

# Run with serverless functions
vercel dev
```

> **Note:** Without the API endpoint, the Render button will capture and display a high-quality screenshot of the 3D scene instead of generating an AI render. All other features (fabric application, room view, export) work fully offline.

---

## External Asset Dependencies

| Asset | Source | Format |
|-------|--------|--------|
| Chair model | `chair_split.glb` on Supabase | GLB (Draco-compressed) |
| Sofa model | `sofa.glb` on Supabase | GLB (Draco-compressed) |
| Room model | `room.glb` on Supabase | GLB |
| MityLite swatch images | `fabrics.mityinc.com` | JPEG |
| Douglass swatch images | Supabase bucket | JPEG |
| Wood finish images | Supabase bucket | JPEG |
| PBR normal/roughness maps | Poly Haven API + Supabase fallback | JPEG/WebP |
| Three.js + add-ons | cdnjs / jsDelivr CDN | JavaScript |
| Draco decoder | gstatic.com | WASM + JS |
| Fonts | Google Fonts | CSS |

---

## Key Design Decisions

1. **Single-file frontend** — The entire frontend lives in one `index.html` file. This eliminates build steps, enables instant deployment, and keeps the project dead simple to maintain. The tradeoff is a larger file (~111KB), but it's served as a single HTTP request with no dependency waterfall.

2. **Dirty-flag render loop** — Instead of rendering every frame at 60fps, the render loop only draws when `_dirty = true`. This dramatically reduces GPU usage when the user isn't interacting.

3. **Material snapshot system** — When switching between chair/sofa or entering room view, the current material state is serialized via `greyMat.clone()` and restored on re-entry. This ensures fabric selections persist across all view modes.

4. **Multi-source texture fallback** — PBR textures first try Poly Haven (high quality, free), then fall back to pre-hosted Supabase textures. This ensures the app works even if one CDN is down.

5. **Spatial mesh naming** — Instead of relying on arbitrary mesh names from the 3D modeling tool, the system uses bounding-box heuristics (relative Y/X/Z position, volume ratio, flatness) to automatically label parts as "Backrest", "Seat Cushion", "Armrest", etc.

6. **Dual AI model strategy** — Product renders use a lighter/cheaper Gemini model since they only need to place one object in a scene. Room renders use a more capable model because they need to preserve complex spatial layouts and multiple textures simultaneously.
]]>
