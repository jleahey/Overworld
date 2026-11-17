// ============================================================================
// Overworld — Application Controller & Temporal Date Logic
// ============================================================================

import {
  HERO_SCENE_PRESETS,
  MINI_ICON_SPECS,
  classifyWeather,
  renderHeroDiorama,
  renderHourlyCurveSegment,
  renderMiniIsoIcon,
  tempRangeGradient,
} from './iso-art.js';
import {
  buildHeroSceneState,
  describeImmediatePrecip,
  describeSceneStory,
  evaluateRadarInterest,
  fetchForecast,
  fetchNwsAlerts,
  formatPlaceLabel,
  formatSpeed,
  formatTemp,
  getCachedForecast,
  reverseGeocode,
  searchLocations,
} from './api.js';
import { createRadarController } from './radar.js';

const STORAGE_LAST_LOC = 'ws_last_location';
const STORAGE_RECENT_LOCS = 'ws_recent_locations';
const STORAGE_UNIT = 'ws_unit';

const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TIMEZONE_DEFAULTS = {
  'America/Los_Angeles': { name: 'Seattle', admin1: 'Washington', country: 'United States', countryCode: 'US', lat: 47.6062, lon: -122.3321 },
  'America/New_York': { name: 'New York', admin1: 'New York', country: 'United States', countryCode: 'US', lat: 40.7128, lon: -74.006 },
  'America/Chicago': { name: 'Chicago', admin1: 'Illinois', country: 'United States', countryCode: 'US', lat: 41.8781, lon: -87.6298 },
  'America/Denver': { name: 'Denver', admin1: 'Colorado', country: 'United States', countryCode: 'US', lat: 39.7392, lon: -104.9903 },
  'America/Phoenix': { name: 'Phoenix', admin1: 'Arizona', country: 'United States', countryCode: 'US', lat: 33.4484, lon: -112.074 },
  'America/Anchorage': { name: 'Anchorage', admin1: 'Alaska', country: 'United States', countryCode: 'US', lat: 61.2181, lon: -149.9003 },
  'Pacific/Honolulu': { name: 'Honolulu', admin1: 'Hawaii', country: 'United States', countryCode: 'US', lat: 21.3069, lon: -157.8583 },
  'Europe/London': { name: 'London', admin1: 'England', country: 'United Kingdom', countryCode: 'GB', lat: 51.5074, lon: -0.1278 },
  'Europe/Paris': { name: 'Paris', admin1: 'Île-de-France', country: 'France', countryCode: 'FR', lat: 48.8566, lon: 2.3522 },
  'Asia/Tokyo': { name: 'Tokyo', admin1: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.6762, lon: 139.6503 },
  'Australia/Sydney': { name: 'Sydney', admin1: 'New South Wales', country: 'Australia', countryCode: 'AU', lat: -33.8688, lon: 151.2093 },
};

// ============================================================================
// Temporal Polyfill Loader & Location-Agnostic Date/Time Helpers
// ============================================================================

async function ensureTemporal() {
  if (typeof globalThis.Temporal === 'undefined') {
    try {
      const mod = await import('https://esm.sh/temporal-polyfill');
      globalThis.Temporal = mod.Temporal;
      if (mod.toTemporalInstant && !Date.prototype.toTemporalInstant) {
        Date.prototype.toTemporalInstant = mod.toTemporalInstant;
      }
    } catch {
      // Fallback integer helpers below handle offline environments gracefully
    }
  }
}

function parsePlainDateTime(isoStr) {
  if (typeof globalThis.Temporal !== 'undefined') {
    const pdt = globalThis.Temporal.PlainDateTime.from(isoStr);
    return { year: pdt.year, month: pdt.month, day: pdt.day, hour: pdt.hour, minute: pdt.minute, raw: pdt };
  }
  const [datePart, timePart = '00:00'] = String(isoStr).split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm = 0] = timePart.split(':').map(Number);
  return { year: y, month: m, day: d, hour: hh, minute: mm, raw: null };
}

function comparePlainDateTime(aStr, bStr) {
  if (typeof globalThis.Temporal !== 'undefined') {
    return globalThis.Temporal.PlainDateTime.compare(
      globalThis.Temporal.PlainDateTime.from(aStr),
      globalThis.Temporal.PlainDateTime.from(bStr),
    );
  }
  return aStr.localeCompare(bStr);
}

function getWeekdayShort(isoDateStr) {
  if (typeof globalThis.Temporal !== 'undefined') {
    const pd = globalThis.Temporal.PlainDate.from(isoDateStr);
    return WEEKDAYS_SHORT[pd.dayOfWeek - 1] || '';
  }
  // Tomohiko Sakamoto day-of-week algorithm (0=Sun..6=Sat), zero Date timezone drift
  let [y, m, d] = isoDateStr.split('-').map(Number);
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  if (m < 3) y -= 1;
  const dowSun0 = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7;
  const isoDow = dowSun0 === 0 ? 7 : dowSun0;
  return WEEKDAYS_SHORT[isoDow - 1] || '';
}

function formatHour12(hour24) {
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const h = hour24 % 12 || 12;
  return `${h} ${suffix}`;
}

function formatHourCompact(hour24) {
  const suffix = hour24 >= 12 ? 'p' : 'a';
  const h = hour24 % 12 || 12;
  return `${h}${suffix}`;
}

function findCurrentHourIndex(hourlyTimes, currentTimeStr) {
  if (!Array.isArray(hourlyTimes) || !hourlyTimes.length) return 0;
  let best = 0;
  for (let i = 0; i < hourlyTimes.length; i += 1) {
    if (comparePlainDateTime(hourlyTimes[i], currentTimeStr) <= 0) {
      best = i;
    } else {
      break;
    }
  }
  return best;
}

// ============================================================================
// Persistent State & URL Sync
// ============================================================================

function loadInitialUnit() {
  const saved = localStorage.getItem(STORAGE_UNIT);
  if (saved === 'F' || saved === 'C') return saved;
  return navigator.language === 'en-US' ? 'F' : 'C';
}

function loadInitialLocation() {
  const params = new URLSearchParams(window.location.search);
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  const name = params.get('name');
  if (Number.isFinite(lat) && Number.isFinite(lon) && params.has('lat') && params.has('lon') && name) {
    return {
      name,
      admin1: params.get('admin1') || '',
      country: params.get('country') || '',
      countryCode: params.get('cc') || '',
      lat,
      lon,
    };
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_LAST_LOC) || 'null');
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && saved.name) {
      return saved;
    }
  } catch {
    // Ignore storage error
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fallback = TIMEZONE_DEFAULTS[tz] || TIMEZONE_DEFAULTS['America/Los_Angeles'];
  return { ...fallback, isDefaultFallback: true };
}

function isSameLocation(a, b) {
  return Math.abs(Number(a.lat) - Number(b.lat)) < 0.03 && Math.abs(Number(a.lon) - Number(b.lon)) < 0.03;
}

function saveRecentLocations(list) {
  try {
    localStorage.setItem(STORAGE_RECENT_LOCS, JSON.stringify(list));
  } catch {
    // Ignore storage error
  }
  renderLocationPager();
}

function syncLocationUrlAndStorage(loc) {
  if (loc.isDefaultFallback) {
    renderLocationPager();
    return;
  }

  const cleanLoc = {
    name: loc.name,
    admin1: loc.admin1 || '',
    country: loc.country || '',
    countryCode: loc.countryCode || '',
    lat: loc.lat,
    lon: loc.lon,
  };

  const url = new URL(window.location.href);
  url.searchParams.set('lat', Number(cleanLoc.lat).toFixed(4));
  url.searchParams.set('lon', Number(cleanLoc.lon).toFixed(4));
  url.searchParams.set('name', cleanLoc.name);
  if (cleanLoc.admin1) url.searchParams.set('admin1', cleanLoc.admin1);
  else url.searchParams.delete('admin1');
  if (cleanLoc.countryCode) url.searchParams.set('cc', cleanLoc.countryCode);
  else url.searchParams.delete('cc');
  history.replaceState(null, '', url.toString());

  try {
    localStorage.setItem(STORAGE_LAST_LOC, JSON.stringify(cleanLoc));
    const recent = loadRecentLocations();
    const existingIdx = recent.findIndex((item) => isSameLocation(item, cleanLoc));
    if (existingIdx !== -1) {
      // Preserve user-defined order while keeping coordinates/admin metadata fresh
      recent[existingIdx] = { ...recent[existingIdx], ...cleanLoc };
    } else {
      recent.unshift(cleanLoc);
    }
    saveRecentLocations(recent.slice(0, 8));
  } catch {
    // Ignore storage error
  }
}

function loadRecentLocations() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_RECENT_LOCS) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function deleteRecentLocation(locToRemove) {
  const remaining = loadRecentLocations().filter((item) => !isSameLocation(item, locToRemove));
  saveRecentLocations(remaining);
  if (remaining.length > 0) {
    renderDropdown(remaining, 'Recent');
  } else {
    closeDropdown();
  }
}

// ============================================================================
// DOM Elements & App Initialization
// ============================================================================

const els = {
  appMain: document.getElementById('app-main'),
  searchForm: document.getElementById('search-form'),
  cityInput: document.getElementById('city-input'),
  searchResults: document.getElementById('search-results'),
  reorderStatus: document.getElementById('reorder-status'),
  locationPager: document.getElementById('location-pager'),
  locPrevBtn: document.getElementById('loc-prev-btn'),
  locDots: document.getElementById('loc-dots'),
  locNextBtn: document.getElementById('loc-next-btn'),
  swipePeek: document.getElementById('swipe-peek'),
  locateBtn: document.getElementById('locate-btn'),
  unitToggle: document.getElementById('unit-toggle'),
  alertsSlot: document.getElementById('alerts-slot'),
  locationKicker: document.getElementById('location-kicker'),
  cityHeading: document.getElementById('city-heading'),
  currentTemp: document.getElementById('current-temp'),
  currentSummary: document.getElementById('current-summary'),
  statFeels: document.getElementById('stat-feels'),
  statHiLow: document.getElementById('stat-hilow'),
  statWind: document.getElementById('stat-wind'),
  statPrecipLabel: document.getElementById('stat-precip-label'),
  statPrecip: document.getElementById('stat-precip'),
  tileWind: document.getElementById('tile-wind'),
  tileHumidity: document.getElementById('tile-humidity'),
  tileUv: document.getElementById('tile-uv'),
  statHumidity: document.getElementById('stat-humidity'),
  statUv: document.getElementById('stat-uv'),
  heroDiorama: document.getElementById('hero-diorama'),
  radarDisclosure: document.getElementById('radar-disclosure'),
  radarSummary: document.getElementById('radar-summary'),
  radarReasonBadge: document.getElementById('radar-reason-badge'),
  radarProviderTag: document.getElementById('radar-provider-tag'),
  radarToggleCta: document.getElementById('radar-toggle-cta'),
  radarMap: document.getElementById('radar-map'),
  radarPlayBtn: document.getElementById('radar-play-btn'),
  radarTimeline: document.getElementById('radar-timeline'),
  radarFrameTime: document.getElementById('radar-frame-time'),
  hourlyTakeaway: document.getElementById('hourly-takeaway'),
  hourlyPrev: document.getElementById('hourly-prev'),
  hourlyNext: document.getElementById('hourly-next'),
  hourlyList: document.getElementById('hourly-list'),
  dailyPrev: document.getElementById('daily-prev'),
  dailyNext: document.getElementById('daily-next'),
  dailyList: document.getElementById('daily-list'),
  heroDebugReset: document.getElementById('hero-debug-reset'),
  sceneDebugDialog: document.getElementById('scene-debug-dialog'),
  mixerPreview: document.getElementById('mixer-preview'),
  mixerStory: document.getElementById('mixer-story'),
  mixerTime: document.getElementById('mixer-time'),
  mixerSky: document.getElementById('mixer-sky'),
  mixerTransition: document.getElementById('mixer-transition'),
  mixerEta: document.getElementById('mixer-eta'),
  mixerTemp: document.getElementById('mixer-temp'),
  mixerTempVal: document.getElementById('mixer-temp-val'),
  mixerWind: document.getElementById('mixer-wind'),
  mixerWindVal: document.getElementById('mixer-wind-val'),
  mixerApplyBtn: document.getElementById('mixer-apply-btn'),
  mixerResetBtn: document.getElementById('mixer-reset-btn'),
  debugPresetGrid: document.getElementById('debug-preset-grid'),
  debugIconGrid: document.getElementById('debug-icon-grid'),
};

const appState = {
  location: loadInitialLocation(),
  unit: loadInitialUnit(),
  forecast: null,
  alerts: [],
  radarManuallyToggled: false,
  liveHeroScene: null,
  debugHeroOverride: null,
  debugGalleryBuilt: false,
  requestSeq: 0,
};

const radar = createRadarController({
  disclosureEl: els.radarDisclosure,
  mapEl: els.radarMap,
  providerTagEl: els.radarProviderTag,
  playBtnEl: els.radarPlayBtn,
  timelineEl: els.radarTimeline,
  frameTimeEl: els.radarFrameTime,
});

// ============================================================================
// Renderers
// ============================================================================

function syncRadarToggleCta() {
  els.radarToggleCta.textContent = els.radarDisclosure.open ? 'Hide Map' : 'Show Map';
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    els.alertsSlot.hidden = true;
    els.alertsSlot.replaceChildren();
    return;
  }

  const nodes = alerts.slice(0, 3).map((alert) => {
    const details = document.createElement('details');
    details.className = 'alert-details';

    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.textContent = alert.event;
    const sev = document.createElement('span');
    sev.className = 'alert-severity';
    sev.textContent = alert.severity;
    summary.append(title, sev);

    const body = document.createElement('div');
    body.className = 'alert-body';
    if (alert.headline) {
      const p = document.createElement('p');
      p.textContent = alert.headline;
      body.appendChild(p);
    }
    if (alert.instruction || alert.description) {
      const p = document.createElement('p');
      p.textContent = (alert.instruction || alert.description).slice(0, 320);
      body.appendChild(p);
    }

    details.append(summary, body);
    return details;
  });

  els.alertsSlot.replaceChildren(...nodes);
  els.alertsSlot.hidden = false;
}

function buildHourlyTakeaway(hourly, startIdx) {
  const endIdx = Math.min(hourly.time.length, startIdx + 24);
  let firstWet = -1;
  let firstDryAfterWet = -1;
  const startingWet =
    Number(hourly.precipitation[startIdx] ?? 0) > 0.01 ||
    Number(hourly.precipitation_probability[startIdx] ?? 0) >= 45 ||
    Number(hourly.weather_code[startIdx] ?? 0) >= 51;

  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const isWet =
      Number(hourly.precipitation[i] ?? 0) > 0.01 ||
      Number(hourly.precipitation_probability[i] ?? 0) >= 40 ||
      Number(hourly.weather_code[i] ?? 0) >= 51;
    if (!startingWet && isWet && firstWet === -1) {
      firstWet = i;
      break;
    }
    if (startingWet && !isWet && firstDryAfterWet === -1) {
      firstDryAfterWet = i;
      break;
    }
  }

  if (!startingWet && firstWet !== -1) {
    const { hour } = parsePlainDateTime(hourly.time[firstWet]);
    return `Precipitation likely around ${formatHour12(hour)}`;
  }
  if (startingWet && firstDryAfterWet !== -1) {
    const { hour } = parsePlainDateTime(hourly.time[firstDryAfterWet]);
    return `Tapering off around ${formatHour12(hour)}`;
  }
  if (startingWet) return 'Periods of precipitation over the next 24h';
  return 'Dry conditions expected over the next 24h';
}

function renderAll({ freshnessLabel = 'Updated just now', isInitialLocationLoad = false } = {}) {
  const forecast = appState.forecast;
  if (!forecast) return;

  const { location, unit, alerts } = appState;
  const current = forecast.current;
  const hourly = forecast.hourly;
  const daily = forecast.daily;
  const currentHourIdx = findCurrentHourIndex(hourly.time, current.time);

  // Bottom °F / °C unit toggle pill
  for (const pill of els.unitToggle.querySelectorAll('.unit-pill')) {
    pill.classList.toggle('is-active', pill.dataset.unit === unit);
  }
  els.unitToggle.setAttribute(
    'aria-label',
    unit === 'F' ? '°F / °C — switch to Celsius' : '°F / °C — switch to Fahrenheit',
  );

  // Alerts & saved location pager
  renderLocationPager();
  renderAlerts(alerts);

  // Hero readout + always-visible 4-metric strip
  const place = formatPlaceLabel(location);
  els.locationKicker.textContent = place ? `${place} · ${freshnessLabel}` : freshnessLabel;
  els.cityHeading.textContent = location.name;
  document.title = `${formatTemp(current.temperature_2m, unit)} ${location.name} · Overworld`;

  const scene = classifyWeather(
    current.weather_code,
    current.is_day,
    current.temperature_2m,
    current.wind_speed_10m,
  );

  els.currentTemp.textContent = formatTemp(current.temperature_2m, unit);
  els.currentSummary.textContent = scene.label;
  els.statFeels.textContent = formatTemp(current.apparent_temperature, unit);
  els.statHiLow.textContent = `${formatTemp(daily.temperature_2m_max[0], unit)} / ${formatTemp(daily.temperature_2m_min[0], unit)}`;

  const precipInfo = describeImmediatePrecip(forecast, currentHourIdx, unit);
  els.statPrecipLabel.textContent = precipInfo.label;
  els.statPrecip.textContent = precipInfo.value;

  // Show Wind, Humidity, and UV Index chips only when abnormal
  const windVal = Number(current.wind_speed_10m ?? 0);
  const gustVal = Number(current.wind_gusts_10m ?? 0);
  const abnormalWind = windVal >= 15 || gustVal >= 25;
  els.tileWind.hidden = !abnormalWind;
  if (abnormalWind) {
    els.statWind.textContent =
      gustVal >= windVal + 6
        ? `${formatSpeed(windVal, unit)} (${unit === 'C' ? Math.round(gustVal * 1.60934) : Math.round(gustVal)} gusts)`
        : formatSpeed(windVal, unit);
  }

  const humidity = Number(current.relative_humidity_2m);
  const abnormalHumidity = Number.isFinite(humidity) && (humidity >= 78 || humidity <= 22);
  els.tileHumidity.hidden = !abnormalHumidity;
  if (abnormalHumidity) {
    els.statHumidity.textContent = `${humidity >= 78 ? 'Humid' : 'Dry'} · ${Math.round(humidity)}%`;
  }

  const uvVal = Number(current.uv_index);
  const abnormalUv = Number.isFinite(uvVal) && uvVal >= 6;
  els.tileUv.hidden = !abnormalUv;
  if (abnormalUv) {
    const uvLabel = uvVal >= 11 ? 'Extreme' : uvVal >= 8 ? 'Very High' : 'High';
    els.statUv.textContent = `${Math.round(uvVal)} · ${uvLabel}`;
  }

  // Dynamic multi-signal hero isometric diorama
  const liveHeroScene = buildHeroSceneState(forecast, currentHourIdx);
  appState.liveHeroScene = liveHeroScene;
  const activeHeroScene = appState.debugHeroOverride || liveHeroScene;
  els.heroDiorama.innerHTML = renderHeroDiorama(activeHeroScene);
  els.heroDiorama.setAttribute(
    'aria-label',
    `Isometric sky-island illustration: ${describeSceneStory(activeHeroScene)}`,
  );
  els.heroDebugReset.hidden = !appState.debugHeroOverride;

  // Smart conditional radar badge, collapsed by default until expanded by user
  const interest = evaluateRadarInterest(forecast, alerts, currentHourIdx);
  els.radarReasonBadge.textContent = interest.reason;
  els.radarReasonBadge.dataset.interesting = String(interest.interesting);

  if (!appState.radarManuallyToggled) {
    els.radarDisclosure.open = false;
  }
  syncRadarToggleCta();

  radar.setLocation({
    lat: location.lat,
    lon: location.lon,
    timezone: forecast.timezone,
  });

  // Next 24 hours (horizontal connected elevation strip)
  els.hourlyTakeaway.textContent = buildHourlyTakeaway(hourly, currentHourIdx);
  const sliceEnd = Math.min(hourly.time.length, currentHourIdx + 24);
  const sliceTemps = [];
  for (let i = currentHourIdx; i < sliceEnd; i += 1) {
    sliceTemps.push(Number(hourly.temperature_2m[i]));
  }
  const minHourT = Math.min(...sliceTemps);
  const maxHourT = Math.max(...sliceTemps);
  const spanHourT = maxHourT - minHourT;
  const yCoords = sliceTemps.map((tempF) => {
    if (spanHourT < 0.5) return 32.5;
    const ratio = (tempF - minHourT) / spanHourT;
    return 43 - ratio * 21;
  });

  const hourCards = [];
  for (let i = currentHourIdx; i < sliceEnd; i += 1) {
    const offset = i - currentHourIdx;
    const tempF = sliceTemps[offset];
    const pop = Math.round(Number(hourly.precipitation_probability[i] ?? 0));
    const { hour } = parsePlainDateTime(hourly.time[i]);

    const li = document.createElement('li');
    li.className = offset === 0 ? 'hour-card is-now' : 'hour-card';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'hour-time';
    timeSpan.textContent = offset === 0 ? 'Now' : formatHourCompact(hour);

    const iconDiv = document.createElement('div');
    iconDiv.className = 'hour-icon';
    iconDiv.innerHTML = renderMiniIsoIcon(hourly.weather_code[i], hourly.is_day[i], {
      precipProb: pop,
      precipInches: Number(hourly.precipitation[i] ?? 0),
      tempF,
    });

    const curveWrap = document.createElement('div');
    curveWrap.className = 'hour-curve-wrap';
    curveWrap.innerHTML = renderHourlyCurveSegment({
      tempLabel: formatTemp(tempF, unit),
      tempF,
      yPrev: yCoords[Math.max(0, offset - 1)],
      yCurr: yCoords[offset],
      yNext: yCoords[Math.min(yCoords.length - 1, offset + 1)],
      isFirst: offset === 0,
      isLast: offset === yCoords.length - 1,
    });

    const popSpan = document.createElement('span');
    popSpan.className = pop >= 15 ? 'hour-pop' : 'hour-pop is-dry';
    popSpan.textContent = `${pop}%`;

    li.append(timeSpan, iconDiv, curveWrap, popSpan);
    hourCards.push(li);
  }
  els.hourlyList.replaceChildren(...hourCards);

  // 10-day forecast (horizontal columns with vertical color-graded high/low bars)
  const dayCount = Math.min(10, daily.time.length);
  const weekLow = Math.min(...daily.temperature_2m_min.slice(0, dayCount).map(Number));
  const weekHigh = Math.max(...daily.temperature_2m_max.slice(0, dayCount).map(Number));
  const weekSpan = Math.max(1, weekHigh - weekLow);

  const dayCards = [];
  for (let i = 0; i < dayCount; i += 1) {
    const lowF = Number(daily.temperature_2m_min[i]);
    const highF = Number(daily.temperature_2m_max[i]);
    const pop = Math.round(Number(daily.precipitation_probability_max[i] ?? 0));
    const bottomPct = ((lowF - weekLow) / weekSpan) * 100;
    const spanPct = ((highF - lowF) / weekSpan) * 100;

    const li = document.createElement('li');
    li.className = i === 0 ? 'hour-card is-now' : 'hour-card';

    const daySpan = document.createElement('span');
    daySpan.className = 'hour-time';
    daySpan.textContent = i === 0 ? 'Today' : getWeekdayShort(daily.time[i]);

    const iconDiv = document.createElement('div');
    iconDiv.className = 'hour-icon';
    iconDiv.innerHTML = renderMiniIsoIcon(daily.weather_code[i], 1, {
      precipProb: pop,
      precipInches: Number(daily.precipitation_sum[i] ?? 0),
      tempF: (lowF + highF) / 2,
    });

    const vbarCol = document.createElement('div');
    vbarCol.className = 'day-vbar-col';

    const highSpan = document.createElement('span');
    highSpan.className = 'day-high-label';
    highSpan.textContent = formatTemp(highF, unit);

    const vtrack = document.createElement('div');
    vtrack.className = 'day-vtrack';
    const vfill = document.createElement('div');
    vfill.className = 'day-vfill';
    vfill.style.setProperty('--vrange-bottom', `${bottomPct.toFixed(1)}%`);
    vfill.style.setProperty('--vrange-span', `${spanPct.toFixed(1)}%`);
    vfill.style.setProperty('--vrange-gradient', tempRangeGradient(highF, lowF, '180deg'));
    vtrack.appendChild(vfill);

    if (i === 0) {
      const nowPos = Math.max(0, Math.min(100, ((Number(current.temperature_2m) - weekLow) / weekSpan) * 100));
      const dot = document.createElement('span');
      dot.className = 'day-vnow-dot';
      dot.style.setProperty('--vnow-pos', `${nowPos.toFixed(1)}%`);
      vtrack.appendChild(dot);
    }

    const lowSpan = document.createElement('span');
    lowSpan.className = 'day-low-label';
    lowSpan.textContent = formatTemp(lowF, unit);

    vbarCol.append(highSpan, vtrack, lowSpan);

    const popSpan = document.createElement('span');
    popSpan.className = pop >= 10 ? 'hour-pop' : 'hour-pop is-dry';
    popSpan.textContent = `${pop}%`;

    li.append(daySpan, iconDiv, vbarCol, popSpan);
    dayCards.push(li);
  }
  els.dailyList.replaceChildren(...dayCards);
}

// ============================================================================
// Data Loading Pipeline (5-min Cache + Open-Meteo / Met.no Fallback)
// ============================================================================

function clearDisplayedWeather(loc) {
  els.cityHeading.textContent = loc.name;
  els.locationKicker.textContent = `${formatPlaceLabel(loc) || 'Loading'} · Loading forecast…`;
  els.currentTemp.textContent = '--°';
  els.currentSummary.textContent = '—';
  els.statFeels.textContent = '--°';
  els.statHiLow.textContent = '--° / --°';
  els.statPrecipLabel.textContent = 'Next Hour';
  els.statPrecip.textContent = '--';
  els.tileWind.hidden = true;
  els.tileHumidity.hidden = true;
  els.tileUv.hidden = true;
  els.hourlyTakeaway.textContent = '—';
  els.hourlyList.replaceChildren();
  els.dailyList.replaceChildren();
  els.alertsSlot.hidden = true;
  els.alertsSlot.replaceChildren();
}

async function loadWeatherForLocation(loc) {
  const seq = ++appState.requestSeq;
  appState.location = loc;
  appState.radarManuallyToggled = false;
  appState.debugHeroOverride = null;
  els.radarDisclosure.open = false;
  syncRadarToggleCta();
  syncLocationUrlAndStorage(loc);

  const cached = getCachedForecast(loc.lat, loc.lon);
  if (cached) {
    appState.forecast = cached.data;
    appState.alerts = [];
    renderAll({
      freshnessLabel: 'Updated just now',
      isInitialLocationLoad: true,
    });
    return;
  }

  appState.forecast = null;
  appState.alerts = [];
  clearDisplayedWeather(loc);

  try {
    const [freshForecast, alerts] = await Promise.all([
      fetchForecast(loc.lat, loc.lon),
      fetchNwsAlerts(loc.lat, loc.lon, loc.countryCode),
    ]);
    if (seq !== appState.requestSeq) return;

    appState.forecast = freshForecast;
    appState.alerts = alerts;
    renderAll({
      freshnessLabel: 'Updated just now',
      isInitialLocationLoad: true,
    });
  } catch {
    if (seq !== appState.requestSeq) return;
    els.locationKicker.textContent = `${formatPlaceLabel(loc) || loc.name} · Unable to reach weather service`;
    els.currentSummary.textContent = 'Check your connection and try again';
  }
}

// ============================================================================
// Saved Location Pager, Full-Page Swipe & Neighbor Prefetch
// ============================================================================

let isPageNavigating = false;
let prefetchTimerId = null;

function getActiveSavedIndex(recent = loadRecentLocations()) {
  return recent.findIndex((item) => isSameLocation(item, appState.location));
}

function renderLocationPager() {
  if (!els.locationPager) return;
  const recent = loadRecentLocations();
  if (recent.length < 2) {
    els.locationPager.hidden = true;
    return;
  }

  const activeIdx = getActiveSavedIndex(recent);
  if (activeIdx > 0) {
    els.locPrevBtn.disabled = false;
    els.locPrevBtn.textContent = `‹ ${recent[activeIdx - 1].name}`;
    els.locPrevBtn.setAttribute('aria-label', `Previous location: ${recent[activeIdx - 1].name}`);
  } else {
    els.locPrevBtn.disabled = true;
    els.locPrevBtn.textContent = '';
    els.locPrevBtn.removeAttribute('aria-label');
  }

  if (activeIdx >= 0 && activeIdx < recent.length - 1) {
    els.locNextBtn.disabled = false;
    els.locNextBtn.textContent = `${recent[activeIdx + 1].name} ›`;
    els.locNextBtn.setAttribute('aria-label', `Next location: ${recent[activeIdx + 1].name}`);
  } else {
    els.locNextBtn.disabled = true;
    els.locNextBtn.textContent = '';
    els.locNextBtn.removeAttribute('aria-label');
  }

  const dots = recent.map((loc, idx) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = idx === activeIdx ? 'pager-dot is-active' : 'pager-dot';
    dot.setAttribute('aria-label', `Switch to ${loc.name} (${idx + 1} of ${recent.length})`);
    dot.setAttribute('aria-current', idx === activeIdx ? 'true' : 'false');
    dot.addEventListener('click', () => navigateToSavedIndex(idx));
    return dot;
  });

  els.locDots.replaceChildren(...dots);
  els.locationPager.hidden = false;
}

function prefetchAdjacentLocations() {
  clearTimeout(prefetchTimerId);
  const recent = loadRecentLocations();
  const activeIdx = getActiveSavedIndex(recent);
  if (recent.length < 2 || activeIdx === -1) return;

  const neighbors = [recent[activeIdx - 1], recent[activeIdx + 1]].filter(Boolean);
  prefetchTimerId = setTimeout(() => {
    for (const loc of neighbors) {
      const cached = getCachedForecast(loc.lat, loc.lon);
      if (!cached || cached.isStale) {
        fetchForecast(loc.lat, loc.lon).catch(() => {});
      }
    }
  }, 500);
}

function navigateToSavedIndex(targetIdx, { shiftFocusIfDisabled = false } = {}) {
  const recent = loadRecentLocations();
  if (isPageNavigating || targetIdx < 0 || targetIdx >= recent.length) return;
  const activeIdx = getActiveSavedIndex(recent);
  if (targetIdx === activeIdx) return;

  const targetLoc = recent[targetIdx];
  const dir = activeIdx === -1 || targetIdx > activeIdx ? 1 : -1;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const main = els.appMain;

  closeDropdown();

  const finishFocus = () => {
    if (shiftFocusIfDisabled && document.activeElement?.disabled) {
      els.cityHeading?.focus({ preventScroll: true });
    }
  };

  if (reducedMotion || !main) {
    loadWeatherForLocation(targetLoc);
    if (main) {
      main.style.translate = '';
      main.style.opacity = '';
    }
    finishFocus();
    return;
  }

  isPageNavigating = true;
  main.classList.add('is-animating');
  main.style.translate = `${-dir * 68}px 0px`;
  main.style.opacity = '0';

  setTimeout(() => {
    main.classList.remove('is-animating');
    main.style.translate = `${dir * 68}px 0px`;
    main.style.opacity = '0';
    loadWeatherForLocation(targetLoc);
    void main.offsetWidth;
    main.classList.add('is-animating');
    main.style.translate = '0px 0px';
    main.style.opacity = '1';

    setTimeout(() => {
      main.classList.remove('is-animating');
      main.style.translate = '';
      main.style.opacity = '';
      isPageNavigating = false;
      finishFocus();
    }, 190);
  }, 130);
}

els.locPrevBtn?.addEventListener('click', () => {
  const idx = getActiveSavedIndex();
  if (idx > 0) navigateToSavedIndex(idx - 1, { shiftFocusIfDisabled: true });
});

els.locNextBtn?.addEventListener('click', () => {
  const recent = loadRecentLocations();
  const idx = getActiveSavedIndex(recent);
  if (idx !== -1 && idx < recent.length - 1) navigateToSavedIndex(idx + 1, { shiftFocusIfDisabled: true });
});

function setupPageSwipeNavigation() {
  const main = els.appMain;
  if (!main) return;

  const IGNORE_SELECTOR = '.hourly-scroller, .radar-map, .leaflet-container, input, select, textarea, button, a, summary, dialog';
  let touch = null;
  let lastWheelNavAt = 0;

  main.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || isPageNavigating || touch) return;
    if (e.target.closest(IGNORE_SELECTOR)) return;
    const recent = loadRecentLocations();
    if (recent.length < 2) return;

    touch = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      startTime: performance.now(),
      mode: null, // 'swipe' | 'scroll'
    };
  });

  main.addEventListener('pointermove', (e) => {
    if (!touch || e.pointerId !== touch.pointerId) return;
    const dx = e.clientX - touch.startX;
    const dy = e.clientY - touch.startY;
    touch.lastX = e.clientX;

    if (!touch.mode) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        touch.mode = 'scroll';
        return;
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        touch.mode = 'swipe';
        main.classList.remove('is-animating');
      } else {
        return;
      }
    }

    if (touch.mode !== 'swipe') return;

    const recent = loadRecentLocations();
    const activeIdx = getActiveSavedIndex(recent);
    const hasPrev = activeIdx > 0;
    const hasNext = activeIdx !== -1 && activeIdx < recent.length - 1;
    const clampedDx = (dx > 0 && !hasPrev) || (dx < 0 && !hasNext) ? dx * 0.22 : dx * 0.85;

    main.style.translate = `${clampedDx.toFixed(1)}px 0px`;

    if (els.swipePeek) {
      if (dx > 28 && hasPrev) {
        els.swipePeek.textContent = `‹ ${recent[activeIdx - 1].name}`;
        els.swipePeek.hidden = false;
      } else if (dx < -28 && hasNext) {
        els.swipePeek.textContent = `${recent[activeIdx + 1].name} ›`;
        els.swipePeek.hidden = false;
      } else {
        els.swipePeek.hidden = true;
      }
    }
  });

  const endSwipe = (e, cancelled = false) => {
    if (!touch || e.pointerId !== touch.pointerId) return;
    const state = touch;
    touch = null;
    if (els.swipePeek) els.swipePeek.hidden = true;
    if (state.mode !== 'swipe') return;

    const rawDx = state.lastX - state.startX;
    const dt = Math.max(16, performance.now() - state.startTime);
    const vx = rawDx / dt;
    const recent = loadRecentLocations();
    const activeIdx = getActiveSavedIndex(recent);
    const commitDist = Math.min(90, window.innerWidth * 0.22);
    const committed = !cancelled && (Math.abs(rawDx) > commitDist || (Math.abs(rawDx) > 35 && Math.abs(vx) > 0.42));

    if (committed) {
      if (rawDx > 0 && activeIdx > 0) {
        navigateToSavedIndex(activeIdx - 1);
        return;
      }
      if (rawDx < 0 && activeIdx !== -1 && activeIdx < recent.length - 1) {
        navigateToSavedIndex(activeIdx + 1);
        return;
      }
    }

    main.classList.add('is-animating');
    main.style.translate = '0px 0px';
    setTimeout(() => {
      main.classList.remove('is-animating');
      main.style.translate = '';
    }, 190);
  };

  main.addEventListener('pointerup', (e) => endSwipe(e, false));
  main.addEventListener('pointercancel', (e) => endSwipe(e, true));

  main.addEventListener(
    'wheel',
    (e) => {
      if (isPageNavigating) return;
      if (e.target.closest('.hourly-scroller, .radar-map, .leaflet-container, dialog')) return;
      if (Math.abs(e.deltaX) <= 32 || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.8) return;
      const now = Date.now();
      if (now - lastWheelNavAt < 650) return;

      const recent = loadRecentLocations();
      if (recent.length < 2) return;
      const activeIdx = getActiveSavedIndex(recent);
      if (activeIdx === -1) return;

      if (e.deltaX > 0 && activeIdx < recent.length - 1) {
        lastWheelNavAt = now;
        navigateToSavedIndex(activeIdx + 1);
      } else if (e.deltaX < 0 && activeIdx > 0) {
        lastWheelNavAt = now;
        navigateToSavedIndex(activeIdx - 1);
      }
    },
    { passive: true },
  );
}

setupPageSwipeNavigation();

// ============================================================================
// Search Autocomplete, Recent Reordering, Locate Button, Unit Toggle & Scroll
// ============================================================================

let searchDebounceTimer = null;
let dropdownItems = [];
let activeDropdownIdx = -1;
let reorderAnnounceTimer = null;
let isMovingDom = false;

function moveElementBefore(container, item, refNode) {
  isMovingDom = true;
  try {
    if ('moveBefore' in Element.prototype) {
      container.moveBefore(item, refNode);
    } else if (refNode) {
      refNode.before(item);
    } else {
      container.append(item);
    }
  } finally {
    isMovingDom = false;
  }
}

function announceReorder(message) {
  if (!els.reorderStatus) return;
  clearTimeout(reorderAnnounceTimer);
  els.reorderStatus.textContent = '';
  reorderAnnounceTimer = setTimeout(() => {
    els.reorderStatus.textContent = message;
  }, 120);
}

function persistRecentOrderFromDom() {
  const rows = Array.from(els.searchResults.querySelectorAll('.search-row'));
  const reordered = rows.map((row) => row._loc).filter(Boolean);
  dropdownItems = reordered;
  rows.forEach((row, idx) => {
    const opt = row.querySelector('.search-option');
    if (opt) opt.dataset.index = String(idx);
  });
  saveRecentLocations(reordered);
  return reordered;
}

function closeDropdown() {
  delete els.searchResults.dataset.drop;
  document.documentElement.classList.remove('is-reordering');
  els.searchResults.hidden = true;
  els.cityInput.setAttribute('aria-expanded', 'false');
  activeDropdownIdx = -1;
}

function renderDropdown(items, headerLabel = '') {
  dropdownItems = items;
  activeDropdownIdx = -1;
  delete els.searchResults.dataset.drop;

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'search-empty';
    li.textContent = headerLabel === 'Recent' ? 'Type a city or ZIP code to search' : 'No matching locations found';
    els.searchResults.replaceChildren(li);
    els.searchResults.hidden = false;
    els.cityInput.setAttribute('aria-expanded', 'true');
    return;
  }

  const isRecent = headerLabel === 'Recent';
  const canReorder = isRecent && items.length > 1;
  const children = [];
  let hintSpan = null;

  if (headerLabel) {
    const hdr = document.createElement('li');
    hdr.className = 'search-dropdown-header';
    hdr.setAttribute('role', 'presentation');
    const titleSpan = document.createElement('span');
    titleSpan.textContent = headerLabel;
    hdr.appendChild(titleSpan);
    if (canReorder) {
      hintSpan = document.createElement('span');
      hintSpan.className = 'search-reorder-hint';
      hintSpan.setAttribute('aria-hidden', 'true');
      hintSpan.textContent = 'Drag to reorder';
      hdr.appendChild(hintSpan);
    }
    children.push(hdr);
  }

  items.forEach((loc, idx) => {
    const li = document.createElement('li');
    li.className = isSameLocation(loc, appState.location) ? 'search-row is-current' : 'search-row';
    li._loc = loc;

    if (canReorder) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'search-drag-handle';
      handle.setAttribute('aria-pressed', 'false');
      handle.setAttribute('aria-label', `Reorder ${loc.name}`);
      handle.innerHTML =
        '<svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true"><circle cx="3.5" cy="3" r="1.2" fill="currentColor"/><circle cx="8.5" cy="3" r="1.2" fill="currentColor"/><circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8.5" cy="8" r="1.2" fill="currentColor"/><circle cx="3.5" cy="13" r="1.2" fill="currentColor"/><circle cx="8.5" cy="13" r="1.2" fill="currentColor"/></svg>';

      let grabState = null;

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const list = els.searchResults;
        const startY = e.clientY;
        const startScroll = list.scrollTop;
        const pointerId = e.pointerId;
        let currentTargetIdx = null;
        let finished = false;

        try {
          handle.setPointerCapture(pointerId);
        } catch {
          // Pointer capture optional if unavailable
        }

        document.documentElement.classList.add('is-reordering');
        li.classList.add('is-dragging');

        const updateDropTarget = (clientY) => {
          const listRect = list.getBoundingClientRect();
          const clampedY = Math.max(listRect.top, Math.min(listRect.bottom, clientY));
          const yInScroll = clampedY - listRect.top + list.scrollTop - list.clientTop;
          const rows = Array.from(list.querySelectorAll('.search-row'));
          const srcIdx = rows.indexOf(li);

          let dropIdx = rows.length;
          for (let r = 0; r < rows.length; r += 1) {
            const row = rows[r];
            const mid = row.offsetTop + row.offsetHeight / 2;
            if (yInScroll < mid) {
              dropIdx = r;
              break;
            }
          }

          if (dropIdx === srcIdx || dropIdx === srcIdx + 1) {
            currentTargetIdx = null;
            delete list.dataset.drop;
          } else {
            currentTargetIdx = dropIdx;
            let dropY;
            if (dropIdx === 0) {
              dropY = rows[0].getBoundingClientRect().top - 1;
            } else if (dropIdx >= rows.length) {
              dropY = rows[rows.length - 1].getBoundingClientRect().bottom + 1;
            } else {
              dropY = (rows[dropIdx - 1].getBoundingClientRect().bottom + rows[dropIdx].getBoundingClientRect().top) / 2;
            }
            list.dataset.drop = 'true';
            list.style.setProperty('--drop-x', `${(listRect.left + 8).toFixed(1)}px`);
            list.style.setProperty('--drop-y', `${dropY.toFixed(1)}px`);
            list.style.setProperty('--drop-w', `${Math.max(0, listRect.width - 16).toFixed(1)}px`);
          }
        };

        const cleanup = (commit = false) => {
          if (finished) return;
          finished = true;

          document.removeEventListener('pointermove', onPointerMove);
          document.removeEventListener('pointerup', onPointerUp);
          document.removeEventListener('pointercancel', onPointerCancel);
          document.removeEventListener('keydown', onEscapeCancel, true);
          handle.removeEventListener('lostpointercapture', onLostCapture);

          delete list.dataset.drop;
          document.documentElement.classList.remove('is-reordering');

          const rows = Array.from(list.querySelectorAll('.search-row'));
          const srcIdx = rows.indexOf(li);
          const validCommit = commit && currentTargetIdx !== null && currentTargetIdx !== srcIdx && currentTargetIdx !== srcIdx + 1;

          if (validCommit) {
            const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const preRects = new Map(rows.map((r) => [r, r.getBoundingClientRect()]));
            li.style.translate = '';

            const refNode = rows[currentTargetIdx] || null;
            moveElementBefore(list, li, refNode);
            li.classList.remove('is-dragging');

            const updated = persistRecentOrderFromDom();
            const newIdx = Array.from(list.querySelectorAll('.search-row')).indexOf(li);
            announceReorder(`Moved ${loc.name} to position ${newIdx + 1} of ${updated.length}`);

            if (!reduced) {
              for (const row of list.querySelectorAll('.search-row')) {
                const prevR = preRects.get(row);
                const nextR = row.getBoundingClientRect();
                if (!prevR) continue;
                const dyFlip = prevR.top - nextR.top;
                if (Math.abs(dyFlip) > 1) {
                  row.animate([{ translate: `0px ${dyFlip}px` }, { translate: '0px 0px' }], {
                    duration: 180,
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                  });
                }
              }
            }
          } else {
            li.classList.remove('is-dragging');
            li.style.translate = '';
          }
        };

        const onPointerMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const dy = ev.clientY - startY + (list.scrollTop - startScroll);
          li.style.translate = `0px ${dy.toFixed(1)}px`;
          updateDropTarget(ev.clientY);
        };

        const onPointerUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          cleanup(true);
        };

        const onPointerCancel = (ev) => {
          if (ev.pointerId !== pointerId) return;
          cleanup(false);
        };

        const onLostCapture = () => cleanup(false);

        const onEscapeCancel = (ev) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            cleanup(false);
            announceReorder('Reorder cancelled');
          }
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerCancel);
        document.addEventListener('keydown', onEscapeCancel, true);
        handle.addEventListener('lostpointercapture', onLostCapture);
      });

      const releaseGrab = (restoreIdx = null) => {
        if (!grabState) return;
        const rows = Array.from(els.searchResults.querySelectorAll('.search-row'));
        if (restoreIdx !== null) {
          const refNode = rows[restoreIdx] && rows[restoreIdx] !== li
            ? (restoreIdx > rows.indexOf(li) ? rows[restoreIdx].nextElementSibling : rows[restoreIdx])
            : null;
          if (rows.indexOf(li) !== restoreIdx) {
            moveElementBefore(els.searchResults, li, refNode);
            persistRecentOrderFromDom();
          }
        }
        grabState = null;
        handle.setAttribute('aria-pressed', 'false');
        li.classList.remove('is-grabbed');
        if (hintSpan) hintSpan.textContent = 'Drag to reorder';
      };

      handle.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (!grabState) {
            const rows = Array.from(els.searchResults.querySelectorAll('.search-row'));
            grabState = { originalIdx: rows.indexOf(li) };
            handle.setAttribute('aria-pressed', 'true');
            li.classList.add('is-grabbed');
            if (hintSpan) hintSpan.textContent = '↑/↓ move · Enter drop · Esc cancel';
            announceReorder(`Grabbed ${loc.name}. Use Up and Down arrows to move, Enter to drop, Escape to cancel.`);
          } else {
            const rows = Array.from(els.searchResults.querySelectorAll('.search-row'));
            const pos = rows.indexOf(li);
            releaseGrab(null);
            announceReorder(`Dropped ${loc.name} at position ${pos + 1} of ${rows.length}`);
          }
        } else if (grabState && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          e.stopPropagation();
          const list = els.searchResults;
          const rows = Array.from(list.querySelectorAll('.search-row'));
          const idxNow = rows.indexOf(li);
          const nextIdx = e.key === 'ArrowUp' ? idxNow - 1 : idxNow + 1;
          if (nextIdx < 0 || nextIdx >= rows.length) return;

          const preRect = li.getBoundingClientRect();
          const refNode = e.key === 'ArrowUp' ? rows[nextIdx] : rows[nextIdx].nextElementSibling;
          moveElementBefore(list, li, refNode);
          li.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          handle.focus({ preventScroll: true });

          const updated = persistRecentOrderFromDom();
          const finalIdx = Array.from(list.querySelectorAll('.search-row')).indexOf(li);
          announceReorder(`${loc.name}, position ${finalIdx + 1} of ${updated.length}`);

          if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            const postRect = li.getBoundingClientRect();
            const dy = preRect.top - postRect.top;
            if (Math.abs(dy) > 1) {
              li.animate([{ translate: `0px ${dy}px` }, { translate: '0px 0px' }], { duration: 150, easing: 'ease-out' });
            }
          }
        } else if (grabState && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const orig = grabState.originalIdx;
          releaseGrab(orig);
          handle.focus({ preventScroll: true });
          announceReorder('Reorder cancelled');
        }
      });

      handle.addEventListener('blur', () => {
        if (!isMovingDom && grabState) {
          releaseGrab(null);
        }
      });

      li.appendChild(handle);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-option';
    btn.dataset.index = String(idx);

    const placeSub = formatPlaceLabel(loc) || loc.country || '';

    const main = document.createElement('span');
    main.className = 'search-option-main';
    main.textContent = loc.name;

    const sub = document.createElement('span');
    sub.className = 'search-option-sub';
    sub.textContent = placeSub;

    btn.append(main, sub);
    btn.addEventListener('click', () => selectSearchLocation(loc));
    li.appendChild(btn);

    if (isRecent) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'search-delete-btn';
      delBtn.setAttribute(
        'aria-label',
        placeSub ? `Remove ${loc.name}, ${placeSub} from recent locations` : `Remove ${loc.name} from recent locations`,
      );
      delBtn.innerHTML =
        '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      delBtn.addEventListener('mousedown', (e) => e.preventDefault());
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRecentLocation(loc);
      });
      li.appendChild(delBtn);
    }

    children.push(li);
  });

  els.searchResults.replaceChildren(...children);
  els.searchResults.hidden = false;
  els.cityInput.setAttribute('aria-expanded', 'true');
}

function updateActiveDropdownHighlight() {
  const buttons = els.searchResults.querySelectorAll('.search-option');
  buttons.forEach((btn, idx) => {
    const selected = idx === activeDropdownIdx;
    btn.classList.toggle('is-active', selected);
    if (selected) btn.scrollIntoView({ block: 'nearest' });
  });
}

function selectSearchLocation(loc) {
  els.cityInput.value = '';
  closeDropdown();
  els.cityInput.blur();
  loadWeatherForLocation(loc);
}

els.cityInput.addEventListener('focus', () => {
  if (els.cityInput.value.trim().length < 2) {
    const recent = loadRecentLocations();
    if (recent.length) renderDropdown(recent, 'Recent');
  }
});

els.cityInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  const q = els.cityInput.value.trim();
  if (q.length < 2) {
    const recent = loadRecentLocations();
    if (recent.length) renderDropdown(recent, 'Recent');
    else closeDropdown();
    return;
  }

  searchDebounceTimer = setTimeout(async () => {
    try {
      const hits = await searchLocations(q);
      if (els.cityInput.value.trim() === q) {
        renderDropdown(hits);
      }
    } catch {
      closeDropdown();
    }
  }, 220);
});

els.cityInput.addEventListener('keydown', (e) => {
  if (els.searchResults.hidden || !dropdownItems.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeDropdownIdx = (activeDropdownIdx + 1) % dropdownItems.length;
    updateActiveDropdownHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeDropdownIdx = (activeDropdownIdx - 1 + dropdownItems.length) % dropdownItems.length;
    updateActiveDropdownHighlight();
  } else if (e.key === 'Escape') {
    closeDropdown();
  } else if (e.key === 'Enter' && activeDropdownIdx >= 0) {
    e.preventDefault();
    selectSearchLocation(dropdownItems[activeDropdownIdx]);
  }
});

els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (activeDropdownIdx >= 0 && dropdownItems[activeDropdownIdx]) {
    selectSearchLocation(dropdownItems[activeDropdownIdx]);
    return;
  }
  const q = els.cityInput.value.trim();
  if (q.length < 2) return;
  const hits = await searchLocations(q);
  if (hits.length) selectSearchLocation(hits[0]);
  else renderDropdown([]);
});

document.addEventListener('click', (e) => {
  if (!e.target.isConnected || e.target.closest('.location-search')) return;
  closeDropdown();
});

els.locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    els.locationKicker.textContent = 'Geolocation not supported in this browser';
    return;
  }
  els.locateBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const loc = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        await loadWeatherForLocation(loc);
      } finally {
        els.locateBtn.disabled = false;
      }
    },
    () => {
      els.locateBtn.disabled = false;
      els.locationKicker.textContent = 'Location permission denied · search a city instead';
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
  );
});

els.unitToggle.addEventListener('click', () => {
  appState.unit = appState.unit === 'F' ? 'C' : 'F';
  try {
    localStorage.setItem(STORAGE_UNIT, appState.unit);
  } catch {
    // Ignore storage error
  }
  renderAll({ freshnessLabel: 'Updated just now' });
});

els.radarSummary.addEventListener('click', () => {
  appState.radarManuallyToggled = true;
});

els.radarDisclosure.addEventListener('toggle', syncRadarToggleCta);

els.hourlyPrev?.addEventListener('click', () => {
  els.hourlyList.scrollBy({ left: -320, behavior: 'smooth' });
});

els.hourlyNext?.addEventListener('click', () => {
  els.hourlyList.scrollBy({ left: 320, behavior: 'smooth' });
});

els.dailyPrev?.addEventListener('click', () => {
  els.dailyList.scrollBy({ left: -320, behavior: 'smooth' });
});

els.dailyNext?.addEventListener('click', () => {
  els.dailyList.scrollBy({ left: 320, behavior: 'smooth' });
});

// ============================================================================
// Weather Art Debug Modal (Custom Scene Mixer + 16 Presets + 12 Mini Icons)
// ============================================================================

function getMixerScene() {
  const transition = els.mixerTransition.value;
  return {
    timePhase: els.mixerTime.value,
    sky: els.mixerSky.value,
    transition,
    transitionMins: transition === 'none' ? null : Number(els.mixerEta.value),
    tempF: Number(els.mixerTemp.value),
    windMph: Number(els.mixerWind.value),
    windGustsMph: Number(els.mixerWind.value) >= 20 ? Number(els.mixerWind.value) + 8 : 0,
  };
}

function updateMixerPreview() {
  const scene = getMixerScene();
  els.mixerTempVal.textContent = `${scene.tempF}°F`;
  els.mixerWindVal.textContent = `${scene.windMph} mph`;
  els.mixerEta.disabled = scene.transition === 'none' || scene.transition === 'clearing' || scene.transition === 'cloudy-soon';
  els.mixerPreview.innerHTML = renderHeroDiorama(scene);
  els.mixerStory.textContent = describeSceneStory(scene);
}

function setMixerFromScene(scene) {
  if (!scene) return;
  els.mixerTime.value = scene.timePhase || 'day';
  els.mixerSky.value = scene.sky || 'mostly-clear';
  els.mixerTransition.value = scene.transition || 'none';
  if (scene.transitionMins) {
    const allowed = [15, 30, 45, 75, 90, 120];
    const nearest = allowed.reduce((a, b) =>
      Math.abs(b - scene.transitionMins) < Math.abs(a - scene.transitionMins) ? b : a,
    );
    els.mixerEta.value = String(nearest);
  }
  els.mixerTemp.value = String(Math.max(0, Math.min(105, Math.round(scene.tempF ?? 64))));
  els.mixerWind.value = String(Math.max(0, Math.min(36, Math.round(scene.windMph ?? 8))));
  updateMixerPreview();
}

function applyDebugSceneToHero(scene) {
  appState.debugHeroOverride = { ...scene };
  renderAll({ freshnessLabel: 'Debug preview' });
  els.heroDebugReset.hidden = false;
}

function resetHeroDebugOverride() {
  appState.debugHeroOverride = null;
  renderAll({ freshnessLabel: 'Updated just now' });
  if (appState.liveHeroScene) {
    setMixerFromScene(appState.liveHeroScene);
  }
}

function highlightActivePresetCard(activeId) {
  for (const card of els.debugPresetGrid.querySelectorAll('.debug-preset-card')) {
    card.classList.toggle('is-active', card.dataset.presetId === activeId);
  }
}

function buildDebugGallery() {
  if (appState.debugGalleryBuilt) return;
  appState.debugGalleryBuilt = true;

  const presetNodes = HERO_SCENE_PRESETS.map((preset) => {
    const card = document.createElement('article');
    card.className = 'debug-preset-card';
    card.dataset.presetId = preset.id;

    const art = document.createElement('div');
    art.className = 'debug-preset-art';
    art.innerHTML = renderHeroDiorama(preset.scene);

    const title = document.createElement('div');
    title.className = 'debug-preset-title';
    title.textContent = preset.title;

    const sub = document.createElement('div');
    sub.className = 'debug-preset-sub';
    sub.textContent = preset.subtitle;

    const actions = document.createElement('div');
    actions.className = 'debug-preset-actions';

    const tag = document.createElement('span');
    tag.className = 'debug-preset-tag';
    tag.textContent = `${preset.scene.tempF}°F · ${preset.scene.windMph}mph`;

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'iso-btn sm-btn';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMixerFromScene(preset.scene);
      highlightActivePresetCard(preset.id);
      applyDebugSceneToHero(preset.scene);
      els.sceneDebugDialog.close();
    });

    actions.append(tag, applyBtn);
    card.append(art, title, sub, actions);

    card.addEventListener('click', () => {
      setMixerFromScene(preset.scene);
      highlightActivePresetCard(preset.id);
    });

    return card;
  });
  els.debugPresetGrid.replaceChildren(...presetNodes);

  const iconNodes = MINI_ICON_SPECS.map((spec) => {
    const item = document.createElement('div');
    item.className = 'debug-icon-card';

    const art = document.createElement('div');
    art.className = 'debug-icon-art';
    art.innerHTML = renderMiniIsoIcon(spec.code, spec.isDay, spec.opts);

    const label = document.createElement('span');
    label.className = 'debug-icon-label';
    label.textContent = spec.label;

    item.append(art, label);
    return item;
  });
  els.debugIconGrid.replaceChildren(...iconNodes);
}

function openSceneDebugDialog() {
  buildDebugGallery();
  setMixerFromScene(appState.debugHeroOverride || appState.liveHeroScene || HERO_SCENE_PRESETS[0].scene);
  if (!els.sceneDebugDialog.open) {
    els.sceneDebugDialog.showModal();
  }
}

els.heroDebugReset?.addEventListener('click', resetHeroDebugOverride);

for (const ctrl of [els.mixerTime, els.mixerSky, els.mixerTransition, els.mixerEta, els.mixerTemp, els.mixerWind]) {
  ctrl?.addEventListener('input', () => {
    highlightActivePresetCard('');
    updateMixerPreview();
  });
}

els.mixerApplyBtn?.addEventListener('click', () => {
  applyDebugSceneToHero(getMixerScene());
  els.sceneDebugDialog.close();
});

els.mixerResetBtn?.addEventListener('click', () => {
  resetHeroDebugOverride();
  highlightActivePresetCard('');
});

els.sceneDebugDialog?.addEventListener('close', () => {
  els.sceneDebugDialog.returnValue = '';
});

// Fallback light-dismiss for browsers lacking native dialog[closedby="any"]
if (els.sceneDebugDialog && !('closedBy' in HTMLDialogElement.prototype)) {
  const isOutside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  els.sceneDebugDialog.addEventListener('pointerdown', (e) => {
    pressedOutside = isOutside(e, els.sceneDebugDialog);
  });
  els.sceneDebugDialog.addEventListener('pointerup', (e) => {
    if (pressedOutside && isOutside(e, els.sceneDebugDialog)) {
      els.sceneDebugDialog.close();
    }
  });
}

// ============================================================================
// Boot
// ============================================================================

(() => {
  void ensureTemporal();
  loadWeatherForLocation(appState.location);
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    openSceneDebugDialog();
  }
})();
