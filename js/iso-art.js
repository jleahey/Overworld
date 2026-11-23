// ============================================================================
// Overworld — True 2:1 Isometric SVG Art Engine
// ============================================================================

const WMO_LABELS = {
  0: 'Clear',
  1: 'Mostly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  56: 'Freezing Drizzle',
  57: 'Freezing Drizzle',
  61: 'Light Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  66: 'Freezing Rain',
  67: 'Freezing Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  77: 'Snow Grains',
  80: 'Light Showers',
  81: 'Rain Showers',
  82: 'Heavy Showers',
  85: 'Snow Showers',
  86: 'Heavy Snow Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Severe Storm',
};

export function classifyWeather(wmoCode, isDay = 1, tempF = 62, windMph = 6) {
  const code = Number(wmoCode ?? 0);
  let kind = 'clear';

  if (code === 0) kind = 'clear';
  else if (code === 1 || code === 2) kind = 'partly';
  else if (code === 3) kind = 'overcast';
  else if (code === 45 || code === 48) kind = 'fog';
  else if (code >= 51 && code <= 57) kind = 'drizzle';
  else if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) kind = 'rain';
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) kind = 'snow';
  else if (code >= 95) kind = 'storm';

  const label =
    WMO_LABELS[code] ||
    (kind === 'rain' ? 'Rain' : kind === 'snow' ? 'Snow' : kind === 'storm' ? 'Thunderstorm' : 'Cloudy');

  const isFreezing = Number(tempF) <= 32 || kind === 'snow' || code === 56 || code === 57 || code === 66 || code === 67;
  const isHot = Number(tempF) >= 86 && (kind === 'clear' || kind === 'partly');
  const isWindy = Number(windMph) >= 18;

  return {
    code,
    kind,
    label,
    isDay: Boolean(isDay),
    isFreezing,
    isHot,
    isWindy,
  };
}

// ============================================================================
// Exact 2:1 Axonometric Projection Primitives
// ============================================================================

export function createProjector(cx, cy, ux = 22, uy = 11, uz = 22) {
  return (x, y, z = 0) => [
    Math.round((cx + (x - y) * ux) * 10) / 10,
    Math.round((cy + (x + y) * uy - z * uz) * 10) / 10,
  ];
}

function pts(list) {
  return list.map(([px, py]) => `${px},${py}`).join(' ');
}

export function isoBox(proj, x, y, z, dx, dy, dz, palette, extraAttrs = '') {
  const top = pts([
    proj(x, y, z + dz),
    proj(x + dx, y, z + dz),
    proj(x + dx, y + dy, z + dz),
    proj(x, y + dy, z + dz),
  ]);
  const left = pts([
    proj(x, y + dy, z + dz),
    proj(x + dx, y + dy, z + dz),
    proj(x + dx, y + dy, z),
    proj(x, y + dy, z),
  ]);
  const right = pts([
    proj(x + dx, y + dy, z + dz),
    proj(x + dx, y, z + dz),
    proj(x + dx, y, z),
    proj(x + dx, y + dy, z),
  ]);

  const strokeAttr = palette.stroke
    ? ` stroke="${palette.stroke}" stroke-width="${palette.strokeWidth ?? 0.8}" stroke-linejoin="round"`
    : '';

  return `<g${extraAttrs}>
    <polygon points="${top}" fill="${palette.top}"${strokeAttr}/>
    <polygon points="${left}" fill="${palette.left}"${strokeAttr}/>
    <polygon points="${right}" fill="${palette.right}"${strokeAttr}/>
  </g>`;
}

export function isoPyramid(proj, x, y, z, dx, dy, dz, palette) {
  const apex = proj(x + dx / 2, y + dy / 2, z + dz);
  const fl = pts([apex, proj(x, y + dy, z), proj(x + dx, y + dy, z)]);
  const fr = pts([apex, proj(x + dx, y + dy, z), proj(x + dx, y, z)]);
  return `<g>
    <polygon points="${fl}" fill="${palette.left}" stroke-linejoin="round"/>
    <polygon points="${fr}" fill="${palette.right}" stroke-linejoin="round"/>
  </g>`;
}

export function isoQuadZ(proj, x, y, dx, dy, z, fill, opacity = 1) {
  const poly = pts([
    proj(x, y, z),
    proj(x + dx, y, z),
    proj(x + dx, y + dy, z),
    proj(x, y + dy, z),
  ]);
  const op = opacity < 1 ? ` opacity="${opacity}"` : '';
  return `<polygon points="${poly}" fill="${fill}"${op}/>`;
}

// ============================================================================
// Reusable Isometric Props & Weather Volumes
// ============================================================================

function renderPineTree(proj, x, y, z, scale = 1, snowy = false, night = false, lean = 0) {
  const trunk = { top: '#785038', left: '#6b442d', right: '#4f311f' };
  const tier1 = snowy
    ? { left: '#c9e0ef', right: '#9abbd2' }
    : night
      ? { left: '#1f5e53', right: '#15443c' }
      : { left: '#2f9e66', right: '#21754b' };
  const tier2 = snowy
    ? { left: '#e6f2fa', right: '#bfd7e8' }
    : night
      ? { left: '#2a7566', right: '#1b5449' }
      : { left: '#44b87c', right: '#2c8a59' };

  const w = 0.72 * scale;
  const tw = 0.2 * scale;
  return [
    isoBox(proj, x + (w - tw) / 2, y + (w - tw) / 2, z, tw, tw, 0.28 * scale, trunk),
    isoPyramid(proj, x + lean * 0.45, y - lean * 0.2, z + 0.26 * scale, w, w, 0.72 * scale, tier1),
    isoPyramid(proj, x + 0.08 * scale + lean, y + 0.08 * scale - lean * 0.4, z + 0.62 * scale, w * 0.78, w * 0.78, 0.68 * scale, tier2),
  ].join('');
}

function renderCactus(proj, x, y, z, scale = 1, night = false) {
  const pal = night
    ? { top: '#2f855a', left: '#276749', right: '#1c4532' }
    : { top: '#4ade80', left: '#22c55e', right: '#15803d' };
  const s = scale;
  return [
    isoBox(proj, x, y, z, 0.24 * s, 0.24 * s, 0.92 * s, pal),
    isoBox(proj, x - 0.26 * s, y + 0.04 * s, z + 0.38 * s, 0.26 * s, 0.16 * s, 0.16 * s, pal),
    isoBox(proj, x - 0.26 * s, y + 0.04 * s, z + 0.54 * s, 0.16 * s, 0.16 * s, 0.28 * s, pal),
    isoBox(proj, x + 0.24 * s, y + 0.04 * s, z + 0.48 * s, 0.24 * s, 0.16 * s, 0.16 * s, pal),
    isoBox(proj, x + 0.32 * s, y + 0.04 * s, z + 0.64 * s, 0.16 * s, 0.16 * s, 0.26 * s, pal),
  ].join('');
}

function renderCloudCluster(proj, baseX, baseY, baseZ, tone = 'light', scale = 1) {
  const palettes = {
    light: { top: '#ffffff', left: '#e1ebf5', right: '#c3d3e5' },
    muted: { top: '#e2e8f0', left: '#cbd5e1', right: '#94a3b8' },
    rainfront: { top: '#94a3b8', left: '#64748b', right: '#475569' },
    storm: { top: '#64748b', left: '#475569', right: '#334155' },
    snowfront: { top: '#f1f5f9', left: '#cbd5e1', right: '#94a3b8' },
    sunset: { top: '#fed7aa', left: '#fdba74', right: '#c084fc' },
  };
  const pal = palettes[tone] || palettes.light;
  const s = scale;

  return [
    isoBox(proj, baseX, baseY, baseZ, 1.05 * s, 1.05 * s, 0.46 * s, pal),
    isoBox(proj, baseX + 1.05 * s, baseY + 0.12 * s, baseZ, 0.82 * s, 0.88 * s, 0.38 * s, pal),
    isoBox(proj, baseX + 0.12 * s, baseY + 1.05 * s, baseZ, 0.92 * s, 0.72 * s, 0.36 * s, pal),
    isoBox(proj, baseX + 0.2 * s, baseY + 0.18 * s, baseZ + 0.46 * s, 0.85 * s, 0.82 * s, 0.38 * s, pal),
  ].join('');
}

function renderWindsock(proj, x, y, z, windBand = 'calm', night = false) {
  const polePal = { top: '#e2e8f0', left: '#94a3b8', right: '#64748b' };
  const orange = night
    ? { top: '#fb923c', left: '#ea580c', right: '#c2410c' }
    : { top: '#fdba74', left: '#f97316', right: '#ea580c' };
  const white = { top: '#ffffff', left: '#e2e8f0', right: '#cbd5e1' };

  const pole = isoBox(proj, x, y, z, 0.08, 0.08, 0.92, polePal);
  let flag = '';
  if (windBand === 'windy') {
    flag =
      isoBox(proj, x + 0.08, y, z + 0.74, 0.24, 0.12, 0.16, orange) +
      isoBox(proj, x + 0.32, y + 0.01, z + 0.75, 0.22, 0.1, 0.14, white) +
      isoBox(proj, x + 0.54, y + 0.02, z + 0.76, 0.2, 0.08, 0.12, orange);
  } else if (windBand === 'breezy') {
    flag =
      isoBox(proj, x + 0.08, y, z + 0.71, 0.2, 0.11, 0.15, orange) +
      isoBox(proj, x + 0.26, y + 0.01, z + 0.6, 0.18, 0.09, 0.13, white) +
      isoBox(proj, x + 0.42, y + 0.02, z + 0.48, 0.16, 0.08, 0.11, orange);
  } else {
    flag =
      isoBox(proj, x + 0.08, y, z + 0.64, 0.14, 0.1, 0.2, orange) +
      isoBox(proj, x + 0.09, y + 0.01, z + 0.46, 0.12, 0.09, 0.18, white);
  }
  return `${pole}${flag}`;
}

function renderSnowman(proj, x, y, z) {
  const snowPal = { top: '#ffffff', left: '#e2e8f0', right: '#cbd5e1' };
  const scarfPal = { top: '#f87171', left: '#ef4444', right: '#b91c1c' };
  const carrot = { top: '#fb923c', left: '#f97316', right: '#ea580c' };
  return [
    isoBox(proj, x, y, z, 0.36, 0.36, 0.3, snowPal),
    isoBox(proj, x + 0.04, y + 0.04, z + 0.3, 0.28, 0.28, 0.08, scarfPal),
    isoBox(proj, x + 0.05, y + 0.05, z + 0.38, 0.26, 0.26, 0.24, snowPal),
    isoBox(proj, x + 0.29, y + 0.15, z + 0.47, 0.1, 0.07, 0.07, carrot),
  ].join('');
}

function renderProppedUmbrella(proj, x, y, z) {
  const canopy = { left: '#facc15', right: '#eab308' };
  const pole = { top: '#64748b', left: '#475569', right: '#334155' };
  return [
    isoBox(proj, x + 0.13, y + 0.13, z, 0.06, 0.06, 0.28, pole),
    isoPyramid(proj, x, y, z + 0.22, 0.32, 0.32, 0.22, canopy),
  ].join('');
}

function renderUmbrellaWalker(proj, x, y, z) {
  const coat = { top: '#fde047', left: '#facc15', right: '#ca8a04' };
  const boots = { top: '#334155', left: '#1e293b', right: '#0f172a' };
  const canopy = { left: '#ef4444', right: '#b91c1c' };
  return [
    isoBox(proj, x + 0.08, y + 0.08, z, 0.2, 0.2, 0.09, boots),
    isoBox(proj, x + 0.06, y + 0.06, z + 0.09, 0.24, 0.24, 0.28, coat),
    isoPyramid(proj, x - 0.08, y - 0.08, z + 0.4, 0.52, 0.52, 0.26, canopy),
  ].join('');
}

function renderBeachParasol(proj, x, y, z) {
  const pole = { top: '#f8fafc', left: '#cbd5e1', right: '#94a3b8' };
  const towel = isoQuadZ(proj, x - 0.38, y + 0.12, 0.36, 0.54, z + 0.005, '#38bdf8', 0.92);
  const towelStripe = isoQuadZ(proj, x - 0.38, y + 0.25, 0.36, 0.16, z + 0.008, '#ffffff', 0.85);
  const canopy = { left: '#f43f5e', right: '#ffffff' };
  return [
    towel,
    towelStripe,
    isoBox(proj, x + 0.18, y + 0.18, z, 0.06, 0.06, 0.44, pole),
    isoPyramid(proj, x - 0.06, y - 0.06, z + 0.4, 0.54, 0.54, 0.26, canopy),
  ].join('');
}

function renderPondDuck(proj, x, y, z) {
  const pad = isoQuadZ(proj, x - 0.22, y + 0.05, 0.34, 0.3, z + 0.005, '#22c55e', 0.88);
  const body = isoBox(proj, x + 0.08, y - 0.08, z + 0.01, 0.16, 0.14, 0.1, {
    top: '#fef08a',
    left: '#facc15',
    right: '#eab308',
  });
  const head = isoBox(proj, x + 0.14, y - 0.06, z + 0.11, 0.1, 0.1, 0.09, {
    top: '#fef08a',
    left: '#facc15',
    right: '#eab308',
  });
  return `${pad}${body}${head}`;
}

function renderFlowers(proj, z, night = false) {
  const spots = [
    [1.6, -0.55, '#f472b6'],
    [-0.45, 1.85, '#facc15'],
    [0.25, -1.75, '#38bdf8'],
    [-1.75, 0.45, '#fb7185'],
    [1.85, 0.15, '#c084fc'],
  ];
  return spots
    .map(([fx, fy, color]) =>
      isoBox(proj, fx, fy, z, 0.12, 0.12, 0.09, {
        top: night ? '#cbd5e1' : color,
        left: color,
        right: '#16a34a',
      }),
    )
    .join('');
}

function renderIcicles(proj) {
  const coords = [
    [-2.0, 2.48], [-1.1, 2.48], [-0.2, 2.48], [0.8, 2.48], [1.8, 2.48],
    [2.48, -1.7], [2.48, -0.6], [2.48, 0.5], [2.48, 1.6],
  ];
  return coords
    .map(([ix, iy]) => {
      const [x1, y1] = proj(ix - 0.08, iy, 0.42);
      const [x2, y2] = proj(ix + 0.08, iy, 0.42);
      const [xt, yt] = proj(ix, iy, 0.12);
      return `<polygon points="${x1},${y1} ${x2},${y2} ${xt},${yt}" fill="#e0f2fe" opacity="0.92"/>`;
    })
    .join('');
}

function renderRainbow(proj) {
  const bands = [
    { offset: 0.28, color: '#ef4444' },
    { offset: 0.21, color: '#f97316' },
    { offset: 0.14, color: '#facc15' },
    { offset: 0.07, color: '#22c55e' },
    { offset: 0.0, color: '#38bdf8' },
  ];
  return bands
    .map(({ offset, color }) => {
      const points = [];
      for (let step = 0; step <= 12; step += 1) {
        const t = step / 12;
        const x = -0.25 + t * 2.45;
        const y = 1.25 - t * 2.45;
        const z = 1.15 + Math.sin(Math.PI * t) * 2.05 + offset;
        points.push(proj(x, y, z));
      }
      const d = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px},${py}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" opacity="0.82"/>`;
    })
    .join('');
}

// ============================================================================
// Multi-Signal Hero Floating Sky-Island Diorama (380 x 290)
// ============================================================================

function normalizeHeroScene(input = {}) {
  if (input && typeof input.sky === 'string' && typeof input.timePhase === 'string') {
    return {
      sky: input.sky,
      timePhase: input.timePhase,
      transition: input.transition || 'none',
      transitionMins: input.transitionMins ?? null,
      tempF: Number(input.tempF ?? 62),
      windMph: Number(input.windMph ?? 6),
      windGustsMph: Number(input.windGustsMph ?? 0),
    };
  }

  const legacy = classifyWeather(input.weatherCode, input.isDay ?? 1, input.tempF ?? 62, input.windMph ?? 6);
  const code = Number(input.weatherCode ?? 0);
  let sky = legacy.kind;
  if (code === 1) sky = 'mostly-clear';
  else if (code === 65 || code === 67 || code === 82) sky = 'heavy-rain';
  else if (code === 75 || code === 86) sky = 'heavy-snow';

  return {
    sky,
    timePhase: legacy.isDay ? 'day' : 'night',
    transition: input.transition || 'none',
    transitionMins: input.transitionMins ?? null,
    tempF: Number(input.tempF ?? 62),
    windMph: Number(input.windMph ?? 6),
    windGustsMph: Number(input.windGustsMph ?? 0),
  };
}

function getTempBand(tempF, sky) {
  const t = Number(tempF);
  if (t <= 22) return 'deep-freeze';
  if (t <= 32 || ((sky === 'snow' || sky === 'heavy-snow') && t <= 36)) return 'freezing';
  if (t <= 48) return 'chilly';
  if (t >= 88) return 'scorching';
  if (t >= 75) return 'warm';
  return 'mild';
}

function renderSkyAura(scene, tempBand) {
  const hasFront =
    scene.transition === 'rain-soon' ||
    scene.transition === 'storm-soon' ||
    scene.transition === 'snow-soon' ||
    scene.transition === 'cloudy-soon';

  let mainColor = '#7dd3fc';
  let mainOpacity = 0.2;
  if (scene.timePhase === 'dawn') {
    mainColor = '#fda4af';
    mainOpacity = 0.28;
  } else if (scene.timePhase === 'dusk') {
    mainColor = '#fb923c';
    mainOpacity = 0.28;
  } else if (scene.timePhase === 'night') {
    mainColor = '#4338ca';
    mainOpacity = 0.24;
  } else if (tempBand === 'scorching') {
    mainColor = '#fbbf24';
    mainOpacity = 0.26;
  } else if (scene.sky === 'storm' || scene.sky === 'heavy-rain') {
    mainColor = '#475569';
    mainOpacity = 0.24;
  } else if (scene.sky === 'overcast' || scene.sky === 'fog' || scene.sky === 'rain') {
    mainColor = '#94a3b8';
    mainOpacity = 0.2;
  }

  let frontAura = '';
  if (hasFront) {
    const fColor = scene.transition === 'storm-soon' ? '#334155' : '#64748b';
    frontAura = `<ellipse cx="106" cy="92" rx="68" ry="48" fill="${fColor}" opacity="0.22"/>`;
  }

  return `<ellipse cx="${hasFront ? 236 : 194}" cy="108" rx="134" ry="78" fill="${mainColor}" opacity="${mainOpacity}"/>${frontAura}`;
}

export function renderHeroDiorama(input = {}) {
  const scene = normalizeHeroScene(input);
  const proj = createProjector(194, 170, 21, 10.5, 21);

  const night = scene.timePhase === 'night';
  const dawn = scene.timePhase === 'dawn';
  const dusk = scene.timePhase === 'dusk';
  const tempBand = getTempBand(scene.tempF, scene.sky);
  const isSnowyGround = tempBand === 'deep-freeze' || tempBand === 'freezing';
  const isWetSky = ['drizzle', 'rain', 'heavy-rain', 'storm'].includes(scene.sky);
  const isScorched = tempBand === 'scorching' && !isWetSky;
  const windBand =
    scene.windMph >= 22 || scene.windGustsMph >= 32
      ? 'windy'
      : scene.windMph >= 10
        ? 'breezy'
        : 'calm';
  const treeLean = windBand === 'windy' ? 0.16 : windBand === 'breezy' ? 0.06 : 0;

  // Palette selection by time phase + temperature biome + wetness
  const rockPal = night
    ? { top: '#475569', left: '#334155', right: '#1e293b' }
    : { top: '#6c7789', left: '#535d6e', right: '#3b4351' };
  const soilPal = night
    ? { top: '#6b4d3b', left: '#523a2c', right: '#3c291e' }
    : { top: '#8c6144', left: '#744e35', right: '#583a26' };

  let turfPal = { top: '#63d48c', left: '#43b371', right: '#2c8a56' };
  let hillPal = { top: '#78e09e', left: '#4ec17d', right: '#33965f' };
  let pondColor = '#38bdf8';

  if (isSnowyGround) {
    turfPal = night
      ? { top: '#cbd5e1', left: '#94a3b8', right: '#64748b' }
      : { top: '#eef6fc', left: '#c9dfef', right: '#a3c3dc' };
    hillPal = night
      ? { top: '#e2e8f0', left: '#cbd5e1', right: '#94a3b8' }
      : { top: '#f8fbff', left: '#d8eaf7', right: '#b5d0e5' };
    pondColor = tempBand === 'deep-freeze' ? '#bae6fd' : '#7dd3fc';
  } else if (isScorched) {
    turfPal = night
      ? { top: '#a16207', left: '#854d0e', right: '#713f12' }
      : { top: '#e6b85c', left: '#ca9a3e', right: '#9e7426' };
    hillPal = night
      ? { top: '#b45309', left: '#92400e', right: '#78350f' }
      : { top: '#f2ca74', left: '#d9ac50', right: '#b08632' };
    pondColor = '#06b6d4';
  } else if (tempBand === 'warm' && !isWetSky) {
    turfPal = night
      ? { top: '#318268', left: '#236652', right: '#194d3e' }
      : { top: '#84cc16', left: '#65a30d', right: '#4d7c0f' };
    hillPal = night
      ? { top: '#3d997c', left: '#2c7860', right: '#1e5846' }
      : { top: '#a3e635', left: '#84cc16', right: '#65a30d' };
    pondColor = '#06b6d4';
  } else if (isWetSky) {
    turfPal = night
      ? { top: '#2b6a5e', left: '#1f5349', right: '#163d35' }
      : { top: '#43a874', left: '#30885c', right: '#216745' };
    hillPal = night
      ? { top: '#347a6c', left: '#256054', right: '#1a4940' }
      : { top: '#4fb882', left: '#399768', right: '#27744e' };
    pondColor = '#0284c7';
  } else if (dawn) {
    turfPal = { top: '#5cc78a', left: '#40a66f', right: '#2c7e54' };
    hillPal = { top: '#72d69c', left: '#4eb77d', right: '#348d5d' };
    pondColor = '#38bdf8';
  } else if (dusk) {
    turfPal = { top: '#4bb27d', left: '#359465', right: '#25704c' };
    hillPal = { top: '#5dc28c', left: '#42a371', right: '#2e7d55' };
    pondColor = '#0ea5e9';
  } else if (night) {
    turfPal = { top: '#2f8070', left: '#236659', right: '#194d43' };
    hillPal = { top: '#378f7e', left: '#297264', right: '#1e584d' };
    pondColor = '#0ea5e9';
  }

  // Layer 1: Atmospheric sky aura & island bedrock/strata/turf
  const skyAura = renderSkyAura(scene, tempBand);
  const shadow = isoQuadZ(proj, -2.55, -2.55, 5.1, 5.1, -2.0, night ? '#040811' : '#1e293b', 0.16);
  const bedrock = isoBox(proj, -2.5, -2.5, -1.05, 5.0, 5.0, 0.95, rockPal);
  const soil = isoBox(proj, -2.5, -2.5, -0.1, 5.0, 5.0, 0.52, soilPal);
  const turf = isoBox(proj, -2.5, -2.5, 0.42, 5.0, 5.0, 0.43, turfPal);
  const hill = isoBox(proj, -2.35, -2.35, 0.85, 2.55, 2.55, 0.55, hillPal);

  // Pond & surface ice / ripples / duck
  const pondRim = isoQuadZ(proj, 0.3, 0.35, 1.8, 1.75, 0.855, isSnowyGround ? '#93c5fd' : night ? '#1b4a5e' : '#0369a1', 0.55);
  const pondWater = isoQuadZ(proj, 0.42, 0.47, 1.56, 1.51, 0.86, pondColor, 0.95);
  const pondGloss = isoQuadZ(proj, 0.58, 0.62, 0.52, 0.25, 0.865, '#ffffff', tempBand === 'deep-freeze' ? 0.55 : 0.34);

  let pondExtras = '';
  if (tempBand === 'deep-freeze') {
    const [gx1, gy1] = proj(0.65, 1.65, 0.87);
    const [gx2, gy2] = proj(1.65, 0.65, 0.87);
    const [gx3, gy3] = proj(0.85, 1.75, 0.87);
    const [gx4, gy4] = proj(1.75, 0.9, 0.87);
    pondExtras = `<line x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" opacity="0.85"/>
      <line x1="${gx3}" y1="${gy3}" x2="${gx4}" y2="${gy4}" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>`;
  } else if (isWetSky) {
    pondExtras =
      isoQuadZ(proj, 0.78, 0.82, 0.52, 0.52, 0.868, '#e0f2fe', 0.42) +
      isoQuadZ(proj, 1.25, 1.25, 0.34, 0.34, 0.868, '#bae6fd', 0.5);
  } else if (windBand === 'windy') {
    pondExtras =
      isoQuadZ(proj, 0.65, 0.85, 0.45, 0.14, 0.868, '#ffffff', 0.45) +
      isoQuadZ(proj, 1.15, 1.35, 0.5, 0.14, 0.868, '#ffffff', 0.45);
  } else if (tempBand === 'mild' && !night) {
    pondExtras = renderPondDuck(proj, 1.1, 1.15, 0.865);
  }

  // Stepping stone path & biome turf props
  const stones = [
    isoQuadZ(proj, -0.25, 0.45, 0.36, 0.36, 0.86, isScorched ? '#d6d3d1' : '#cbd5e1', 0.9),
    isoQuadZ(proj, 0.05, 0.95, 0.34, 0.34, 0.86, isScorched ? '#d6d3d1' : '#cbd5e1', 0.85),
  ].join('');

  const puddles = isWetSky
    ? isoQuadZ(proj, -0.45, 1.6, 0.52, 0.44, 0.862, '#38bdf8', 0.35) +
      isoQuadZ(proj, 1.55, -0.65, 0.46, 0.42, 0.862, '#38bdf8', 0.32)
    : '';
  const flowers =
    (tempBand === 'mild' || tempBand === 'warm') && !isWetSky && !isSnowyGround
      ? renderFlowers(proj, 0.86, night)
      : '';
  const parasol = tempBand === 'warm' && !isWetSky ? renderBeachParasol(proj, 1.85, -0.2, 0.86) : '';
  const snowman = isSnowyGround && scene.sky !== 'rain' && scene.sky !== 'storm' ? renderSnowman(proj, -0.35, 1.55, 0.86) : '';
  const icicles = tempBand === 'deep-freeze' ? renderIcicles(proj) : '';

  // Ground cloud shadows (overhead + upwind front)
  const hasOverheadClouds = scene.sky !== 'clear';
  const cloudShadow = hasOverheadClouds
    ? isoQuadZ(
        proj,
        -0.75,
        -0.55,
        1.85,
        1.55,
        0.864,
        '#0f172a',
        scene.sky === 'storm' || scene.sky === 'heavy-rain' ? 0.25 : scene.sky === 'partly' ? 0.11 : 0.16,
      )
    : '';
  const hasApproachFront =
    scene.transition === 'rain-soon' ||
    scene.transition === 'storm-soon' ||
    scene.transition === 'snow-soon' ||
    scene.transition === 'cloudy-soon';
  const frontShadow = hasApproachFront
    ? isoQuadZ(proj, -2.4, 0.35, 1.35, 1.85, 0.864, '#0f172a', scene.transition === 'storm-soon' ? 0.24 : 0.17)
    : '';

  // Cozy Cabin + Windsock + Chimney Smoke
  const cabinZ = 1.4;
  const cabinWall = night
    ? { top: '#cbd5e1', left: '#94a3b8', right: '#64748b' }
    : { top: '#ffffff', left: '#f1f5f9', right: '#cbd5e1' };
  const cabinRoof = isSnowyGround
    ? { left: '#f1f5f9', right: '#cbd5e1' }
    : dusk || dawn
      ? { left: '#e11d48', right: '#9f1239' }
      : { left: '#ef4444', right: '#b91c1c' };

  const cabinBody = isoBox(proj, -1.65, -1.65, cabinZ, 1.15, 1.15, 0.78, cabinWall);
  const cabinRoofEl = isoPyramid(proj, -1.77, -1.77, cabinZ + 0.76, 1.39, 1.39, 0.72, cabinRoof);
  const chimney = isoBox(proj, -0.82, -0.98, cabinZ + 1.02, 0.22, 0.22, 0.42, {
    top: '#94a3b8',
    left: '#64748b',
    right: '#475569',
  });

  const litWindows = night || dusk || dawn || isWetSky || scene.sky === 'fog';
  const winColor = litWindows ? '#fde047' : '#38bdf8';
  const winPolyL = pts([
    proj(-1.35, -0.5, cabinZ + 0.5),
    proj(-0.98, -0.5, cabinZ + 0.5),
    proj(-0.98, -0.5, cabinZ + 0.22),
    proj(-1.35, -0.5, cabinZ + 0.22),
  ]);
  const winPolyR = pts([
    proj(-0.5, -1.25, cabinZ + 0.5),
    proj(-0.5, -0.9, cabinZ + 0.5),
    proj(-0.5, -0.9, cabinZ + 0.22),
    proj(-0.5, -1.25, cabinZ + 0.22),
  ]);
  const cabinGlow = night || dusk
    ? `<polygon points="${pts([
        proj(-1.45, -0.49, 1.42),
        proj(-0.85, -0.49, 1.42),
        proj(-0.85, 0.25, 1.42),
        proj(-1.45, 0.25, 1.42),
      ])}" fill="#fde047" opacity="${night ? 0.24 : 0.14}"/>`
    : '';
  const cabinWindows = `<polygon points="${winPolyL}" fill="${winColor}"/><polygon points="${winPolyR}" fill="${winColor}"/>`;

  const windsock = renderWindsock(proj, -2.12, -0.22, 1.4, windBand, night);
  const smokeDrift = windBand === 'windy' ? 0.28 : windBand === 'breezy' ? 0.14 : 0.04;
  const smokePal = { top: '#f8fafc', left: '#e2e8f0', right: '#cbd5e1' };
  const chimneySmoke =
    Number(scene.tempF) <= 48
      ? `<g class="iso-smoke" opacity="0.82">${isoBox(proj, -0.79 + smokeDrift * 0.4, -0.95 - smokeDrift * 0.2, cabinZ + 1.5, 0.15, 0.15, 0.15, smokePal)}${isoBox(proj, -0.77 + smokeDrift, -0.92 - smokeDrift * 0.4, cabinZ + 1.76, 0.19, 0.19, 0.19, smokePal)}${isoBox(proj, -0.74 + smokeDrift * 1.7, -0.89 - smokeDrift * 0.6, cabinZ + 2.08, 0.22, 0.22, 0.21, smokePal)}</g>`
      : '';

  // Hillock ready-umbrella (when wet weather approaching) vs walker with umbrella (when actively raining)
  const proppedUmbrella =
    scene.transition === 'rain-soon' || scene.transition === 'storm-soon'
      ? renderProppedUmbrella(proj, -0.45, -0.35, 1.4)
      : '';
  const walker = isWetSky ? renderUmbrellaWalker(proj, -0.05, 0.72, 0.86) : '';

  // Trees or Desert Cacti
  const treeBack = isScorched
    ? renderCactus(proj, 1.25, -1.78, 0.85, 1.0, night)
    : renderPineTree(proj, 1.15, -1.85, 0.85, 1.05, isSnowyGround, night, treeLean);
  const treeMid = isScorched
    ? renderCactus(proj, -1.95, 1.05, 0.85, 0.9, night)
    : renderPineTree(proj, -2.05, 0.95, 0.85, 0.95, isSnowyGround, night, treeLean);
  const treeSmall = isScorched
    ? ''
    : renderPineTree(proj, -1.2, 1.55, 0.85, 0.72, isSnowyGround, night, treeLean * 0.75);

  // Rainbow layer (when showers/rain clearing in daytime/twilight)
  const rainbowLayer = scene.transition === 'clearing' && !night ? renderRainbow(proj) : '';

  // Heat-shimmer waves in scorching desert
  const heatWaves = isScorched
    ? [
        [0.4, -1.3, 1.35],
        [-0.8, 0.8, 1.5],
        [1.4, 0.3, 1.3],
      ]
        .map(([hx, hy, hz]) => {
          const [px, py] = proj(hx, hy, hz);
          return `<path d="M${px - 7},${py} q4,-5 7,0 t7,0" fill="none" stroke="#f59e0b" stroke-width="1.6" stroke-linecap="round" opacity="0.65"/>`;
        })
        .join('')
    : '';
  const heatLayer = heatWaves ? `<g class="iso-mist">${heatWaves}</g>` : '';

  // Layer 3: Celestial Bodies + Overhead Clouds + Precipitation
  let celestialLayer = '';
  const showSunOrMoon =
    scene.sky === 'clear' ||
    scene.sky === 'mostly-clear' ||
    scene.sky === 'partly' ||
    scene.transition === 'clearing';

  if (showSunOrMoon) {
    if (!night) {
      const sunCoord = dawn ? [2.15, -1.7, 2.55] : dusk ? [1.65, -2.0, 2.75] : [1.45, -2.05, 4.1];
      const sunOrigin = proj(sunCoord[0] + 0.35, sunCoord[1] + 0.35, sunCoord[2] + 0.3);
      const sunHalo = `<circle cx="${sunOrigin[0]}" cy="${sunOrigin[1]}" r="${dawn || dusk ? 32 : 34}" fill="${dawn ? '#fda4af' : dusk || isScorched ? '#fb923c' : '#fde047'}" opacity="${dawn || dusk ? 0.28 : 0.22}"/>`;
      const beamColor = dawn ? '#fed7aa' : dusk ? '#fdba74' : '#fde047';
      const beam = `<polygon points="${sunOrigin[0] - 12},${sunOrigin[1] + 10} ${sunOrigin[0] + 14},${sunOrigin[1] + 10} ${proj(1.5, 0.8, 0.86)[0]},${proj(1.5, 0.8, 0.86)[1]} ${proj(-0.4, 0.4, 0.86)[0]},${proj(-0.4, 0.4, 0.86)[1]}" fill="${beamColor}" opacity="${dawn || dusk ? 0.11 : 0.14}"/>`;
      const sunPal = dawn
        ? { top: '#fef08a', left: '#fda4af', right: '#fb7185' }
        : dusk
          ? { top: '#fde047', left: '#fb923c', right: '#ea580c' }
          : isScorched
            ? { top: '#fef08a', left: '#f97316', right: '#dc2626' }
            : { top: '#fef08a', left: '#facc15', right: '#eab308' };
      const sunCube = isoBox(proj, sunCoord[0], sunCoord[1], sunCoord[2], 0.86, 0.86, 0.86, sunPal);
      celestialLayer += `<g class="iso-float">${sunHalo}${beam}${sunCube}</g>`;
    } else {
      const moonPos = proj(1.75, -1.75, 4.35);
      const moonHalo = `<circle cx="${moonPos[0]}" cy="${moonPos[1]}" r="26" fill="#fef3c7" opacity="0.16"/>`;
      const moonCube = isoBox(proj, 1.35, -2.05, 3.95, 0.74, 0.74, 0.74, {
        top: '#fefce8',
        left: '#fde68a',
        right: '#d97706',
      });
      const stars = [
        [2.25, -2.35, 4.75],
        [0.45, -2.4, 4.85],
        [-0.85, -2.2, 4.65],
        [2.65, -0.85, 4.55],
      ]
        .map(([sx, sy, sz], idx) => {
          const [px, py] = proj(sx, sy, sz);
          const r = idx % 2 === 0 ? 4.2 : 3.0;
          return `<polygon class="iso-star-twinkle" points="${px},${py - r} ${px + r},${py} ${px},${py + r} ${px - r},${py}" fill="#fef08a"/>`;
        })
        .join('');
      celestialLayer += `${stars}<g class="iso-float">${moonHalo}${moonCube}</g>`;
    }
  } else if (night) {
    // Faint peeks of stars even on cool nights without full overcast/rain blocker
    const [px, py] = proj(2.35, -2.15, 4.65);
    celestialLayer += `<polygon class="iso-star-twinkle" points="${px},${py - 3.2} ${px + 3.2},${py} ${px},${py + 3.2} ${px - 3.2},${py}" fill="#fef08a" opacity="0.6"/>`;
  }

  // Upwind Horizon Weather Front Layer (Left sky)
  let horizonLayer = '';
  if (scene.transition === 'rain-soon' || scene.transition === 'storm-soon' || scene.transition === 'snow-soon' || scene.transition === 'cloudy-soon') {
    const eta = Number(scene.transitionMins ?? 75);
    const closeness = Math.max(0, Math.min(1, 1 - (eta - 15) / 105));
    const fx = -3.65 + closeness * 0.45;
    const fy = 0.05;
    const fz = 3.05;
    const frontTone =
      scene.transition === 'storm-soon'
        ? 'storm'
        : scene.transition === 'snow-soon'
          ? 'snowfront'
          : scene.transition === 'rain-soon'
            ? 'rainfront'
            : 'muted';
    const frontCloud = renderCloudCluster(proj, fx, fy, fz, frontTone, 0.88);
    let frontPrecip = '';
    if (scene.transition === 'rain-soon' || scene.transition === 'storm-soon') {
      const fDrops = [
        [fx + 0.3, fy + 0.4, fz - 0.1],
        [fx + 0.85, fy + 0.25, fz - 0.05],
        [fx + 1.35, fy + 0.5, fz - 0.15],
        [fx + 0.55, fy + 0.95, fz - 0.2],
        [fx + 1.1, fy + 0.9, fz - 0.1],
      ]
        .map(([dx, dy, dz]) => {
          const [x1, y1] = proj(dx, dy, dz);
          const [x2, y2] = proj(dx - 0.16, dy + 0.16, dz - 0.78);
          return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round"/>`;
        })
        .join('');
      frontPrecip += `<g class="iso-rain-fall">${fDrops}</g>`;
      if (scene.transition === 'storm-soon') {
        const [bx, by] = proj(fx + 0.85, fy + 0.55, fz - 0.1);
        frontPrecip += `<polygon class="iso-lightning" points="${bx},${by} ${bx - 8},${by + 15} ${bx - 1},${by + 15} ${bx - 7},${by + 30} ${bx + 8},${by + 12} ${bx + 1},${by + 12}" fill="#fde047" stroke="#f59e0b" stroke-width="0.9"/>`;
      }
    } else if (scene.transition === 'snow-soon') {
      const fFlakes = [
        [fx + 0.4, fy + 0.45, fz - 0.25],
        [fx + 1.0, fy + 0.35, fz - 0.2],
        [fx + 0.75, fy + 0.9, fz - 0.4],
        [fx + 1.3, fy + 0.85, fz - 0.35],
      ]
        .map(([sx, sy, sz]) =>
          isoBox(proj, sx, sy, sz, 0.13, 0.13, 0.13, { top: '#ffffff', left: '#e0f2fe', right: '#bae6fd' }),
        )
        .join('');
      frontPrecip += `<g class="iso-snow-fall">${fFlakes}</g>`;
    }
    horizonLayer = `${frontPrecip}<g class="iso-cloud-drift">${frontCloud}</g>`;
  }

  // Overhead Sky Clouds
  let skyObjects = '';
  const cloudTone =
    scene.sky === 'storm' || scene.sky === 'heavy-rain'
      ? 'storm'
      : dusk || dawn
        ? scene.sky === 'overcast' || scene.sky === 'rain'
          ? 'muted'
          : 'sunset'
        : scene.sky === 'overcast' || scene.sky === 'rain' || scene.sky === 'drizzle'
          ? 'muted'
          : 'light';

  const shiftClearX = scene.transition === 'clearing' ? 0.65 : 0;
  if (scene.sky === 'mostly-clear') {
    const cloudPuff = isoBox(proj, -0.3 + shiftClearX, -1.65, 4.15, 0.9, 0.82, 0.38, {
      top: dusk || dawn ? '#fed7aa' : '#ffffff',
      left: dusk || dawn ? '#fdba74' : '#e1ebf5',
      right: dusk || dawn ? '#c084fc' : '#c3d3e5',
    });
    skyObjects += `<g class="iso-cloud-drift">${cloudPuff}</g>`;
  } else if (hasOverheadClouds && scene.sky !== 'fog') {
    const cloudA = renderCloudCluster(proj, -1.25 + shiftClearX, -1.05, 4.0, cloudTone, 0.9);
    const needsSecondCloud =
      scene.sky === 'overcast' ||
      scene.sky === 'drizzle' ||
      scene.sky === 'rain' ||
      scene.sky === 'heavy-rain' ||
      scene.sky === 'storm' ||
      scene.sky === 'snow' ||
      scene.sky === 'heavy-snow';
    const cloudB =
      needsSecondCloud && scene.transition !== 'clearing'
        ? renderCloudCluster(proj, 0.3, -0.4, 4.25, cloudTone === 'light' ? 'muted' : cloudTone, 0.82)
        : '';
    skyObjects += `<g class="iso-cloud-drift">${cloudA}${cloudB}</g>`;
  }

  if (scene.sky === 'fog') {
    const mistA = isoQuadZ(proj, -2.2, -1.8, 4.2, 3.6, 1.65, '#e2e8f0', 0.44);
    const mistB = isoQuadZ(proj, -1.8, -1.5, 3.8, 3.4, 2.35, '#f8fafc', 0.36);
    const mistC = isoQuadZ(proj, -1.3, -1.1, 3.1, 2.8, 3.05, '#f1f5f9', 0.3);
    skyObjects += `<g class="iso-mist">${mistA}${mistB}${mistC}</g>`;
  }

  // Active Precipitation
  let precipLayer = '';
  if (isWetSky) {
    const dropCoords = [
      [-1.1, -0.5, 3.7],
      [-0.5, -0.8, 3.9],
      [0.1, -0.4, 3.8],
      [0.65, -0.1, 3.9],
      [1.15, 0.2, 3.8],
      [-0.75, 0.3, 3.6],
      [-0.15, 0.5, 3.7],
      [0.45, 0.7, 3.5],
      [1.0, -0.6, 3.6],
      [-0.35, 0.0, 3.4],
      [-0.95, 0.7, 3.3],
      [0.2, 1.0, 3.4],
      [0.85, 0.9, 3.3],
      [-0.55, -0.2, 3.2],
    ];
    const count = scene.sky === 'drizzle' ? 6 : scene.sky === 'heavy-rain' || scene.sky === 'storm' ? 14 : 10;
    const width = scene.sky === 'drizzle' ? 1.8 : scene.sky === 'heavy-rain' ? 2.6 : 2.3;
    const dxWind = windBand === 'windy' ? -0.35 : -0.18;
    const lines = dropCoords
      .slice(0, count)
      .map(([dx, dy, dz]) => {
        const [x1, y1] = proj(dx, dy, dz);
        const [x2, y2] = proj(dx + dxWind, dy + 0.2, dz - 0.85);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0284c7" stroke-width="${width}" stroke-linecap="round"/>`;
      })
      .join('');
    precipLayer += `<g class="iso-rain-fall">${lines}</g>`;
  }

  if (scene.sky === 'snow' || scene.sky === 'heavy-snow') {
    const flakeCoords = [
      [-1.0, -0.6, 3.55],
      [-0.2, -0.8, 3.8],
      [0.5, -0.4, 3.6],
      [1.0, 0.2, 3.35],
      [-0.5, 0.4, 3.25],
      [0.2, 0.7, 3.15],
      [-1.1, 0.5, 3.0],
      [0.8, -0.5, 3.4],
      [-0.3, 1.1, 3.0],
      [1.1, 0.9, 2.95],
    ];
    const cubes = flakeCoords
      .slice(0, scene.sky === 'heavy-snow' ? 10 : 6)
      .map(([fx, fy, fz]) =>
        isoBox(proj, fx, fy, fz, 0.14, 0.14, 0.14, { top: '#ffffff', left: '#e0f2fe', right: '#bae6fd' }),
      )
      .join('');
    precipLayer += `<g class="iso-snow-fall">${cubes}</g>`;
  }

  if (scene.sky === 'storm') {
    const [bx, by] = proj(0.05, -0.2, 3.9);
    const [bx2, by2] = proj(0.95, 0.1, 3.95);
    precipLayer +=
      `<polygon class="iso-lightning" points="${bx},${by} ${bx - 10},${by + 19} ${bx - 2},${by + 19} ${bx - 9},${by + 40} ${bx + 10},${by + 15} ${bx + 2},${by + 15}" fill="#fde047" stroke="#f59e0b" stroke-width="1"/>` +
      `<polygon class="iso-lightning" points="${bx2},${by2} ${bx2 - 8},${by2 + 15} ${bx2 - 1},${by2 + 15} ${bx2 - 6},${by2 + 30} ${bx2 + 8},${by2 + 12} ${bx2 + 2},${by2 + 12}" fill="#fde047" stroke="#f59e0b" stroke-width="0.9"/>`;
  }

  // Animated wind ribbons when breezy/windy
  let windLayer = '';
  if (windBand === 'breezy' || windBand === 'windy') {
    const ribbons = windBand === 'windy'
      ? [[-1.6, 0.5, 3.25], [-0.4, -0.8, 3.45], [-1.8, -0.3, 2.55], [0.4, 0.6, 2.25]]
      : [[-1.3, 0.3, 3.1], [-0.2, -0.6, 3.3]];
    const strokes = ribbons
      .map(([wx, wy, wz]) => {
        const [x1, y1] = proj(wx, wy, wz);
        const [x2, y2] = proj(wx + (windBand === 'windy' ? 1.5 : 1.05), wy - 0.15, wz);
        const cx = ((x1 + x2) / 2).toFixed(1);
        const cy = (((y1 + y2) / 2) - 5).toFixed(1);
        return `<path d="M${x1},${y1} Q${cx},${cy} ${x2},${y2}" fill="none" stroke="${night ? '#93c5fd' : '#64748b'}" stroke-width="1.8" stroke-linecap="round" opacity="${windBand === 'windy' ? 0.65 : 0.42}"/>`;
      })
      .join('');
    windLayer = `<g class="iso-wind-streak">${strokes}</g>`;
  }

  return `<svg viewBox="46 22 292 246" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    ${skyAura}
    <g class="iso-island-group">
      ${shadow}
      ${bedrock}
      ${soil}
      ${turf}
      ${icicles}
      ${pondRim}
      ${pondWater}
      ${pondGloss}
      ${pondExtras}
      ${puddles}
      ${stones}
      ${flowers}
      ${cloudShadow}
      ${frontShadow}
      ${hill}
      ${windsock}
      ${treeBack}
      ${cabinGlow}
      ${cabinBody}
      ${cabinWindows}
      ${cabinRoofEl}
      ${chimney}
      ${proppedUmbrella}
      ${treeMid}
      ${treeSmall}
      ${parasol}
      ${snowman}
      ${walker}
    </g>
    ${rainbowLayer}
    ${heatLayer}
    ${windLayer}
    ${chimneySmoke}
    ${celestialLayer}
    ${precipLayer}
    ${horizonLayer}
    ${skyObjects}
  </svg>`;
}

// ============================================================================
// Curated Art Debug Presets & Icon Gallery Metadata
// ============================================================================

export const HERO_SCENE_PRESETS = [
  {
    id: 'mostly-clear-rain-75m',
    title: 'Mostly Clear · Rain in 75m',
    subtitle: 'Sun overhead + upwind storm front + ready umbrella',
    scene: { sky: 'mostly-clear', timePhase: 'day', transition: 'rain-soon', transitionMins: 75, tempF: 64, windMph: 14, windGustsMph: 20 },
  },
  {
    id: 'sunny-storm-30m',
    title: 'Sunny · Storm Rolling In (30m)',
    subtitle: 'Bright island with dark thunderhead approaching left',
    scene: { sky: 'clear', timePhase: 'day', transition: 'storm-soon', transitionMins: 30, tempF: 76, windMph: 20, windGustsMph: 28 },
  },
  {
    id: 'clearing-rainbow',
    title: 'Showers Clearing · Rainbow',
    subtitle: 'Departing rain cloud, sun peeking out & 3D rainbow arc',
    scene: { sky: 'drizzle', timePhase: 'day', transition: 'clearing', transitionMins: 20, tempF: 62, windMph: 8, windGustsMph: 12 },
  },
  {
    id: 'crisp-dawn-smoke',
    title: 'Crisp Dawn · Chimney Smoke',
    subtitle: 'Rosy low sunrise, cozy cabin lights & rising chimney puffs',
    scene: { sky: 'mostly-clear', timePhase: 'dawn', transition: 'none', transitionMins: null, tempF: 39, windMph: 5, windGustsMph: 8 },
  },
  {
    id: 'spring-meadow-duck',
    title: 'Spring Meadow · Wildflowers',
    subtitle: 'Mild sunlit turf, wildflowers & tiny pond duck',
    scene: { sky: 'partly', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 68, windMph: 6, windGustsMph: 9 },
  },
  {
    id: 'poolside-summer',
    title: 'Poolside Summer Warmth',
    subtitle: 'Warm lime turf, turquoise pond & striped beach parasol',
    scene: { sky: 'clear', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 83, windMph: 7, windGustsMph: 11 },
  },
  {
    id: 'scorching-desert',
    title: 'Scorching Desert Heatwave',
    subtitle: 'Parched ochre sand, voxel cacti, heat waves & blazing sun',
    scene: { sky: 'clear', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 99, windMph: 9, windGustsMph: 14 },
  },
  {
    id: 'golden-hour-dusk',
    title: 'Golden Hour Dusk',
    subtitle: 'Amber-violet sunset glow with cabin window light spill',
    scene: { sky: 'partly', timePhase: 'dusk', transition: 'none', transitionMins: null, tempF: 71, windMph: 8, windGustsMph: 12 },
  },
  {
    id: 'starry-night',
    title: 'Starry Clear Night',
    subtitle: 'Deep indigo night biome, crescent moon cube & twinkling stars',
    scene: { sky: 'clear', timePhase: 'night', transition: 'none', transitionMins: null, tempF: 52, windMph: 4, windGustsMph: 6 },
  },
  {
    id: 'chilly-night-snow-soon',
    title: 'Chilly Night · Snow in 45m',
    subtitle: 'Snowy cabin & snowman with upwind snow flurries approaching',
    scene: { sky: 'mostly-clear', timePhase: 'night', transition: 'snow-soon', transitionMins: 45, tempF: 30, windMph: 13, windGustsMph: 18 },
  },
  {
    id: 'dense-valley-fog',
    title: 'Dense Valley Fog',
    subtitle: 'Translucent drifting fog banks & morning chimney fire',
    scene: { sky: 'fog', timePhase: 'dawn', transition: 'none', transitionMins: null, tempF: 45, windMph: 3, windGustsMph: 5 },
  },
  {
    id: 'steady-rain-walker',
    title: 'Steady Rain · Umbrella Stroll',
    subtitle: 'Wet turf puddles, falling rain streaks & red umbrella walker',
    scene: { sky: 'rain', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 54, windMph: 12, windGustsMph: 18 },
  },
  {
    id: 'gale-downpour',
    title: 'Gale-Force Downpour',
    subtitle: 'Taut horizontal windsock, leaning pines & heavy rain',
    scene: { sky: 'heavy-rain', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 49, windMph: 29, windGustsMph: 38 },
  },
  {
    id: 'midnight-thunderstorm',
    title: 'Midnight Thunderstorm',
    subtitle: 'Dual lightning bolts, dark anvil clouds & windy gusts',
    scene: { sky: 'storm', timePhase: 'night', transition: 'none', transitionMins: null, tempF: 63, windMph: 24, windGustsMph: 35 },
  },
  {
    id: 'fresh-snowfall',
    title: 'Fresh Snowfall · Snowman',
    subtitle: 'Snow-capped cabin roof, tumbling voxels & scarfed snowman',
    scene: { sky: 'snow', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 28, windMph: 8, windGustsMph: 12 },
  },
  {
    id: 'deep-freeze-ice',
    title: 'Arctic Deep Freeze · Iced Pond',
    subtitle: 'Sub-22°F frozen ice skating pond, crystal icicles & chimney smoke',
    scene: { sky: 'clear', timePhase: 'day', transition: 'none', transitionMins: null, tempF: 11, windMph: 15, windGustsMph: 21 },
  },
];

export const MINI_ICON_SPECS = [
  { label: 'Clear Day', cue: 'Sunny & clear', code: 0, isDay: 1, opts: { precipProb: 0, tempF: 72 } },
  { label: 'Clear Night', cue: 'Starry clear sky', code: 0, isDay: 0, opts: { precipProb: 0, tempF: 55 } },
  { label: 'Partly Cloudy', cue: 'Sun + white cloud', code: 2, isDay: 1, opts: { precipProb: 5, tempF: 68 } },
  { label: 'Partly Night', cue: 'Moon + night cloud', code: 2, isDay: 0, opts: { precipProb: 5, tempF: 52 } },
  { label: 'Overcast', cue: 'Layered grey clouds', code: 3, isDay: 1, opts: { precipProb: 15, tempF: 58 } },
  { label: 'Fog', cue: 'Mist & low fog bands', code: 45, isDay: 1, opts: { precipProb: 10, tempF: 49 } },
  { label: 'Light Rain', cue: 'Drizzle · 2 drops', code: 61, isDay: 1, opts: { precipProb: 35, precipInches: 0.02, tempF: 56 } },
  { label: 'Rain', cue: 'Steady rain · 3 drops', code: 63, isDay: 1, opts: { precipProb: 60, precipInches: 0.08, tempF: 54 } },
  { label: 'Heavy Rain', cue: 'Downpour · 5 drops', code: 65, isDay: 1, opts: { precipProb: 90, precipInches: 0.25, tempF: 52 } },
  { label: 'Light Snow', cue: 'Flurries · 2 crystals', code: 71, isDay: 1, opts: { precipProb: 40, tempF: 30 } },
  { label: 'Heavy Snow', cue: 'Snowfall · 3 crystals', code: 75, isDay: 1, opts: { precipProb: 85, tempF: 24 } },
  { label: 'Thunderstorm', cue: 'Lightning & storm cell', code: 95, isDay: 1, opts: { precipProb: 85, tempF: 74 } },
];

// ============================================================================
// Compact 48x48 Isometric Weather Voxel Icons & Precip Glyphs (Hourly & Daily)
// ============================================================================

export function isSnowPrecip(weatherCode, tempF = 60) {
  const code = Number(weatherCode ?? 0);
  const t = Number(tempF ?? 60);
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return true;
  if (code >= 51 && code <= 67 && t <= 32) return true;
  if (code < 51 && t <= 32) return true;
  return false;
}

export function renderPrecipGlyph(isSnow = false) {
  if (isSnow) {
    return '<svg class="pop-glyph is-flake" viewBox="0 0 14 14" aria-hidden="true"><g stroke="currentColor" stroke-width="1.65" stroke-linecap="round"><line x1="7" y1="1.3" x2="7" y2="12.7"/><line x1="2.1" y1="4.15" x2="11.9" y2="9.85"/><line x1="2.1" y1="9.85" x2="11.9" y2="4.15"/></g></svg>';
  }
  return '<svg class="pop-glyph is-drop" viewBox="0 0 12 14" aria-hidden="true"><path d="M6 1.1C6 1.1 1.6 6.2 1.6 9.1a4.4 4.4 0 0 0 8.8 0C10.4 6.2 6 1.1 6 1.1Z" fill="currentColor"/></svg>';
}

function snowflakeSprite(cx, cy, r = 4.6) {
  const dx = Number((r * 0.866).toFixed(1));
  const dy = Number((r * 0.5).toFixed(1));
  return `<g stroke="#0284c7" stroke-width="2" stroke-linecap="round">
    <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}"/>
    <line x1="${cx - dx}" y1="${cy - dy}" x2="${cx + dx}" y2="${cy + dy}"/>
    <line x1="${cx - dx}" y1="${cy + dy}" x2="${cx + dx}" y2="${cy - dy}"/>
  </g>`;
}

function renderMiniCloudPuffs(proj, pal) {
  return (
    isoBox(proj, -1.35, -0.22, 0.0, 0.72, 0.88, 0.54, pal) +
    isoBox(proj, -0.78, -0.46, 0.0, 1.32, 1.12, 0.68, pal) +
    isoBox(proj, 0.42, -0.2, 0.0, 0.68, 0.86, 0.5, pal) +
    isoBox(proj, -0.56, -0.34, 0.62, 1.04, 0.9, 0.54, pal) +
    isoBox(proj, 0.16, -0.18, 0.46, 0.56, 0.66, 0.38, pal)
  );
}

function renderMiniVoxelCloud(proj, palette) {
  const outlinePal = {
    top: palette.outline,
    left: palette.outline,
    right: palette.outline,
    stroke: palette.outline,
    strokeWidth: palette.outlineWidth ?? 2.1,
  };
  const fillPal = {
    top: palette.top,
    left: palette.left,
    right: palette.right,
  };
  return `<g>${renderMiniCloudPuffs(proj, outlinePal)}${renderMiniCloudPuffs(proj, fillPal)}</g>`;
}

export function resolveIconKind(weatherCode, isDay = 1, { precipProb = null, precipInches = 0, tempF = 60 } = {}) {
  const code = Number(weatherCode ?? 0);
  let base = classifyWeather(code, isDay, tempF).kind;
  const hasProb = precipProb !== null && precipProb !== undefined && Number.isFinite(Number(precipProb));
  const pop = hasProb ? Number(precipProb) : null;
  const amt = Number(precipInches || 0);

  // Rule A: Suppress phantom rain/snow when probability is very low (< 20%) and amount is negligible
  if (pop !== null && pop < 20 && amt < 0.02) {
    if (base === 'drizzle' || base === 'rain' || base === 'snow' || base === 'storm') {
      return pop < 10 || code === 80 || code === 85 ? 'partly' : 'overcast';
    }
  }

  // Rule B: Surface light precipitation when probability is meaningful (>= 35%) even if deterministic code <= 3
  if (pop !== null && pop >= 35 && (base === 'clear' || base === 'partly' || base === 'overcast')) {
    base = Number(tempF) <= 32 ? 'snow' : 'rain';
  }

  // Rule C: Scale rain & snow droplet/crystal density monotonically with probability & intensity
  if (base === 'drizzle' || base === 'rain') {
    const heavyCode = code === 65 || code === 67 || code === 82;
    if ((pop !== null && pop >= 75) || (pop !== null && pop >= 50 && (amt >= 0.15 || heavyCode)) || (pop === null && heavyCode)) {
      return 'heavy-rain';
    }
    if ((pop !== null && pop >= 45) || (pop === null && base === 'rain' && code !== 61 && code !== 80)) {
      return 'rain';
    }
    return 'light-rain';
  }

  if (base === 'snow') {
    if ((pop !== null && pop >= 55) || (pop === null && code >= 73)) {
      return 'heavy-snow';
    }
    return 'light-snow';
  }

  return base;
}

const MINI_KIND_INFO = {
  clear: { dayLabel: 'Clear & Sunny', nightLabel: 'Clear Night', dayCue: 'Sunny skies', nightCue: 'Starry clear sky' },
  partly: { dayLabel: 'Partly Cloudy', nightLabel: 'Partly Cloudy', dayCue: 'Sun & scattered white clouds', nightCue: 'Moon & scattered clouds' },
  overcast: { label: 'Overcast', cue: 'Full grey cloud deck (dry)' },
  fog: { label: 'Fog', cue: 'Low mist & valley fog' },
  'light-rain': { label: 'Light Rain', cue: 'Drizzle or light showers' },
  rain: { label: 'Rain', cue: 'Steady moderate rain' },
  'heavy-rain': { label: 'Heavy Rain', cue: 'Heavy rain or downpour' },
  'light-snow': { label: 'Light Snow', cue: 'Snow flurries or light snow' },
  'heavy-snow': { label: 'Heavy Snow', cue: 'Steady or heavy snowfall' },
  storm: { label: 'Thunderstorm', cue: 'Thunder & lightning' },
};

export function describeMiniIcon(weatherCode, isDay = 1, opts = {}) {
  const kind = resolveIconKind(weatherCode, isDay, opts);
  const meta = MINI_KIND_INFO[kind] || MINI_KIND_INFO.partly;
  const label = meta.label || (isDay ? meta.dayLabel : meta.nightLabel);
  const cue = meta.cue || (isDay ? meta.dayCue : meta.nightCue);
  return { kind, label, cue };
}

export function renderMiniIsoIcon(weatherCode, isDay = 1, opts = {}) {
  const kind = resolveIconKind(weatherCode, isDay, opts);
  let body = '';

  const sunPal = { top: '#fef08a', left: '#facc15', right: '#d97706', stroke: '#b45309', strokeWidth: 0.9 };
  const whiteCloud = { top: '#ffffff', left: '#dbeafe', right: '#b4c9e2', outline: '#475569', outlineWidth: 2.0 };
  const overcastFrontCloud = { top: '#e2e8f0', left: '#cbd5e1', right: '#94a3b8', outline: '#334155', outlineWidth: 2.0 };
  const rainCloud = { top: '#e8f0f8', left: '#c5d4e6', right: '#94abc2', outline: '#334155', outlineWidth: 2.0 };
  const darkCloud = { top: '#94a3b8', left: '#64748b', right: '#475569', outline: '#1e293b', outlineWidth: 2.1 };

  if (kind === 'clear') {
    if (isDay) {
      const proj = createProjector(24, 29, 7.6, 3.8, 7.6);
      const rays = [0, 60, 120, 180, 240, 300]
        .map((deg) => {
          const rad = (deg * Math.PI) / 180;
          const x1 = (24 + Math.cos(rad) * 13.5).toFixed(1);
          const y1 = (24 + Math.sin(rad) * 13.5).toFixed(1);
          const x2 = (24 + Math.cos(rad) * 18.2).toFixed(1);
          const y2 = (24 + Math.sin(rad) * 18.2).toFixed(1);
          return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f59e0b" stroke-width="2.4" stroke-linecap="round"/>`;
        })
        .join('');
      body = `<circle cx="24" cy="24" r="15" fill="#fde047" opacity="0.22"/>${rays}${isoBox(proj, -0.7, -0.7, 0.15, 1.4, 1.4, 1.4, sunPal)}`;
    } else {
      body =
        '<path d="M27.5 11.5a11.5 11.5 0 1 0 10.5 16.2 9.2 9.2 0 0 1-10.5-16.2z" fill="#facc15" stroke="#b45309" stroke-width="1.2" stroke-linejoin="round"/>' +
        '<polygon points="35,10 36.4,13.6 40,15 36.4,16.4 35,20 33.6,16.4 30,15 33.6,13.6" fill="#f59e0b"/>' +
        '<polygon points="38,24 39,26.2 41.2,27.2 39,28.2 38,30.4 37,28.2 34.8,27.2 37,26.2" fill="#f59e0b"/>';
    }
  } else if (kind === 'partly') {
    const sunProj = createProjector(31.5, 19.5, 6.2, 3.1, 6.2);
    const cloudProj = createProjector(21, 31.5, 7.6, 3.8, 7.6);
    const behind = isDay
      ? '<line x1="31.5" y1="4.5" x2="31.5" y2="8" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round"/>' +
        '<line x1="40.5" y1="8" x2="38" y2="10.5" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round"/>' +
        '<line x1="44" y1="16" x2="40.5" y2="16" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round"/>' +
        isoBox(sunProj, -0.65, -0.65, 0.1, 1.3, 1.3, 1.3, sunPal)
      : '<path d="M32 8.5a8 8 0 1 0 7.2 11.4A6.5 6.5 0 0 1 32 8.5z" fill="#facc15" stroke="#b45309" stroke-width="1.1" stroke-linejoin="round"/>';
    body = behind + renderMiniVoxelCloud(cloudProj, whiteCloud);
  } else if (kind === 'overcast') {
    const backProj = createProjector(28.5, 21.5, 6.8, 3.4, 6.8);
    const frontProj = createProjector(20.5, 31.5, 7.5, 3.75, 7.5);
    body = renderMiniVoxelCloud(backProj, darkCloud) + renderMiniVoxelCloud(frontProj, overcastFrontCloud);
  } else if (kind === 'fog') {
    const cloudProj = createProjector(24.5, 20.5, 7.2, 3.6, 7.2);
    body =
      renderMiniVoxelCloud(cloudProj, overcastFrontCloud) +
      '<line x1="9" y1="27.5" x2="38" y2="27.5" stroke="#64748b" stroke-width="3.2" stroke-linecap="round"/>' +
      '<line x1="12" y1="33.8" x2="40" y2="33.8" stroke="#64748b" stroke-width="3.2" stroke-linecap="round"/>' +
      '<line x1="10" y1="40" x2="35" y2="40" stroke="#94a3b8" stroke-width="3.2" stroke-linecap="round"/>';
  } else if (kind === 'light-rain') {
    const proj = createProjector(25, 20.5, 7.7, 3.85, 7.7);
    const drops =
      '<line x1="18.5" y1="27" x2="15.5" y2="34.5" stroke="#0284c7" stroke-width="2.5" stroke-linecap="round"/>' +
      '<line x1="29" y1="27" x2="26" y2="34.5" stroke="#0284c7" stroke-width="2.5" stroke-linecap="round"/>';
    body = drops + renderMiniVoxelCloud(proj, whiteCloud);
  } else if (kind === 'rain') {
    const proj = createProjector(25, 20.5, 7.7, 3.85, 7.7);
    const drops = [
      [14, 26.5, 10, 37],
      [24, 27.5, 19.5, 39.5],
      [34, 26.5, 30, 37],
    ]
      .map(
        ([x1, y1, x2, y2]) =>
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0284c7" stroke-width="2.7" stroke-linecap="round"/>`,
      )
      .join('');
    body = drops + renderMiniVoxelCloud(proj, rainCloud);
  } else if (kind === 'heavy-rain') {
    const proj = createProjector(25, 20.5, 7.7, 3.85, 7.7);
    const drops = [
      [12, 26, 8, 37],
      [18.5, 29, 13.5, 43],
      [25, 26, 21, 38],
      [31.5, 29, 26.5, 43],
      [38, 26, 34, 37],
    ]
      .map(
        ([x1, y1, x2, y2]) =>
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0284c7" stroke-width="2.9" stroke-linecap="round"/>`,
      )
      .join('');
    body = drops + renderMiniVoxelCloud(proj, darkCloud);
  } else if (kind === 'light-snow') {
    const proj = createProjector(25, 20.5, 7.7, 3.85, 7.7);
    const flakes = snowflakeSprite(18, 35, 4.5) + snowflakeSprite(30, 35, 4.5);
    body = flakes + renderMiniVoxelCloud(proj, whiteCloud);
  } else if (kind === 'heavy-snow') {
    const proj = createProjector(25, 20.5, 7.7, 3.85, 7.7);
    const flakes = snowflakeSprite(13.5, 34, 4.5) + snowflakeSprite(24, 39, 4.6) + snowflakeSprite(34.5, 34, 4.5);
    body = flakes + renderMiniVoxelCloud(proj, whiteCloud);
  } else if (kind === 'storm') {
    const proj = createProjector(25, 19.5, 7.7, 3.85, 7.7);
    const bolt =
      '<polygon points="24,22 18,33 23.5,33 19.5,44 30,30.5 24.5,30.5" fill="#facc15" stroke="#b45309" stroke-width="1.1" stroke-linejoin="round"/>';
    const rain =
      '<line x1="13" y1="27" x2="9" y2="38" stroke="#0284c7" stroke-width="2.7" stroke-linecap="round"/>' +
      '<line x1="35" y1="27" x2="31" y2="38" stroke="#0284c7" stroke-width="2.7" stroke-linecap="round"/>';
    body = rain + bolt + renderMiniVoxelCloud(proj, darkCloud);
  }

  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}

// ============================================================================
// Normalized Absolute Temperature Scale & Connected Hourly 3D Ribbon
// ============================================================================

const TEMP_STOPS = [
  [10, [99, 102, 241]],  // Arctic indigo
  [28, [56, 189, 248]],  // Freezing sky blue
  [42, [34, 184, 207]],  // Chilly cyan
  [55, [45, 212, 191]],  // Cool-mild seafoam teal
  [66, [132, 204, 22]],  // Mild spring green
  [75, [234, 179, 8]],   // Warm gold
  [85, [249, 115, 22]],  // Hot orange
  [96, [239, 68, 68]],   // Scorching red
];

function tempToRgb(tempF) {
  const t = Number(tempF);
  if (t <= TEMP_STOPS[0][0]) return TEMP_STOPS[0][1];
  const last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (t >= last[0]) return last[1];

  for (let i = 0; i < TEMP_STOPS.length - 1; i += 1) {
    const [t0, c0] = TEMP_STOPS[i];
    const [t1, c1] = TEMP_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return last[1];
}

function rgbToHex([r, g, b]) {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function tempToHex(tempF) {
  return rgbToHex(tempToRgb(tempF));
}

export function tempRangeGradient(lowF, highF, direction = '90deg') {
  const lo = Number(lowF);
  const hi = Number(highF);
  const stops = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const c = tempToHex(lo + (hi - lo) * f);
    return `${c} ${Math.round(f * 100)}%`;
  });
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}

export function renderHourlyCurveSegment({
  tempLabel,
  tempF,
  yPrev,
  yCurr,
  yNext,
  isFirst,
  isLast,
}) {
  const yLeft = isFirst ? yCurr : Number(((yPrev + yCurr) / 2).toFixed(1));
  const yRight = isLast ? yCurr : Number(((yCurr + yNext) / 2).toFixed(1));
  const yc = Number(yCurr.toFixed(1));

  const [r, g, b] = tempToRgb(tempF);
  const cMain = rgbToHex([r, g, b]);
  const cLip = rgbToHex([Math.round(r * 0.7), Math.round(g * 0.7), Math.round(b * 0.7)]);
  const cTop = rgbToHex([
    Math.round(r + (255 - r) * 0.45),
    Math.round(g + (255 - g) * 0.45),
    Math.round(b + (255 - b) * 0.45),
  ]);

  const x0 = isFirst ? 50 : 0;
  const x1 = isLast ? 50 : 100;
  const yStart = isFirst ? yc : yLeft;
  const yEnd = isLast ? yc : yRight;

  return `<svg class="hour-curve-bg" viewBox="0 0 100 58" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polygon points="${x0},${yStart} 50,${yc} ${x1},${yEnd} ${x1},58 ${x0},58" fill="${cMain}" opacity="0.11"/>
      <polygon points="${x0},${yStart} 50,${yc} ${x1},${yEnd} ${x1},${yEnd + 4} 50,${yc + 4} ${x0},${yStart + 4}" fill="${cLip}" opacity="0.65"/>
      <polyline points="${x0},${yStart} 50,${yc} ${x1},${yEnd}" fill="none" stroke="${cMain}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="butt"/>
    </svg>
    <svg class="hour-curve-fg" viewBox="0 0 56 58" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polygon points="28,${yc - 4.6} 33,${yc - 2} 28,${yc + 0.5} 23,${yc - 2}" fill="${cTop}"/>
      <polygon points="23,${yc - 2} 28,${yc + 0.5} 28,${yc + 5} 23,${yc + 2.5}" fill="${cMain}"/>
      <polygon points="28,${yc + 0.5} 33,${yc - 2} 33,${yc + 2.5} 28,${yc + 5}" fill="${cLip}"/>
    </svg>`;
}
