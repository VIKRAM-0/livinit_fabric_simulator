import { tryLoadTex } from './engine.js';
// Static data: GLB urls, fabric catalogs, LIBRARY
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.

// ── S3 proxy ─────────────────────────────────────────────────────────────
// api/s3proxy.ts uses the key as-is (no implicit prefix) — every key below
// carries its own explicit top-level prefix:
//   'fabric_assets/'    — legacy assets reused read-only from the old app's
//                          bucket space (Room GLB, wood textures)
//   'fabric_assets_v2/' — this repo's own assets (product GLBs, the 14
//                          fabric series, Gemini-generated PBR maps)
export const SB = '/api/s3proxy?key=';

// ── GLB models ───────────────────────────────────────────────────────────
// Draco-compressed (see compress_draco.py). Decoding is already wired up in
// viewport.js, which hands the GLTFLoader a DRACOLoader pointed at the CDN
// decoder — nothing here needs to know the files are compressed.
export const CHAIR_GLB        = SB + 'fabric_assets_v2/glbs/chair.glb';
export const ACCENT_CHAIR_GLB = SB + 'fabric_assets_v2/glbs/accent_chair_fabric.glb';
export const SOFA_GLB         = SB + 'fabric_assets_v2/glbs/sofa.glb';
// Living Room GLB — unchanged, reused read-only from the old app's bucket space.
export const ROOM_GLB         = SB + 'fabric_assets/glbs/room_new.glb';
// Brand mark (white line-art house on transparent) — reused read-only from the
// old app's bucket space. White, so it must sit on a dark/coloured badge.
export const LOGO_URL         = SB + 'fabric_assets/logo.png';

export function getGLBUrl(key){return{chair:CHAIR_GLB,accent_chair:ACCENT_CHAIR_GLB,sofa:SOFA_GLB}[key]||null;}

export async function loadTexFirstSuccess(urls, isSrgb) {
  for(const url of urls) {
    try { const t = await tryLoadTex(url, isSrgb); if(t) return t; } catch(e){}
  }
  return null;
}

// ── Wood finish — untouched, same PolyHaven + Supabase-fallback pipeline the
// old app used (kept exactly as-is per instruction; not part of the Gemini
// PBR-map pipeline below). Swatch images + fallback maps stay on the old
// bucket location (read-only reuse).
export const POLY_API  = 'https://api.polyhaven.com/files/';
export const POLY_IDS  = { wood: 'wood_plank_05' };

export const WF = SB + 'fabric_assets/wood_texture/custom/';
export const CHAIR_WOOD = [
  { code:'ASHWOOD',   name:'Ashwood',   hex:'#c8a882', type:'wood', img: WF+'Ashwood.jpg'   },
  { code:'CASHEW',    name:'Cashew',    hex:'#b08d6b', type:'wood', img: WF+'Cashew.jpg'    },
  { code:'CIDER',     name:'Cider',     hex:'#8b5e3c', type:'wood', img: WF+'Cider.jpg'     },
  { code:'EBONY',     name:'Ebony',     hex:'#2c1f14', type:'wood', img: WF+'Ebony.jpg'     },
  { code:'ELMWOOD',   name:'Elmwood',   hex:'#a07850', type:'wood', img: WF+'Elmwood.jpg'   },
  { code:'KONA',      name:'Kona',      hex:'#5c3a1e', type:'wood', img: WF+'Kona.jpg'      },
  { code:'MINK',      name:'Mink',      hex:'#d0c0a8', type:'wood', img: WF+'Mink.jpg'      },
  { code:'SHORELINE', name:'Shoreline', hex:'#6e5840', type:'wood', img: WF+'Shoreline.jpg' },
].map(c=>({...c,vendor:'mity'}));

// ── PBR normal/roughness maps ───────────────────────────────────────────
// Wood keeps its old fallback. Every fabric series below is populated by the
// one-time Gemini generation script (scripts/generate-fabric-maps.mjs) —
// one normal + one roughness map per series, reused across every color in
// that series. `fabric`/`vinyl` are generic type-level aliases (pointing at
// Crypton's and Allante's generated maps respectively) used when an item has
// no `series` of its own (e.g. Fabric-Finder photo-analysis results, which
// only carry a Gemini-vision-detected `type`). The `fabric` alias points at
// Thalassa's maps (a woven-fabric weave) since the Crypton series was removed.
const FM = SB + 'fabric_assets_v2/fabric_maps/';
function seriesMaps(series) {
  const enc = encodeURIComponent(series);
  // Gemini image generation returns JPEG in practice — matches what the
  // generation script (scripts/generate-fabric-maps.mjs) actually uploads.
  return { norm: [FM+enc+'/normal.jpg'], rough: [FM+enc+'/roughness.jpg'] };
}
export const MATERIAL_MAPS = {
  wood: { norm: [SB+'fabric_assets/wood_texture/Normal.jpg', SB+'fabric_assets/wood_texture/Normal.webp'],
          rough:[SB+'fabric_assets/wood_texture/Roughness.jpg', SB+'fabric_assets/wood_texture/Roughness.webp'] },
  Allante: seriesMaps('Allante'), Bali: seriesMaps('Bali'), Carson: seriesMaps('Carson'),
  Chaise: seriesMaps('Chaise'), Cinema: seriesMaps('Cinema'),
  Heirloom: seriesMaps('Heirloom'), Linum: seriesMaps('Linum'), 'Milano Stitch': seriesMaps('Milano Stitch'),
  'Natural Linen': seriesMaps('Natural Linen'), Parlour: seriesMaps('Parlour'), Rivulet: seriesMaps('Rivulet'),
  'Rivulet Pattern': seriesMaps('Rivulet Pattern'), Twist: seriesMaps('Twist'),
  // Newly-added series (scraped from Ennis / Douglass). Kimono is Douglass
  // pattern 5316 ("7693"); its swatches were the douglassfabric.com colourways.
  Thalassa: seriesMaps('Thalassa'), Challenger: seriesMaps('Challenger'), Kimono: seriesMaps('Kimono'),
};
MATERIAL_MAPS.fabric = MATERIAL_MAPS.Thalassa;  // generic woven-fabric alias
MATERIAL_MAPS.vinyl  = MATERIAL_MAPS.Allante;   // generic vinyl alias

// ── Fabric series (fabric_assets_v2/fabrics/<Series>/<Color>.jpg) ───────
// Flat, vendor-agnostic library — all 14 series are available on all 3
// products (no per-product vendor split, unlike the old catalog). Material
// type per series is taken from actual vendor spec sheets (Ennis/Douglass/
// Momentum/Burch product pages), not name-based guessing.
const FSERIES = SB + 'fabric_assets_v2/fabrics/';
function seriesItems(seriesName, type, files) {
  const enc = s => encodeURIComponent(s);
  return files.map(([file, name]) => ({
    name, series: seriesName, type,
    img: FSERIES + enc(seriesName) + '/' + enc(file),
  }));
}

export const FABRIC_ALLANTE = seriesItems('Allante', 'vinyl', [
  ['Autumn Rain.jpg', 'Autumn Rain'],
  ['Birch.jpg', 'Birch'],
  ['Bleached Sand.jpg', 'Bleached Sand'],
  ['Blooming Dahlia.jpg', 'Blooming Dahlia'],
  ['Bright White.jpg', 'Bright White'],
  ['Chateau Grey.jpg', 'Chateau Grey'],
  ['Chocolate Sundae.jpg', 'Chocolate Sundae'],
  ['Cookie.jpg', 'Cookie'],
  ['Desert Sun.jpg', 'Desert Sun'],
  ['Eclipse.jpg', 'Eclipse'],
  ['Elephant.jpg', 'Elephant'],
  ['Flannel.jpg', 'Flannel'],
  ['Galaxy.jpg', 'Galaxy'],
  ['Garden Green.jpg', 'Garden Green'],
  ['Gibraltar.jpg', 'Gibraltar'],
  ['Ginger Spice.jpg', 'Ginger Spice'],
  ['Golden Kiwi.jpg', 'Golden Kiwi'],
  ['Granite.jpg', 'Granite'],
  ['Hawaiian Surf.jpg', 'Hawaiian Surf'],
  ['Ice.jpg', 'Ice'],
  ['Illusion.jpg', 'Illusion'],
  ['Ink Black.jpg', 'Ink Black'],
  ['Italian Rose.jpg', 'Italian Rose'],
  ['Ivory.jpg', 'Ivory'],
  ['Lagoon.jpg', 'Lagoon'],
  ['Malibu Blue.jpg', 'Malibu Blue'],
  ['Mist.jpg', 'Mist'],
  ['Mountain Sky.jpg', 'Mountain Sky'],
  ['Mystic Lilly.jpg', 'Mystic Lilly'],
  ['Nautical Blue.jpg', 'Nautical Blue'],
  ['Niagara Mist.jpg', 'Niagara Mist'],
  ['Oasis Green.jpg', 'Oasis Green'],
  ['Old Navy.jpg', 'Old Navy'],
  ['Pagoda.jpg', 'Pagoda'],
  ['Province Blue.jpg', 'Province Blue'],
  ['Purple Impulse.jpg', 'Purple Impulse'],
  ['Red Truffle.jpg', 'Red Truffle'],
  ['Regatta.jpg', 'Regatta'],
  ['Riverside.jpg', 'Riverside'],
  ['Sierra Brick.jpg', 'Sierra Brick'],
  ['Taupe Fawn.jpg', 'Taupe Fawn'],
  ['Thais Red.jpg', 'Thais Red'],
  ['Warm Smoke.jpg', 'Warm Smoke'],
  ['White Crush.jpg', 'White Crush'],
  ['Winter Green.jpg', 'Winter Green'],
]);

export const FABRIC_BALI = seriesItems('Bali', 'fabric', [
  ['Elephant.jpg', 'Elephant'],
  ['Flora.jpg', 'Flora'],
  ['Lava.jpg', 'Lava'],
  ['Mystical.jpg', 'Mystical'],
  ['Palm.jpg', 'Palm'],
  ['Pearl.jpg', 'Pearl'],
  ['Sumatra.jpg', 'Sumatra'],
  ['Teak.jpg', 'Teak'],
  ['Tidal.jpg', 'Tidal'],
]);

export const FABRIC_CARSON = seriesItems('Carson', 'vinyl', [
  ['carson_cv-airy.jpg', 'carson_cv-airy'],
  ['carson_cv-azure.jpg', 'carson_cv-azure'],
  ['carson_cv-bluff.jpg', 'carson_cv-bluff'],
  ['carson_cv-buck.jpg', 'carson_cv-buck'],
  ['carson_cv-fog.jpg', 'carson_cv-fog'],
  ['carson_cv-graphite.jpg', 'carson_cv-graphite'],
  ['carson_cv-roast.jpg', 'carson_cv-roast'],
  ['carson_cv-sage.jpg', 'carson_cv-sage'],
  ['carson_cv-shadow.jpg', 'carson_cv-shadow'],
  ['carson_cv-sterling.jpg', 'carson_cv-sterling'],
  ['carson_cv-stone.jpg', 'carson_cv-stone'],
]);

export const FABRIC_CHAISE = seriesItems('Chaise', 'vinyl', [
  ['Cocoa.jpg', 'Cocoa'],
  ['Driftwood.jpg', 'Driftwood'],
  ['Fiddlehead.jpg', 'Fiddlehead'],
  ['Parchment.jpg', 'Parchment'],
  ['Persimmon.jpg', 'Persimmon'],
  ['Slate Blue.jpg', 'Slate Blue'],
  ['Steel Grey.jpg', 'Steel Grey'],
]);

export const FABRIC_CINEMA = seriesItems('Cinema', 'fabric', [
  ['Apricot.jpg', 'Apricot'],
  ['Aquamarine.jpg', 'Aquamarine'],
  ['Chiffon.jpg', 'Chiffon'],
  ['Cove.jpg', 'Cove'],
  ['Garnet.jpg', 'Garnet'],
  ['Jungle.jpg', 'Jungle'],
  ['Koala.jpg', 'Koala'],
  ['Mauve.jpg', 'Mauve'],
  ['Pacific.jpg', 'Pacific'],
  ['Pine.jpg', 'Pine'],
  ['Pumice.jpg', 'Pumice'],
  ['Royal.jpg', 'Royal'],
  ['Sage.jpg', 'Sage'],
  ['Sienna.jpg', 'Sienna'],
]);

export const FABRIC_HEIRLOOM = seriesItems('Heirloom', 'fabric', [
  ['Autumn.jpg', 'Autumn'],
  ['Spring.jpg', 'Spring'],
  ['Summer.jpg', 'Summer'],
  ['Winter .jpg', 'Winter'],
]);

export const FABRIC_LINUM = seriesItems('Linum', 'vinyl', [
  ['Ash.jpg', 'Ash'],
  ['Cerulean.jpg', 'Cerulean'],
  ['Cherry.jpg', 'Cherry'],
  ['Chestnut.jpg', 'Chestnut'],
  ['Cotton.jpg', 'Cotton'],
  ['Denim.jpg', 'Denim'],
  ['Flax.jpg', 'Flax'],
  ['Gunmetal.jpg', 'Gunmetal'],
  ['Pewter.jpg', 'Pewter'],
  ['Raven.jpg', 'Raven'],
  ['Russet.jpg', 'Russet'],
  ['Sterling.jpg', 'Sterling'],
  ['bark.jpg', 'bark'],
]);

export const FABRIC_MILANO_STITCH = seriesItems('Milano Stitch', 'vinyl', [
  ['Alpine.jpg', 'Alpine'],
  ['Aquamarine.jpg', 'Aquamarine'],
  ['Bamboo.jpg', 'Bamboo'],
  ['Bark.jpg', 'Bark'],
  ['Blackberry.jpg', 'Blackberry'],
  ['Emerald.jpg', 'Emerald'],
  ['Fiesta.jpg', 'Fiesta'],
  ['Fossil.jpg', 'Fossil'],
  ['Gulf.jpg', 'Gulf'],
  ['Harvest.jpg', 'Harvest'],
  ['Journey.jpg', 'Journey'],
  ['Lilac.jpg', 'Lilac'],
  ['River.jpg', 'River'],
  ['Sailor.jpg', 'Sailor'],
  ['Slate.jpg', 'Slate'],
  ['Stone.jpg', 'Stone'],
  ['Wheat.jpg', 'Wheat'],
]);

export const FABRIC_NATURAL_LINEN = seriesItems('Natural Linen', 'vinyl', [
  ['Bamboo.jpg', 'Bamboo'],
  ['Burnt Orange.jpg', 'Burnt Orange'],
  ['Butter.jpg', 'Butter'],
  ['Cayenne.jpg', 'Cayenne'],
  ['Charcoal.jpg', 'Charcoal'],
  ['Ganache.jpg', 'Ganache'],
  ['Gray.jpg', 'Gray'],
  ['Haystack.jpg', 'Haystack'],
  ['Moss.jpg', 'Moss'],
  ['Navy.jpg', 'Navy'],
  ['Pearl.jpg', 'Pearl'],
  ['Potters Clay.jpg', 'Potters Clay'],
  ['Storm.jpg', 'Storm'],
  ['Sunset.jpg', 'Sunset'],
  ['Tan.jpg', 'Tan'],
]);

export const FABRIC_PARLOUR = seriesItems('Parlour', 'fabric', [
  ['Biscotti.jpg', 'Biscotti'],
  ['Butterscotch.jpg', 'Butterscotch'],
  ['Cornflower.jpg', 'Cornflower'],
  ['Dove.jpg', 'Dove'],
  ['Kiwi.jpg', 'Kiwi'],
  ['Nautical.jpg', 'Nautical'],
  ['Ruby.jpg', 'Ruby'],
  ['Sahara.jpg', 'Sahara'],
  ['Seabreeze.jpg', 'Seabreeze'],
  ['Stratus.jpg', 'Stratus'],
]);

export const FABRIC_RIVULET = seriesItems('Rivulet', 'vinyl', [
  ['Apricot.jpg', 'Apricot'],
  ['Butterscotch.jpg', 'Butterscotch'],
  ['Capri.jpg', 'Capri'],
  ['Chai.jpg', 'Chai'],
  ['Charcoal.jpg', 'Charcoal'],
  ['Clover.jpg', 'Clover'],
  ['Dark Roast.jpg', 'Dark Roast'],
  ['Eucalyptus.jpg', 'Eucalyptus'],
  ['Fog.jpg', 'Fog'],
  ['Grapefruit.jpg', 'Grapefruit'],
  ['Leaf.jpg', 'Leaf'],
  ['Mesa.jpg', 'Mesa'],
  ['Mist.jpg', 'Mist'],
  ['Mushroom.jpg', 'Mushroom'],
  ['Navy.jpg', 'Navy'],
  ['Olive.jpg', 'Olive'],
  ['Pebble.jpg', 'Pebble'],
  ['Pistachio.jpg', 'Pistachio'],
  ['Pool.jpg', 'Pool'],
  ['River.jpg', 'River'],
  ['Scarlet.jpg', 'Scarlet'],
  ['Sepia.jpg', 'Sepia'],
  ['Stone.jpg', 'Stone'],
  ['Storm Cloud.jpg', 'Storm Cloud'],
]);

export const FABRIC_RIVULET_PATTERN = seriesItems('Rivulet Pattern', 'fabric', [
  ['Beach.jpg', 'Beach'],
  ['Cayman.jpg', 'Cayman'],
  ['Clay.jpg', 'Clay'],
  ['Dusty Rose.jpg', 'Dusty Rose'],
  ['Fossil.jpg', 'Fossil'],
  ['Goldenrod.jpg', 'Goldenrod'],
  ['Hudson.jpg', 'Hudson'],
  ['Magma.jpg', 'Magma'],
  ['Marble.jpg', 'Marble'],
  ['Mist.jpg', 'Mist'],
  ['Peacock.jpg', 'Peacock'],
  ['Quartz.jpg', 'Quartz'],
  ['Seafoam.jpg', 'Seafoam'],
]);

export const FABRIC_TWIST = seriesItems('Twist', 'vinyl', [
  ['Bamboo.jpg', 'Bamboo'],
  ['Burlap.jpg', 'Burlap'],
  ['Cadmium.jpg', 'Cadmium'],
  ['Chambray.jpg', 'Chambray'],
  ['Cotton.jpg', 'Cotton'],
  ['Flannel.jpg', 'Flannel'],
  ['Gauze.jpg', 'Gauze'],
  ['Grasscloth.jpg', 'Grasscloth'],
  ['Hemp.jpg', 'Hemp'],
  ['Henna.jpg', 'Henna'],
  ['Indigo.jpg', 'Indigo'],
  ['Kona.jpg', 'Kona'],
  ['Linen.jpg', 'Linen'],
  ['Oxford.jpg', 'Oxford'],
  ['Parchment.jpg', 'Parchment'],
  ['Raffia.jpg', 'Raffia'],
  ['Sari.jpg', 'Sari'],
  ['Scuba.jpg', 'Scuba'],
  ['Sheer.jpg', 'Sheer'],
  ['Spindel.jpg', 'Spindel'],
  ['Tapestry.jpg', 'Tapestry'],
  ['Tobacco.jpg', 'Tobacco'],
  ['Worsted.jpg', 'Worsted'],
]);

// ── Newly-added series (scraped Jul 2026) ────────────────────────────────
// Thalassa: Ennis Crypton performance chenille (woven) → fabric.
// Challenger: Ennis marine-grade vinyl / faux-leather → vinyl.
// Kimono: Douglass pattern 5316 (a.k.a. "7693"), woven linen-look → fabric.
export const FABRIC_THALASSA = seriesItems('Thalassa', 'fabric', [
  ['Alabaster.jpg', 'Alabaster'],
  ['Baltic.jpg', 'Baltic'],
  ['Carbon.jpg', 'Carbon'],
  ['Forest.jpg', 'Forest'],
  ['Pebble.jpg', 'Pebble'],
  ['Sky.jpg', 'Sky'],
]);

export const FABRIC_CHALLENGER = seriesItems('Challenger', 'vinyl', [
  ['Amber.jpg', 'Amber'],
  ['Bark.jpg', 'Bark'],
  ['Champagne.jpg', 'Champagne'],
  ['Charcoal.jpg', 'Charcoal'],
  ['Cherry Red.jpg', 'Cherry Red'],
  ['Chestnut.jpg', 'Chestnut'],
  ['Chinchilla.jpg', 'Chinchilla'],
  ['Chocolate.jpg', 'Chocolate'],
  ['Citron.jpg', 'Citron'],
  ['Cream.jpg', 'Cream'],
  ['Deep Teal.jpg', 'Deep Teal'],
  ['Denim Blue.jpg', 'Denim Blue'],
  ['Diamond.jpg', 'Diamond'],
  ['Dove.jpg', 'Dove'],
  ['Earth.jpg', 'Earth'],
  ['Fog.jpg', 'Fog'],
  ['Garnet.jpg', 'Garnet'],
  ['Lagoon.jpg', 'Lagoon'],
  ['Meadow.jpg', 'Meadow'],
  ['Midnight Blue.jpg', 'Midnight Blue'],
  ['Mocha.jpg', 'Mocha'],
  ['Mystic White.jpg', 'Mystic White'],
  ['Naval Blue.jpg', 'Naval Blue'],
  ['Pearl.jpg', 'Pearl'],
  ['Plum.jpg', 'Plum'],
  ['Pumpkin Spice.jpg', 'Pumpkin Spice'],
  ['Raven.jpg', 'Raven'],
  ['Royal.jpg', 'Royal'],
  ['Seagull.jpg', 'Seagull'],
  ['Slate.jpg', 'Slate'],
  ['Smokey Blue.jpg', 'Smokey Blue'],
  ['Spa.jpg', 'Spa'],
  ['Spring.jpg', 'Spring'],
  ['Steel.jpg', 'Steel'],
  ['Tan.jpg', 'Tan'],
  ['Taupe.jpg', 'Taupe'],
  ['Tobacco.jpg', 'Tobacco'],
  ['Vanilla.jpg', 'Vanilla'],
  ['White Cap.jpg', 'White Cap'],
  ['Wine.jpg', 'Wine'],
]);

export const FABRIC_KIMONO = seriesItems('Kimono', 'fabric', [
  ['Abyss.jpg', 'Abyss'],
  ['Agave.jpg', 'Agave'],
  ['Aluminum.jpg', 'Aluminum'],
  ['Anise.jpg', 'Anise'],
  ['Aragon.jpg', 'Aragon'],
  ['Bayou.jpg', 'Bayou'],
  ['Bluff.jpg', 'Bluff'],
  ['Breeze.jpg', 'Breeze'],
  ['Bride.jpg', 'Bride'],
  ['Caperberry.jpg', 'Caperberry'],
  ['Chateau.jpg', 'Chateau'],
  ['Cinnamon.jpg', 'Cinnamon'],
  ['Cirrus.jpg', 'Cirrus'],
  ['Cordovan.jpg', 'Cordovan'],
  ['Darjeeling.jpg', 'Darjeeling'],
  ['Deep Sea.jpg', 'Deep Sea'],
  ['Driftwood.jpg', 'Driftwood'],
  ['Dune.jpg', 'Dune'],
  ['Dusk.jpg', 'Dusk'],
  ['Ecru.jpg', 'Ecru'],
  ['Excalibur.jpg', 'Excalibur'],
  ['Gamay.jpg', 'Gamay'],
  ['Gargoyle.jpg', 'Gargoyle'],
  ['Geyser.jpg', 'Geyser'],
  ['Harbor.jpg', 'Harbor'],
  ['Jaipur.jpg', 'Jaipur'],
  ['Kernal.jpg', 'Kernal'],
  ['Latte.jpg', 'Latte'],
  ['Laurel.jpg', 'Laurel'],
  ['Magnet.jpg', 'Magnet'],
  ['Parisian.jpg', 'Parisian'],
  ['Pistachio.jpg', 'Pistachio'],
  ['Purple Haze.jpg', 'Purple Haze'],
  ['Siren.jpg', 'Siren'],
  ['Storm.jpg', 'Storm'],
  ['Stratus.jpg', 'Stratus'],
  ['Thyme.jpg', 'Thyme'],
  ['Waikiki.jpg', 'Waikiki'],
  ['Zinc.jpg', 'Zinc'],
]);

export const ALL_SERIES = [
  { group:'Allante', vclass:'vinyl', items: FABRIC_ALLANTE },
  { group:'Bali', vclass:'fabric', items: FABRIC_BALI },
  { group:'Carson', vclass:'vinyl', items: FABRIC_CARSON },
  { group:'Challenger', vclass:'vinyl', items: FABRIC_CHALLENGER },
  { group:'Chaise', vclass:'vinyl', items: FABRIC_CHAISE },
  { group:'Cinema', vclass:'fabric', items: FABRIC_CINEMA },
  { group:'Heirloom', vclass:'fabric', items: FABRIC_HEIRLOOM },
  { group:'Kimono', vclass:'fabric', items: FABRIC_KIMONO },
  { group:'Linum', vclass:'vinyl', items: FABRIC_LINUM },
  { group:'Milano Stitch', vclass:'vinyl', items: FABRIC_MILANO_STITCH },
  { group:'Natural Linen', vclass:'vinyl', items: FABRIC_NATURAL_LINEN },
  { group:'Parlour', vclass:'fabric', items: FABRIC_PARLOUR },
  { group:'Rivulet', vclass:'vinyl', items: FABRIC_RIVULET },
  { group:'Rivulet Pattern', vclass:'fabric', items: FABRIC_RIVULET_PATTERN },
  { group:'Thalassa', vclass:'fabric', items: FABRIC_THALASSA },
  { group:'Twist', vclass:'vinyl', items: FABRIC_TWIST },
];

// Mutable — items pushed here by the Fabric Finder's photo-analysis flow;
// shared by reference across all 3 products' "My Fabrics" group.
export const CUSTOM_FABRIC_ITEMS = [];

function productLibrary() {
  return [
    { group:'My Fabrics', vendor:'Uploaded', vclass:'custom', items: CUSTOM_FABRIC_ITEMS },
    { group:'Faux Wood Finishes', vendor:'MityLite Sierra', vclass:'mity', items: CHAIR_WOOD },
    ...ALL_SERIES.map(s => ({ group: s.group, vendor: '', vclass: s.vclass, items: s.items })),
  ];
}

export const LIBRARY = {
  chair:        productLibrary(),
  accent_chair: productLibrary(),
  sofa:         productLibrary(),
};
