// ============================================================================
// Overworld — Adaptive Dual-Provider Radar + Cartoon Pixel-Art Basemap
// ============================================================================

import { createCartoonPixelMapLayers } from './pixel-map.js';

const IEM_FRAMES = [
  { layer: 'nexrad-n0q-900913-m30m', label: '-30m' },
  { layer: 'nexrad-n0q-900913-m25m', label: '-25m' },
  { layer: 'nexrad-n0q-900913-m20m', label: '-20m' },
  { layer: 'nexrad-n0q-900913-m15m', label: '-15m' },
  { layer: 'nexrad-n0q-900913-m10m', label: '-10m' },
  { layer: 'nexrad-n0q-900913-m05m', label: '-5m' },
  { layer: 'nexrad-n0q-900913', label: 'Now' },
];

export function isConusRadarSupported(lat, lon) {
  return lat >= 23.5 && lat <= 50.5 && lon >= -126.5 && lon <= -65.5;
}

export function createRadarController({
  disclosureEl,
  mapEl,
  providerTagEl,
  playBtnEl,
  timelineEl,
  frameTimeEl,
}) {
  const darkMql = window.matchMedia('(prefers-color-scheme: dark)');

  const state = {
    lat: null,
    lon: null,
    timezone: 'UTC',
    isConus: true,
    map: null,
    pixelMap: null,
    marker: null,
    radarLayers: [],
    frameLabels: [],
    activeIndex: 0,
    isPlaying: true,
    timerId: null,
    needsSync: false,
    loadToken: 0,
  };

  function stopLoop() {
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
  }

  function showFrame(idx) {
    if (!state.radarLayers.length) return;
    const clamped = Math.max(0, Math.min(idx, state.radarLayers.length - 1));
    state.activeIndex = clamped;

    state.radarLayers.forEach((layer, i) => {
      layer.setOpacity(i === clamped ? 0.82 : 0);
    });

    timelineEl.value = String(clamped);
    frameTimeEl.textContent = state.frameLabels[clamped] || 'Now';
  }

  function scheduleNextTick() {
    stopLoop();
    if (!state.isPlaying || !disclosureEl.open || state.radarLayers.length <= 1) return;

    const isLatest = state.activeIndex === state.radarLayers.length - 1;
    const delay = isLatest ? 1400 : 750;
    state.timerId = setTimeout(() => {
      const next = (state.activeIndex + 1) % state.radarLayers.length;
      showFrame(next);
      scheduleNextTick();
    }, delay);
  }

  function clearRadarLayers() {
    stopLoop();
    if (state.map) {
      for (const layer of state.radarLayers) {
        state.map.removeLayer(layer);
      }
    }
    state.radarLayers = [];
    state.frameLabels = [];
  }

  function ensureMap() {
    if (state.map) return true;
    const L = window.L;
    if (!L) return false;

    const initialZoom = state.isConus ? 7 : 6;
    state.map = L.map(mapEl, {
      center: [state.lat, state.lon],
      zoom: initialZoom,
      minZoom: 3,
      maxZoom: 13,
      zoomControl: true,
      attributionControl: false,
    });

    state.map.createPane('pixelBase').style.zIndex = '200';
    state.map.createPane('pixelRadar').style.zIndex = '450';
    const labelsPane = state.map.createPane('pixelLabels');
    labelsPane.style.zIndex = '620';
    labelsPane.style.pointerEvents = 'none';

    state.pixelMap = createCartoonPixelMapLayers(L, darkMql.matches);
    state.pixelMap.baseLayer.addTo(state.map);
    state.pixelMap.labelLayer.addTo(state.map);

    const pinIcon = L.divIcon({
      className: 'iso-map-pin-wrapper',
      html: '<div class="iso-map-pin"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    state.marker = L.marker([state.lat, state.lon], { icon: pinIcon, interactive: false }).addTo(state.map);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => state.map?.invalidateSize()).observe(mapEl);
    }

    return true;
  }

  function loadConusLayers() {
    const L = window.L;
    clearRadarLayers();
    state.frameLabels = IEM_FRAMES.map((f) => f.label);

    for (const frame of IEM_FRAMES) {
      const layer = L.tileLayer(
        `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${frame.layer}/{z}/{x}/{y}.png`,
        {
          pane: 'pixelRadar',
          opacity: 0,
          transparent: true,
          maxNativeZoom: 12,
          maxZoom: 13,
        },
      ).addTo(state.map);
      state.radarLayers.push(layer);
    }

    timelineEl.max = String(state.radarLayers.length - 1);
    showFrame(state.radarLayers.length - 1);
    scheduleNextTick();
  }

  async function loadRainViewerLayers(token) {
    const L = window.L;
    clearRadarLayers();
    frameTimeEl.textContent = 'Loading…';

    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) throw new Error('RainViewer index unavailable');
      const data = await res.json();
      if (token !== state.loadToken) return;

      const past = Array.isArray(data?.radar?.past) ? data.radar.past.slice(-7) : [];
      if (!past.length) {
        frameTimeEl.textContent = 'Unavailable';
        return;
      }

      const host = data.host || 'https://tilecache.rainviewer.com';
      const timeFmt = new Intl.DateTimeFormat(undefined, {
        timeZone: state.timezone || 'UTC',
        hour: 'numeric',
        minute: '2-digit',
      });

      state.frameLabels = past.map((frame, i) =>
        i === past.length - 1 ? 'Now' : timeFmt.format(new Date(frame.time * 1000)),
      );

      for (const frame of past) {
        const layer = L.tileLayer(`${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
          pane: 'pixelRadar',
          opacity: 0,
          transparent: true,
          maxNativeZoom: 7,
          maxZoom: 13,
        }).addTo(state.map);
        state.radarLayers.push(layer);
      }

      timelineEl.max = String(state.radarLayers.length - 1);
      showFrame(state.radarLayers.length - 1);
      scheduleNextTick();
    } catch {
      if (token === state.loadToken) {
        frameTimeEl.textContent = 'Radar offline';
      }
    }
  }

  async function syncMapToLocation() {
    if (state.lat === null || state.lon === null) return;
    if (!ensureMap()) return;

    state.needsSync = false;
    const token = ++state.loadToken;
    const targetZoom = state.isConus ? 7 : 6;

    state.map.setView([state.lat, state.lon], targetZoom, { animate: false });
    state.marker?.setLatLng([state.lat, state.lon]);

    requestAnimationFrame(() => {
      state.map?.invalidateSize();
    });

    if (state.isConus) {
      loadConusLayers();
    } else {
      await loadRainViewerLayers(token);
    }
  }

  // Keep cartoon pixel basemap synced live with OS light/dark preference
  darkMql.addEventListener('change', (e) => {
    state.pixelMap?.setDarkMode(e.matches);
  });

  disclosureEl.addEventListener('toggle', () => {
    if (disclosureEl.open) {
      if (state.needsSync || !state.map) {
        syncMapToLocation();
      } else {
        requestAnimationFrame(() => {
          state.map?.invalidateSize();
        });
        scheduleNextTick();
      }
    } else {
      stopLoop();
    }
  });

  playBtnEl.addEventListener('click', () => {
    state.isPlaying = !state.isPlaying;
    playBtnEl.textContent = state.isPlaying ? 'Pause' : 'Play';
    if (state.isPlaying) {
      scheduleNextTick();
    } else {
      stopLoop();
    }
  });

  timelineEl.addEventListener('input', () => {
    state.isPlaying = false;
    playBtnEl.textContent = 'Play';
    stopLoop();
    showFrame(Number(timelineEl.value));
  });

  return {
    setLocation({ lat, lon, timezone }) {
      state.lat = lat;
      state.lon = lon;
      state.timezone = timezone || 'UTC';
      state.isConus = isConusRadarSupported(lat, lon);
      state.needsSync = true;

      providerTagEl.textContent = state.isConus ? 'NOAA NEXRAD · US' : 'RainViewer · Global';

      if (disclosureEl.open) {
        syncMapToLocation();
      }
    },
  };
}
