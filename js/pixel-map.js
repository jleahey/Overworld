// ============================================================================
// Overworld — 16-Bit Cartoon Pixel-Art Map Renderer (OpenFreeMap + Esri Fallback)
// ============================================================================

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const FALLBACK_TILE_TEMPLATE = 'https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf';

const GRID = 64;
const PAD = 2;
const BUF = GRID + PAD * 2; // 68x68 padded raster buffer prevents tile-edge seams
const TILE_PX = 256;
const MAX_CACHE = 64;

const T_LAND = 1;
const T_FOREST = 2;
const T_TOWN = 3;
const T_WATER = 4;
const T_SAND = 5;
const T_ICE = 6;
const T_ROAD = 7;
const T_BORDER = 8;

// RGB helper for fast ImageData writes
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const PALETTES = {
  light: {
    coastInk: rgb('#4b6580'),
    shallows: rgb('#cbe4f5'),
    waterDeep: rgb('#a8cde8'),
    waterWave: rgb('#b9d9f0'),
    meadowA: rgb('#dce8cb'),
    meadowB: rgb('#d3e1c0'),
    forestA: rgb('#bdd4ae'),
    forestB: rgb('#acc69c'),
    town: rgb('#e5dccb'),
    sand: rgb('#efe2b8'),
    ice: rgb('#eff6fb'),
    road: rgb('#c9bca6'),
    border: rgb('#7c8c9e'),
    mtnSnow: rgb('#ffffff'),
    mtnLight: rgb('#9e978e'),
    mtnShade: rgb('#7a746c'),
    mtnInk: rgb('#475261'),
    labelFill: '#243447',
    labelHalo: '#f8fafc',
    pinFill: '#ffffff',
    pinStroke: '#3b526b',
  },
  dark: {
    coastInk: rgb('#46688c'),
    shallows: rgb('#234366'),
    waterDeep: rgb('#152a42'),
    waterWave: rgb('#1b3552'),
    meadowA: rgb('#22332d'),
    meadowB: rgb('#1e2e28'),
    forestA: rgb('#1b2d26'),
    forestB: rgb('#15241f'),
    town: rgb('#2c3442'),
    sand: rgb('#383428'),
    ice: rgb('#435669'),
    road: rgb('#3b4656'),
    border: rgb('#5a6d85'),
    mtnSnow: rgb('#dbe7f3'),
    mtnLight: rgb('#616d80'),
    mtnShade: rgb('#434d5e'),
    mtnInk: rgb('#161f2c'),
    labelFill: '#dbe7f3',
    labelHalo: '#0f1622',
    pinFill: '#f8fafc',
    pinStroke: '#334e68',
  },
};

const MTN_SPRITE = [
  '...S...',
  '..SSD..',
  '.LSSDD.',
  'LLLSDDD',
  'IIIIIII',
];

let mvtLibsPromise = null;
let templatePromise = null;

function loadMvtLibs() {
  if (!mvtLibsPromise) {
    mvtLibsPromise = Promise.all([
      import('https://esm.sh/pbf@4.0.1'),
      import('https://esm.sh/@mapbox/vector-tile@2.0.3'),
    ]).then(([pbfMod, vtMod]) => ({
      Pbf: pbfMod.default || pbfMod.Pbf,
      VectorTile: vtMod.VectorTile,
    }));
  }
  return mvtLibsPromise;
}

function loadTileTemplate() {
  if (!templatePromise) {
    templatePromise = fetch(TILEJSON_URL, { signal: AbortSignal.timeout(5000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => (Array.isArray(json?.tiles) && json.tiles[0] ? json.tiles[0] : FALLBACK_TILE_TEMPLATE))
      .catch(() => FALLBACK_TILE_TEMPLATE);
  }
  return templatePromise;
}

function wrapCoords(coords) {
  const n = 1 << coords.z;
  const wx = ((coords.x % n) + n) % n;
  return { z: coords.z, x: wx, y: coords.y, valid: coords.y >= 0 && coords.y < n };
}

function extractLayers(vt) {
  const wanted = ['landcover', 'park', 'landuse', 'water', 'waterway', 'transportation', 'boundary', 'mountain_peak', 'place'];
  const out = {};
  for (const name of wanted) {
    const layer = vt.layers[name];
    if (!layer) continue;
    const feats = [];
    for (let i = 0; i < layer.length; i += 1) {
      const f = layer.feature(i);
      feats.push({
        type: f.type,
        extent: f.extent || 4096,
        properties: f.properties,
        geometry: f.loadGeometry(),
      });
    }
    out[name] = feats;
  }
  return out;
}

// ============================================================================
// MVT Rasterizer & 16-Bit Cartoon Pixel Shader
// ============================================================================

function traceRings(ctx, geom, scale) {
  ctx.beginPath();
  for (const ring of geom) {
    if (!ring.length) continue;
    ctx.moveTo(ring[0].x * scale + PAD, ring[0].y * scale + PAD);
    for (let i = 1; i < ring.length; i += 1) {
      ctx.lineTo(ring[i].x * scale + PAD, ring[i].y * scale + PAD);
    }
  }
}

function rasterizeMask(maskCtx, features, filterFn, mode, grid, targetCode, opts = {}) {
  if (!features?.length) return;
  maskCtx.clearRect(0, 0, BUF, BUF);
  maskCtx.fillStyle = '#000';
  maskCtx.strokeStyle = '#000';
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  if (opts.lineWidth) maskCtx.lineWidth = opts.lineWidth;

  let drawn = false;
  for (const f of features) {
    if (filterFn && !filterFn(f.properties, f.type)) continue;
    const scale = GRID / f.extent;
    traceRings(maskCtx, f.geometry, scale);
    if (mode === 'fill') {
      maskCtx.closePath();
      maskCtx.fill('nonzero');
    } else {
      maskCtx.stroke();
    }
    drawn = true;
  }

  if (!drawn) return;
  const pixels = maskCtx.getImageData(0, 0, BUF, BUF).data;
  for (let i = 0; i < BUF * BUF; i += 1) {
    if (pixels[i * 4 + 3] >= 96) {
      if (opts.skipWater && grid[i] === T_WATER) continue;
      grid[i] = targetCode;
    }
  }
}

function buildTerrainGrid(layers, maskCtx, zoom) {
  const grid = new Uint8Array(BUF * BUF);
  grid.fill(T_LAND);

  const forestClasses = new Set(['wood', 'forest', 'grass', 'wetland']);
  rasterizeMask(
    maskCtx,
    layers.landcover,
    (p, t) => t === 3 && forestClasses.has(p.class),
    'fill',
    grid,
    T_FOREST,
  );
  rasterizeMask(maskCtx, layers.park, (_, t) => t === 3, 'fill', grid, T_FOREST);
  rasterizeMask(maskCtx, layers.landcover, (p, t) => t === 3 && p.class === 'sand', 'fill', grid, T_SAND);
  rasterizeMask(
    maskCtx,
    layers.landcover,
    (p, t) => t === 3 && (p.class === 'ice' || p.class === 'glacier'),
    'fill',
    grid,
    T_ICE,
  );

  const townClasses = new Set(['residential', 'suburb', 'commercial', 'industrial']);
  rasterizeMask(
    maskCtx,
    layers.landuse,
    (p, t) => t === 3 && townClasses.has(p.class),
    'fill',
    grid,
    T_TOWN,
  );

  rasterizeMask(maskCtx, layers.water, (_, t) => t === 3, 'fill', grid, T_WATER);
  rasterizeMask(
    maskCtx,
    layers.waterway,
    (p, t) => t === 2 && (p.class === 'river' || p.class === 'canal'),
    'stroke',
    grid,
    T_WATER,
    { lineWidth: 1.15 },
  );

  if (zoom >= 7) {
    const roadClasses = zoom <= 8 ? new Set(['motorway']) : new Set(['motorway', 'trunk']);
    rasterizeMask(
      maskCtx,
      layers.transportation,
      (p, t) => t === 2 && roadClasses.has(p.class),
      'stroke',
      grid,
      T_ROAD,
      { lineWidth: zoom <= 8 ? 0.7 : 0.78, skipWater: true },
    );
  }

  rasterizeMask(
    maskCtx,
    layers.boundary,
    (p, t) => t === 2 && (p.admin_level === 2 || p.admin_level === 4) && p.maritime !== 1,
    'stroke',
    grid,
    T_BORDER,
    { lineWidth: 1.0, skipWater: true },
  );

  return grid;
}

function setPixel(data, idx4, color) {
  data[idx4] = color[0];
  data[idx4 + 1] = color[1];
  data[idx4 + 2] = color[2];
  data[idx4 + 3] = 255;
}

function stampMountains(data, layers, coords, pal) {
  if (coords.z > 9 || !layers.mountain_peak?.length) return;
  for (const f of layers.mountain_peak) {
    if (f.type !== 1 || Number(f.properties.rank ?? 99) !== 1) continue;
    for (const ring of f.geometry) {
      for (const pt of ring) {
        if (pt.x < 0 || pt.x >= f.extent || pt.y < 0 || pt.y >= f.extent) continue;
        const mx = Math.round((pt.x / f.extent) * GRID);
        const my = Math.round((pt.y / f.extent) * GRID);
        for (let r = 0; r < MTN_SPRITE.length; r += 1) {
          const py = my + r - 2;
          if (py < 0 || py >= GRID) continue;
          const row = MTN_SPRITE[r];
          for (let c = 0; c < row.length; c += 1) {
            const ch = row[c];
            if (ch === '.') continue;
            const px = mx + c - 3;
            if (px < 0 || px >= GRID) continue;
            const color =
              ch === 'S'
                ? pal.mtnSnow
                : ch === 'L'
                  ? pal.mtnLight
                  : ch === 'D'
                    ? pal.mtnShade
                    : pal.mtnInk;
            setPixel(data, (py * GRID + px) * 4, color);
          }
        }
      }
    }
  }
}

function shadeTerrainToCanvas(grid, layers, coords, pal, smallCtx, outCtx) {
  const imgData = smallCtx.createImageData(GRID, GRID);
  const data = imgData.data;

  for (let py = 0; py < GRID; py += 1) {
    const by = py + PAD;
    const gy = coords.y * GRID + py;

    for (let px = 0; px < GRID; px += 1) {
      const bx = px + PAD;
      const gx = coords.x * GRID + px;
      const bi = by * BUF + bx;
      const cell = grid[bi];
      const idx4 = (py * GRID + px) * 4;

      const n = grid[bi - BUF];
      const s = grid[bi + BUF];
      const w = grid[bi - 1];
      const e = grid[bi + 1];

      if (cell === T_WATER) {
        const touchesLand = n !== T_WATER || s !== T_WATER || w !== T_WATER || e !== T_WATER;
        if (touchesLand) {
          setPixel(data, idx4, pal.shallows);
        } else {
          const isWave = gy % 7 === 0 && (((gx + gy * 3) % 13) + 13) % 13 < 2;
          setPixel(data, idx4, isWave ? pal.waterWave : pal.waterDeep);
        }
        continue;
      }

      const touchesWater = n === T_WATER || s === T_WATER || w === T_WATER || e === T_WATER;
      if (touchesWater) {
        setPixel(data, idx4, pal.coastInk);
        continue;
      }

      if (cell === T_ROAD) {
        setPixel(data, idx4, pal.road);
      } else if (cell === T_BORDER && (gx + gy) % 2 === 0) {
        setPixel(data, idx4, pal.border);
      } else if (cell === T_FOREST) {
        const treeAccent = (((gx * 5 + gy * 11) % 7) + 7) % 7 === 0;
        setPixel(data, idx4, treeAccent ? pal.forestB : pal.forestA);
      } else if (cell === T_TOWN) {
        setPixel(data, idx4, pal.town);
      } else if (cell === T_SAND) {
        setPixel(data, idx4, pal.sand);
      } else if (cell === T_ICE) {
        setPixel(data, idx4, pal.ice);
      } else {
        const tuft = (((gx * 7 + gy * 13) % 19) + 19) % 19 === 0;
        setPixel(data, idx4, tuft ? pal.meadowB : pal.meadowA);
      }
    }
  }

  stampMountains(data, layers, coords, pal);

  smallCtx.putImageData(imgData, 0, 0);
  outCtx.imageSmoothingEnabled = false;
  outCtx.clearRect(0, 0, TILE_PX, TILE_PX);
  outCtx.drawImage(smallCtx.canvas, 0, 0, TILE_PX, TILE_PX);
}

// ============================================================================
// Esri Keyless Pixel-Shader Fallback
// ============================================================================

function drawEsriFallbackTile(coords, isDark, smallCtx, outCtx, isCancelled) {
  const w = wrapCoords(coords);
  if (!w.valid) return;
  const pal = isDark ? PALETTES.dark : PALETTES.light;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (isCancelled()) return;
    smallCtx.clearRect(0, 0, GRID, GRID);
    smallCtx.drawImage(img, 0, 0, GRID, GRID);
    const frame = smallCtx.getImageData(0, 0, GRID, GRID);
    const px = frame.data;

    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      let out;
      if (b > r + 14 && b > g + 4) {
        out = pal.waterDeep;
      } else if (g > r + 8 && g >= b) {
        out = g < 190 ? pal.forestA : pal.meadowA;
      } else if (r > 232 && g > 232 && b > 232) {
        out = isDark ? pal.town : pal.ice;
      } else {
        out = pal.town;
      }
      px[i] = out[0];
      px[i + 1] = out[1];
      px[i + 2] = out[2];
    }

    smallCtx.putImageData(frame, 0, 0);
    outCtx.imageSmoothingEnabled = false;
    outCtx.clearRect(0, 0, TILE_PX, TILE_PX);
    outCtx.drawImage(smallCtx.canvas, 0, 0, TILE_PX, TILE_PX);
  };
  img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${w.z}/${w.y}/${w.x}`;
}

// ============================================================================
// Cartoon City / State Label Layer (Rendered ABOVE Doppler Radar)
// ============================================================================

function drawLabelsToCanvas(layers, coords, pal, ctx) {
  ctx.clearRect(0, 0, TILE_PX, TILE_PX);
  const places = layers.place;
  if (!places?.length) return;

  const maxRank = coords.z <= 6 ? 7 : coords.z <= 8 ? 10 : 14;
  const candidates = [];
  const seenNames = new Set();

  for (const f of places) {
    const cls = f.properties.class;
    if (cls !== 'country' && cls !== 'state' && cls !== 'city' && cls !== 'town') continue;
    const rank = Number(f.properties.rank ?? 99);
    if (rank > maxRank) continue;
    const rawName = f.properties['name:en'] || f.properties['name:latin'] || f.properties.name;
    if (!rawName) continue;
    const pt = f.geometry?.[0]?.[0];
    if (!pt || pt.x < 0 || pt.x >= f.extent || pt.y < 0 || pt.y >= f.extent) continue;

    const text = cls === 'country' || cls === 'state' ? String(rawName).toUpperCase() : String(rawName);
    if (seenNames.has(text)) continue;
    seenNames.add(text);
    candidates.push({
      cls,
      rank,
      text,
      x: (pt.x / f.extent) * TILE_PX,
      y: (pt.y / f.extent) * TILE_PX,
    });
  }

  candidates.sort((a, b) => a.rank - b.rank);

  ctx.font = '800 10.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.2;

  const placedBoxes = [];
  let count = 0;

  for (const item of candidates) {
    if (count >= 8) break;
    const width = ctx.measureText(item.text).width;
    const halfW = width / 2;
    const tx = Math.max(halfW + 6, Math.min(TILE_PX - halfW - 6, item.x));
    const offsetY = item.cls === 'city' || item.cls === 'town' ? -8 : 0;
    const ty = Math.max(12, Math.min(TILE_PX - 10, item.y + offsetY));

    const box = { l: tx - halfW - 4, r: tx + halfW + 4, t: ty - 8, b: ty + 8 };
    const overlaps = placedBoxes.some(
      (b) => !(box.r < b.l || box.l > b.r || box.b < b.t || box.t > b.b),
    );
    if (overlaps) continue;
    placedBoxes.push(box);
    count += 1;

    if (item.cls === 'city' || item.cls === 'town') {
      const px = Math.max(3, Math.min(TILE_PX - 7, Math.round(item.x) - 2));
      const py = Math.max(3, Math.min(TILE_PX - 7, Math.round(item.y) - 2));
      ctx.fillStyle = pal.pinStroke;
      ctx.fillRect(px - 1, py - 1, 6, 6);
      ctx.fillStyle = pal.pinFill;
      ctx.fillRect(px, py, 4, 4);
    }

    ctx.strokeStyle = pal.labelHalo;
    ctx.strokeText(item.text, tx, ty);
    ctx.fillStyle = pal.labelFill;
    ctx.fillText(item.text, tx, ty);
  }
}

// ============================================================================
// Public Factory: Leaflet GridLayers + Live Dark Mode Switch
// ============================================================================

export function createCartoonPixelMapLayers(L, initialDark = false) {
  let isDark = initialDark;
  const tileCache = new Map();

  // Shared synchronous scratch canvases (used after async tile decode completes)
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = BUF;
  maskCanvas.height = BUF;
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = GRID;
  smallCanvas.height = GRID;
  const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });

  function getCachedTile(coords) {
    const w = wrapCoords(coords);
    if (!w.valid) return Promise.resolve(null);
    const key = `${w.z}/${w.x}/${w.y}`;

    if (tileCache.has(key)) {
      const hit = tileCache.get(key);
      tileCache.delete(key);
      tileCache.set(key, hit);
      return hit;
    }

    const promise = (async () => {
      const [{ Pbf, VectorTile }, template] = await Promise.all([loadMvtLibs(), loadTileTemplate()]);
      const url = template
        .replace('{z}', String(w.z))
        .replace('{x}', String(w.x))
        .replace('{y}', String(w.y));
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Vector tile error (${res.status})`);
      const buf = await res.arrayBuffer();
      const vt = new VectorTile(new Pbf(buf));
      return extractLayers(vt);
    })();

    tileCache.set(key, promise);
    if (tileCache.size > MAX_CACHE) {
      const oldest = tileCache.keys().next().value;
      tileCache.delete(oldest);
    }

    promise.catch(() => {
      if (tileCache.get(key) === promise) tileCache.delete(key);
    });

    return promise;
  }

  const TerrainGridLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = TILE_PX;
      tile.height = TILE_PX;
      tile.className = 'pixel-map-tile';
      const ctx = tile.getContext('2d');
      let cancelled = false;

      const pal = isDark ? PALETTES.dark : PALETTES.light;
      ctx.fillStyle = isDark ? '#152a42' : '#a8cde8';
      ctx.fillRect(0, 0, TILE_PX, TILE_PX);

      const w = wrapCoords(coords);
      getCachedTile(coords)
        .then((layers) => {
          if (cancelled || !layers) {
            done(null, tile);
            return;
          }
          const grid = buildTerrainGrid(layers, maskCtx, w.z);
          shadeTerrainToCanvas(grid, layers, w, pal, smallCtx, ctx);
          done(null, tile);
        })
        .catch(() => {
          if (!cancelled) {
            drawEsriFallbackTile(coords, isDark, smallCtx, ctx, () => cancelled);
          }
          done(null, tile);
        });

      tile._cancelPixelTile = () => {
        cancelled = true;
      };
      return tile;
    },
  });

  const LabelGridLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = TILE_PX;
      tile.height = TILE_PX;
      tile.className = 'pixel-label-tile';
      const ctx = tile.getContext('2d');
      let cancelled = false;

      const pal = isDark ? PALETTES.dark : PALETTES.light;
      const w = wrapCoords(coords);

      getCachedTile(coords)
        .then((layers) => {
          if (!cancelled && layers) {
            drawLabelsToCanvas(layers, w, pal, ctx);
          }
          done(null, tile);
        })
        .catch(() => {
          done(null, tile);
        });

      tile._cancelPixelTile = () => {
        cancelled = true;
      };
      return tile;
    },
  });

  const baseLayer = new TerrainGridLayer({
    pane: 'pixelBase',
    minZoom: 3,
    maxZoom: 13,
    maxNativeZoom: 13,
  });

  const labelLayer = new LabelGridLayer({
    pane: 'pixelLabels',
    minZoom: 3,
    maxZoom: 13,
    maxNativeZoom: 13,
  });

  for (const layer of [baseLayer, labelLayer]) {
    layer.on('tileunload', (e) => {
      e.tile?._cancelPixelTile?.();
    });
  }

  return {
    baseLayer,
    labelLayer,
    setDarkMode(nextDark) {
      if (isDark === Boolean(nextDark)) return;
      isDark = Boolean(nextDark);
      baseLayer.redraw();
      labelLayer.redraw();
    },
  };
}
