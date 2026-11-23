// ============================================================================
// Overworld — Application Controller & Temporal Date Logic
// ============================================================================

import {
  HERO_SCENE_PRESETS,
  MINI_ICON_SPECS,
  classifyWeather,
  describeMiniIcon,
  isSnowPrecip,
  renderHeroDiorama,
  renderHourlyCurveSegment,
  renderMiniIsoIcon,
  renderPrecipGlyph,
  tempRangeGradient,
} from './iso-art.js';
import {
  buildHeroSceneState,
  describeImmediatePrecip,
  describeSceneStory,
  evaluateRadarInterest,
  fetchForecast,
  fetchNwsAlerts,
  formatCompactAccum,
  formatPlaceLabel,
  formatPrecip,
  formatSpeed,
  formatTemp,
  getCachedForecast,
  normalizeSnowInches,
  reverseGeocode,
  searchLocations,
  toUnitTemp,
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

function renderAlignedTempHtml(fahrenheit, unit) {
  const val = toUnitTemp(fahrenheit, unit);
  const text = val < 0 ? `−${Math.abs(val)}` : String(val);
  return `<span class="col-num">${text}</span><span class="col-unit">°</span>`;
}

function renderAlignedAccumHtml(label) {
  if (!label) return '';
  const m = label.match(/^(.+?)("|mm|cm)$/);
  if (m) {
    const core = m[1].replace('<', '&lt;');
    const unitClass = m[2] === '"' ? 'col-unit' : 'col-unit accum-metric-unit';
    return `<span class="col-num">${core}</span><span class="${unitClass}">${m[2]}</span>`;
  }
  return `<span class="col-num">${label.replace('<', '&lt;')}</span><span class="col-unit"></span>`;
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
  dailyTakeaway: document.getElementById('daily-takeaway'),
  dailyPrev: document.getElementById('daily-prev'),
  dailyNext: document.getElementById('daily-next'),
  dailyList: document.getElementById('daily-list'),
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
  debugPresetGrid: document.getElementById('debug-preset-grid'),
  debugIconGrid: document.getElementById('debug-icon-grid'),
  legendBtn: document.getElementById('legend-btn'),
  alertsBtn: document.getElementById('alerts-btn'),
  alertsDot: document.getElementById('alerts-dot'),
  alertsFeedback: document.getElementById('alerts-feedback'),
};

const appState = {
  location: loadInitialLocation(),
  unit: loadInitialUnit(),
  forecast: null,
  alerts: [],
  radarManuallyToggled: false,
  liveHeroScene: null,
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

function formatNwsParagraphs(raw) {
  if (!raw) return [];
  return String(raw)
    .trim()
    .split(/\n\s*\n+|\n(?=\*\s*[A-Z])|\n(?=\.\.\.[A-Z])/)
    .map((chunk) => chunk.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
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
    if (alert.headline && alert.headline.trim() !== alert.event.trim()) {
      const p = document.createElement('p');
      p.className = 'alert-headline';
      p.textContent = alert.headline.replace(/\s*\n\s*/g, ' ').trim();
      body.appendChild(p);
    }

    for (const para of formatNwsParagraphs(alert.description)) {
      const p = document.createElement('p');
      p.textContent = para;
      body.appendChild(p);
    }

    if (alert.instruction && alert.instruction.trim() !== (alert.description || '').trim()) {
      const instBox = document.createElement('div');
      instBox.className = 'alert-instruction';
      for (const para of formatNwsParagraphs(alert.instruction)) {
        const p = document.createElement('p');
        p.textContent = para;
        instBox.appendChild(p);
      }
      if (instBox.childElementCount > 0) {
        body.appendChild(instBox);
      }
    }

    details.append(summary, body);
    return details;
  });

  els.alertsSlot.replaceChildren(...nodes);
  els.alertsSlot.hidden = false;
}

function buildHourlyTakeaway(hourly, startIdx, unit = 'F', hourlyUnits = {}) {
  const endIdx = Math.min(hourly.time.length, startIdx + 24);
  let firstWet = -1;
  let firstDryAfterWet = -1;
  let totalRainIn = 0;
  let totalSnowIn = 0;
  let maxHourlyRainIn = 0;
  let anySnowWet = false;
  const snowUnit = hourlyUnits?.snowfall || 'inch';

  const startingWet =
    Number(hourly.precipitation[startIdx] ?? 0) > 0.01 ||
    Number(hourly.precipitation_probability[startIdx] ?? 0) >= 45 ||
    Number(hourly.weather_code[startIdx] ?? 0) >= 51;

  for (let i = startIdx; i < endIdx; i += 1) {
    const pIn = Number(hourly.precipitation[i] ?? 0);
    const sIn = normalizeSnowInches(hourly.snowfall?.[i] ?? 0, snowUnit);
    const pop = Number(hourly.precipitation_probability[i] ?? 0);
    const code = Number(hourly.weather_code[i] ?? 0);
    const tempF = Number(hourly.temperature_2m[i] ?? 60);
    totalRainIn += pIn;
    totalSnowIn += sIn;
    if (pIn > maxHourlyRainIn) maxHourlyRainIn = pIn;

    const isWet = pIn > 0.01 || pop >= 40 || code >= 51;
    if (isWet && isSnowPrecip(code, tempF)) anySnowWet = true;

    if (i > startIdx) {
      if (!startingWet && isWet && firstWet === -1) {
        firstWet = i;
      }
      if (startingWet && !isWet && firstDryAfterWet === -1) {
        firstDryAfterWet = i;
      }
    }
  }

  let totalSuffix = '';
  if (anySnowWet && totalSnowIn >= 0.1) {
    const snowLabel = unit === 'C' ? `${(totalSnowIn * 2.54).toFixed(1)} cm` : `${totalSnowIn.toFixed(1)}"`;
    totalSuffix = ` · ~${snowLabel} snow in 24h`;
  } else if (totalRainIn >= 0.01) {
    totalSuffix = ` · ${formatPrecip(totalRainIn, unit)} in 24h`;
  } else if ((startingWet || firstWet !== -1) && totalRainIn > 0) {
    totalSuffix = unit === 'C' ? ' · <.3 mm in 24h' : ' · <.01" in 24h';
  }

  const isMostlyDrizzle = !anySnowWet && maxHourlyRainIn < 0.03 && totalRainIn < 0.08;
  const wetNoun = anySnowWet ? 'Snow' : isMostlyDrizzle ? 'Light drizzle' : 'Rain';

  if (!startingWet && firstWet !== -1) {
    const { hour } = parsePlainDateTime(hourly.time[firstWet]);
    return `${wetNoun} likely around ${formatHour12(hour)}${totalSuffix}`;
  }
  if (startingWet && firstDryAfterWet !== -1) {
    const { hour } = parsePlainDateTime(hourly.time[firstDryAfterWet]);
    return `Tapering off around ${formatHour12(hour)}${totalSuffix}`;
  }
  if (startingWet) return `${anySnowWet ? 'Periods of snow' : isMostlyDrizzle ? 'Periods of drizzle' : 'Periods of rain'} over 24h${totalSuffix}`;
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
  els.heroDiorama.innerHTML = renderHeroDiorama(liveHeroScene);
  els.heroDiorama.setAttribute(
    'aria-label',
    `Isometric sky-island illustration: ${describeSceneStory(liveHeroScene)}`,
  );

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
  els.hourlyTakeaway.textContent = buildHourlyTakeaway(hourly, currentHourIdx, unit, forecast.hourly_units);
  if (els.dailyTakeaway) {
    els.dailyTakeaway.textContent = unit === 'C' ? 'High / low · % & mm' : 'High / low · % & inches';
  }
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

  const hourlySnowUnit = forecast.hourly_units?.snowfall || 'inch';
  const hourlyAccums = [];
  for (let i = currentHourIdx; i < sliceEnd; i += 1) {
    const offset = i - currentHourIdx;
    const tempF = sliceTemps[offset];
    const pop = Math.round(Number(hourly.precipitation_probability[i] ?? 0));
    const precipIn = Number(hourly.precipitation[i] ?? 0);
    const snowIn = normalizeSnowInches(hourly.snowfall?.[i] ?? 0, hourlySnowUnit);
    const wmoCode = hourly.weather_code[i];
    const snowChance = isSnowPrecip(wmoCode, tempF);
    const showAccum = precipIn >= 0.01 || snowIn >= 0.05 || ((pop >= 25 || wmoCode >= 51) && (precipIn >= 0.004 || (wmoCode >= 51 && wmoCode <= 57)));
    hourlyAccums.push(
      showAccum ? formatCompactAccum(precipIn, unit, { snowInches: snowIn, isSnow: snowChance, wmoCode }) : '',
    );
  }
  const anyHourlyAccum = hourlyAccums.some(Boolean);

  const hourCards = [];
  for (let i = currentHourIdx; i < sliceEnd; i += 1) {
    const offset = i - currentHourIdx;
    const tempF = sliceTemps[offset];
    const pop = Math.round(Number(hourly.precipitation_probability[i] ?? 0));
    const precipIn = Number(hourly.precipitation[i] ?? 0);
    const wmoCode = hourly.weather_code[i];
    const isDayHr = hourly.is_day[i];
    const accumLabel = hourlyAccums[offset];
    const { hour } = parsePlainDateTime(hourly.time[i]);
    const timeLabelCompact = offset === 0 ? 'Now' : formatHourCompact(hour);
    const timeLabelFull = offset === 0 ? 'Now' : formatHour12(hour);

    const li = document.createElement('li');
    li.className = offset === 0 ? 'hour-card is-now' : 'hour-card';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'hour-time';
    timeSpan.textContent = timeLabelCompact;

    const iconOpts = { precipProb: pop, precipInches: precipIn, tempF };
    const iconMeta = describeMiniIcon(wmoCode, isDayHr, iconOpts);
    const snowChance = isSnowPrecip(wmoCode, tempF);
    const precipNoun = snowChance ? 'snow' : 'rain';
    const tipId = `tip-hour-${offset}`;

    const iconBtn = document.createElement('button');
    iconBtn.type = 'button';
    iconBtn.className = 'hour-icon';
    iconBtn.setAttribute('interestfor', tipId);
    iconBtn.setAttribute('popovertarget', tipId);
    iconBtn.setAttribute('popovertargetaction', 'show');
    iconBtn.setAttribute('aria-label', `${timeLabelFull}: ${iconMeta.label}`);
    iconBtn.innerHTML = renderMiniIsoIcon(wmoCode, isDayHr, iconOpts);

    const tipEl = document.createElement('div');
    tipEl.id = tipId;
    tipEl.className = 'voxel-tooltip';
    tipEl.setAttribute('popover', 'hint');
    const tipTitle = document.createElement('span');
    tipTitle.className = 'voxel-tooltip-title';
    tipTitle.textContent = `${timeLabelFull} · ${iconMeta.label}`;
    const tipSub = document.createElement('span');
    tipSub.className = 'voxel-tooltip-sub';
    tipSub.textContent = accumLabel
      ? `${iconMeta.cue} · ${pop}% chance · ${accumLabel} ${precipNoun}`
      : `${iconMeta.cue} · ${pop}% chance of ${precipNoun}`;
    tipEl.append(tipTitle, tipSub);

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
    const curveTempSpan = document.createElement('span');
    curveTempSpan.className = 'hour-curve-label col-metric';
    curveTempSpan.style.setProperty('--curve-pct', `${((yCoords[offset] / 58) * 100).toFixed(1)}%`);
    curveTempSpan.innerHTML = renderAlignedTempHtml(tempF, unit);
    curveWrap.appendChild(curveTempSpan);

    const precipGroup = document.createElement('div');
    precipGroup.className = 'precip-group';

    const popSpan = document.createElement('span');
    const popClasses = ['hour-pop', 'col-metric'];
    if (snowChance) popClasses.push('is-snow');
    if (pop < 15) popClasses.push('is-dry');
    popSpan.className = popClasses.join(' ');
    popSpan.innerHTML = `<span class="col-num">${renderPrecipGlyph(snowChance)}<span>${pop}</span></span><span class="col-unit">%</span><span class="visually-hidden"> chance of ${precipNoun}</span>`;
    precipGroup.appendChild(popSpan);

    if (anyHourlyAccum) {
      const accumSpan = document.createElement('span');
      accumSpan.className = accumLabel ? 'hour-accum col-metric' : 'hour-accum col-metric is-empty';
      if (accumLabel) {
        accumSpan.innerHTML = renderAlignedAccumHtml(accumLabel);
      } else {
        accumSpan.innerHTML = '<span class="col-num">00</span><span class="col-unit">"</span>';
        accumSpan.setAttribute('aria-hidden', 'true');
      }
      precipGroup.appendChild(accumSpan);
    }

    li.append(timeSpan, iconBtn, tipEl, curveWrap, precipGroup);
    hourCards.push(li);
  }
  els.hourlyList.replaceChildren(...hourCards);
  wireInterestHints(els.hourlyList);

  // 10-day forecast (horizontal columns with vertical color-graded high/low bars)
  const dayCount = Math.min(10, daily.time.length);
  const weekLow = Math.min(...daily.temperature_2m_min.slice(0, dayCount).map(Number));
  const weekHigh = Math.max(...daily.temperature_2m_max.slice(0, dayCount).map(Number));
  const weekSpan = Math.max(1, weekHigh - weekLow);
  const dailySnowUnit = forecast.daily_units?.snowfall_sum || 'inch';

  const dailyAccums = [];
  for (let i = 0; i < dayCount; i += 1) {
    const lowF = Number(daily.temperature_2m_min[i]);
    const highF = Number(daily.temperature_2m_max[i]);
    const midTempF = (lowF + highF) / 2;
    const pop = Math.round(Number(daily.precipitation_probability_max[i] ?? 0));
    const precipSum = Number(daily.precipitation_sum[i] ?? 0);
    const snowSum = normalizeSnowInches(daily.snowfall_sum?.[i] ?? 0, dailySnowUnit);
    const wmoCode = daily.weather_code[i];
    const snowChance = isSnowPrecip(wmoCode, highF <= 34 ? highF : midTempF);
    const showAccum = precipSum >= 0.01 || snowSum >= 0.05 || (pop >= 25 && precipSum >= 0.004);
    dailyAccums.push(
      showAccum ? formatCompactAccum(precipSum, unit, { snowInches: snowSum, isSnow: snowChance, wmoCode }) : '',
    );
  }
  const anyDailyAccum = dailyAccums.some(Boolean);

  const dayCards = [];
  for (let i = 0; i < dayCount; i += 1) {
    const lowF = Number(daily.temperature_2m_min[i]);
    const highF = Number(daily.temperature_2m_max[i]);
    const pop = Math.round(Number(daily.precipitation_probability_max[i] ?? 0));
    const precipSum = Number(daily.precipitation_sum[i] ?? 0);
    const wmoCode = daily.weather_code[i];
    const accumLabel = dailyAccums[i];
    const bottomPct = ((lowF - weekLow) / weekSpan) * 100;
    const spanPct = ((highF - lowF) / weekSpan) * 100;
    const dayLabel = i === 0 ? 'Today' : getWeekdayShort(daily.time[i]);

    const li = document.createElement('li');
    li.className = i === 0 ? 'hour-card is-now' : 'hour-card';

    const daySpan = document.createElement('span');
    daySpan.className = 'hour-time';
    daySpan.textContent = dayLabel;

    const midTempF = (lowF + highF) / 2;
    const iconOpts = { precipProb: pop, precipInches: precipSum, tempF: midTempF };
    const iconMeta = describeMiniIcon(wmoCode, 1, iconOpts);
    const snowChance = isSnowPrecip(wmoCode, highF <= 34 ? highF : midTempF);
    const precipNoun = snowChance ? 'snow' : 'rain';
    const tipId = `tip-day-${i}`;

    const iconBtn = document.createElement('button');
    iconBtn.type = 'button';
    iconBtn.className = 'hour-icon';
    iconBtn.setAttribute('interestfor', tipId);
    iconBtn.setAttribute('popovertarget', tipId);
    iconBtn.setAttribute('popovertargetaction', 'show');
    iconBtn.setAttribute('aria-label', `${dayLabel}: ${iconMeta.label}`);
    iconBtn.innerHTML = renderMiniIsoIcon(wmoCode, 1, iconOpts);

    const tipEl = document.createElement('div');
    tipEl.id = tipId;
    tipEl.className = 'voxel-tooltip';
    tipEl.setAttribute('popover', 'hint');
    const tipTitle = document.createElement('span');
    tipTitle.className = 'voxel-tooltip-title';
    tipTitle.textContent = `${dayLabel} · ${iconMeta.label}`;
    const tipSub = document.createElement('span');
    tipSub.className = 'voxel-tooltip-sub';
    tipSub.textContent = accumLabel
      ? `${iconMeta.cue} · ${pop}% chance · ${accumLabel} total`
      : `${iconMeta.cue} · ${pop}% chance of ${precipNoun}`;
    tipEl.append(tipTitle, tipSub);

    const vbarCol = document.createElement('div');
    vbarCol.className = 'day-vbar-col';

    const highSpan = document.createElement('span');
    highSpan.className = 'day-high-label col-metric';
    highSpan.innerHTML = renderAlignedTempHtml(highF, unit);

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
    lowSpan.className = 'day-low-label col-metric';
    lowSpan.innerHTML = renderAlignedTempHtml(lowF, unit);

    vbarCol.append(highSpan, vtrack, lowSpan);

    const precipGroup = document.createElement('div');
    precipGroup.className = 'precip-group';

    const popSpan = document.createElement('span');
    const popClasses = ['hour-pop', 'col-metric'];
    if (snowChance) popClasses.push('is-snow');
    if (pop < 10) popClasses.push('is-dry');
    popSpan.className = popClasses.join(' ');
    popSpan.innerHTML = `<span class="col-num">${renderPrecipGlyph(snowChance)}<span>${pop}</span></span><span class="col-unit">%</span><span class="visually-hidden"> chance of ${precipNoun}</span>`;
    precipGroup.appendChild(popSpan);

    if (anyDailyAccum) {
      const accumSpan = document.createElement('span');
      accumSpan.className = accumLabel ? 'hour-accum col-metric' : 'hour-accum col-metric is-empty';
      if (accumLabel) {
        accumSpan.innerHTML = renderAlignedAccumHtml(accumLabel);
      } else {
        accumSpan.innerHTML = '<span class="col-num">00</span><span class="col-unit">"</span>';
        accumSpan.setAttribute('aria-hidden', 'true');
      }
      precipGroup.appendChild(accumSpan);
    }

    li.append(daySpan, iconBtn, tipEl, vbarCol, precipGroup);
    dayCards.push(li);
  }
  els.dailyList.replaceChildren(...dayCards);
  wireInterestHints(els.dailyList);
  syncAlertsUiWithLocation();
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
  els.radarDisclosure.open = false;
  syncRadarToggleCta();
  syncLocationUrlAndStorage(loc);

  // Start NWS alerts independently so it never blocks rendering hero numbers
  const alertsPromise = fetchNwsAlerts(loc.lat, loc.lon, loc.countryCode).catch(() => []);

  const cached = getCachedForecast(loc.lat, loc.lon);
  if (cached) {
    appState.forecast = cached.data;
    appState.alerts = [];
    renderAll({
      freshnessLabel: 'Updated just now',
      isInitialLocationLoad: true,
    });
    alertsPromise.then((alerts) => {
      if (seq !== appState.requestSeq || !alerts.length) return;
      appState.alerts = alerts;
      renderAlerts(alerts);
    });
    return;
  }

  appState.forecast = null;
  appState.alerts = [];
  clearDisplayedWeather(loc);

  try {
    const freshForecast = await fetchForecast(loc.lat, loc.lon);
    if (seq !== appState.requestSeq) return;

    appState.forecast = freshForecast;
    renderAll({
      freshnessLabel: 'Updated just now',
      isInitialLocationLoad: true,
    });

    alertsPromise.then((alerts) => {
      if (seq !== appState.requestSeq || !alerts.length) return;
      appState.alerts = alerts;
      renderAlerts(alerts);
      const currentHourIdx = findCurrentHourIndex(freshForecast.hourly.time, freshForecast.current.time);
      const interest = evaluateRadarInterest(freshForecast, alerts, currentHourIdx);
      els.radarReasonBadge.textContent = interest.reason;
      els.radarReasonBadge.dataset.interesting = String(interest.interesting);
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

    const tag = document.createElement('span');
    tag.className = 'debug-preset-tag';
    tag.textContent = `${preset.scene.tempF}°F · ${preset.scene.windMph} mph`;

    card.append(art, title, sub, tag);

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

    const cue = document.createElement('span');
    cue.className = 'debug-icon-cue';
    cue.textContent = spec.cue || '';

    item.append(art, label, cue);
    return item;
  });
  els.debugIconGrid.replaceChildren(...iconNodes);
}

function prepareSceneLegendDialog() {
  buildDebugGallery();
  setMixerFromScene(appState.liveHeroScene || HERO_SCENE_PRESETS[0].scene);
}

function openSceneDebugDialog() {
  prepareSceneLegendDialog();
  if (!els.sceneDebugDialog.open) {
    els.sceneDebugDialog.showModal();
  }
}

els.sceneDebugDialog?.addEventListener('command', (e) => {
  if (e.command === 'show-modal') {
    prepareSceneLegendDialog();
  }
});

els.legendBtn?.addEventListener('click', () => {
  prepareSceneLegendDialog();
});

for (const ctrl of [els.mixerTime, els.mixerSky, els.mixerTransition, els.mixerEta, els.mixerTemp, els.mixerWind]) {
  ctrl?.addEventListener('input', () => {
    highlightActivePresetCard('');
    updateMixerPreview();
  });
}

for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('close', () => {
    dlg.returnValue = '';
  });
}

// ============================================================================
// Interest-Triggered Toggletip ARIA Wiring & Modern Web Platform Fallbacks
// ============================================================================

const ownedInterestTriggers = new WeakSet();

function getTriggerAccessibleName(el) {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  const textContent = el.textContent?.trim();
  if (textContent) return textContent;
  return (el.getAttribute('title') || '').trim();
}

function isPopoverCurrentlyOpen(popoverEl) {
  try {
    return popoverEl.matches(':popover-open') || popoverEl.classList.contains(':popover-open');
  } catch {
    return popoverEl.classList.contains(':popover-open');
  }
}

function wireInterestHints(root = document) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  for (const trigger of root.querySelectorAll('[interestfor]')) {
    const targetId = trigger.getAttribute('interestfor');
    if (!targetId) continue;
    const hint = document.getElementById(targetId);
    if (!hint || hint.getAttribute('popover') !== 'hint') continue;

    const triggerName = norm(getTriggerAccessibleName(trigger));
    const hintText = norm(hint.textContent);
    if (triggerName && triggerName === hintText) continue;

    if (!hint.hasAttribute('role')) {
      hint.setAttribute('role', 'tooltip');
    }

    if (!triggerName) {
      if (!trigger.hasAttribute('aria-labelledby')) {
        trigger.setAttribute('aria-labelledby', targetId);
      }
      continue;
    }

    const opensOnActivate =
      trigger.getAttribute('popovertarget') === targetId ||
      trigger.getAttribute('commandfor') === targetId;

    if (opensOnActivate) {
      if (!trigger.hasAttribute('aria-expanded') || ownedInterestTriggers.has(trigger)) {
        trigger.setAttribute('aria-expanded', String(isPopoverCurrentlyOpen(hint)));
        ownedInterestTriggers.add(trigger);
      }
    } else if (!trigger.hasAttribute('aria-describedby')) {
      trigger.setAttribute('aria-describedby', targetId);
    }
  }
}

document.addEventListener(
  'toggle',
  (event) => {
    const popoverEl = event.target;
    if (!(popoverEl instanceof HTMLElement) || !popoverEl.id) return;
    const isOpen = event.newState ? event.newState === 'open' : isPopoverCurrentlyOpen(popoverEl);
    for (const trigger of document.querySelectorAll(`[interestfor="${CSS.escape(popoverEl.id)}"]`)) {
      if (ownedInterestTriggers.has(trigger)) {
        trigger.setAttribute('aria-expanded', String(isOpen));
      }
    }
  },
  true,
);

function installOverlayPolyfillsAndFallbacks() {
  wireInterestHints(document);

  if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
    import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
  } else {
    const probe = document.createElement('div');
    probe.popover = 'hint';
    if (probe.popover !== 'hint') {
      document.addEventListener(
        'beforetoggle',
        ({ target, newState }) => {
          if (!(target instanceof HTMLElement) || !target.id) return;
          const isToggletip =
            target.getAttribute('popover') === 'hint' &&
            document.querySelector(`[popovertarget="${CSS.escape(target.id)}"]`);
          if (newState === 'open' && isToggletip) {
            target.popover = 'auto';
          }
        },
        true,
      );
    }
  }

  if (!('interestForElement' in HTMLButtonElement.prototype)) {
    import('https://unpkg.com/interestfor@latest').catch(() => {});
  }

  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    import('https://esm.run/invokers-polyfill').catch(() => {});
  }

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const isOutside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = isOutside(e, dialog);
      });
      dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && isOutside(e, dialog)) {
          dialog.close();
        }
      });
    }
  }
}

// ============================================================================
// 100% Static Local Rain & Snow Awakenings (IndexedDB + Service Worker)
// ============================================================================

const IDB_NAME = 'overworld_db';
const IDB_STORE = 'kv';
const ALERT_PREFS_KEY = 'alert_prefs';
const PRECIP_SYNC_TAG = 'overworld-precip-check';

let swRegistrationPromise = null;
let alertsFeedbackTimer = null;
let cachedAlertPrefs = {
  enabled: false,
  threshold: 35,
  location: null,
  unit: appState.unit,
  lastNotifiedKey: null,
  lastCheckedAt: null,
};

function openAppDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readAlertPrefs() {
  try {
    const db = await openAppDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(ALERT_PREFS_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeAlertPrefs(nextPrefs) {
  cachedAlertPrefs = { ...cachedAlertPrefs, ...nextPrefs };
  try {
    const db = await openAppDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(cachedAlertPrefs, ALERT_PREFS_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(reqError(tx));
    });
  } catch {
    // Ignore private-browsing IndexedDB restrictions
  }
  renderAlertPrefsUi();
}

function reqError(tx) {
  return tx?.error || new Error('IndexedDB transaction failed');
}

function showAlertsFeedback(msg) {
  if (!els.alertsFeedback) return;
  clearTimeout(alertsFeedbackTimer);
  els.alertsFeedback.textContent = msg;
  els.alertsFeedback.hidden = !msg;
  if (msg) {
    alertsFeedbackTimer = setTimeout(() => {
      els.alertsFeedback.hidden = true;
    }, 5200);
  }
}

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker.register('./sw.js').catch(() => null);
  }
  return swRegistrationPromise;
}

async function registerBackgroundPrecipWakeup(reg) {
  if (!reg) return;
  if ('periodicSync' in reg) {
    try {
      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await reg.periodicSync.register(PRECIP_SYNC_TAG, { minInterval: 12 * 60 * 60 * 1000 });
        }
      } else {
        await reg.periodicSync.register(PRECIP_SYNC_TAG, { minInterval: 12 * 60 * 60 * 1000 });
      }
    } catch {
      // Best-effort periodic background sync
    }
  }
  if ('sync' in reg) {
    try {
      await reg.sync.register(PRECIP_SYNC_TAG);
    } catch {
      // Optional one-shot sync
    }
  }
}

async function sendSwMessage(type) {
  const reg = await ensureServiceWorker();
  const worker = reg?.active || reg?.waiting || reg?.installing || navigator.serviceWorker?.controller;
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 7000);
    channel.port1.onmessage = (ev) => {
      clearTimeout(timer);
      resolve(ev.data);
    };
    worker.postMessage({ type }, [channel.port2]);
  });
}

function serializeOpenLocation() {
  return {
    name: appState.location.name,
    admin1: appState.location.admin1 || '',
    countryCode: appState.location.countryCode || '',
    lat: appState.location.lat,
    lon: appState.location.lon,
  };
}

function renderAlertPrefsUi() {
  const active = Boolean(cachedAlertPrefs.enabled) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  if (els.alertsBtn) {
    els.alertsBtn.setAttribute('aria-pressed', String(active));
  }
  if (els.alertsDot) {
    els.alertsDot.hidden = !active;
  }
}

function syncAlertsUiWithLocation() {
  const openLoc = serializeOpenLocation();
  const locChanged = !cachedAlertPrefs.location || !isSameLocation(cachedAlertPrefs.location, openLoc);
  if (cachedAlertPrefs.enabled && (locChanged || cachedAlertPrefs.unit !== appState.unit)) {
    void writeAlertPrefs({ location: openLoc, unit: appState.unit });
  } else {
    renderAlertPrefsUi();
  }
}

els.alertsBtn?.addEventListener('click', async () => {
  const currentlyActive =
    Boolean(cachedAlertPrefs.enabled) && typeof Notification !== 'undefined' && Notification.permission === 'granted';

  if (currentlyActive) {
    const reg = await ensureServiceWorker();
    if (reg && 'periodicSync' in reg) {
      await reg.periodicSync.unregister(PRECIP_SYNC_TAG).catch(() => {});
    }
    await writeAlertPrefs({ enabled: false });
    showAlertsFeedback('Rain & snow alerts off.');
    return;
  }

  if (typeof Notification === 'undefined') {
    showAlertsFeedback('Install Overworld to your Home Screen (or use Android Chrome) to enable alerts.');
    return;
  }

  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') {
    await writeAlertPrefs({ enabled: false });
    showAlertsFeedback('Allow notifications in browser settings to receive rain & snow heads-ups.');
    return;
  }

  const openLoc = serializeOpenLocation();
  await writeAlertPrefs({
    enabled: true,
    threshold: 35,
    location: openLoc,
    unit: appState.unit,
  });

  const reg = await ensureServiceWorker();
  await registerBackgroundPrecipWakeup(reg);
  showAlertsFeedback(`Armed for ${openLoc.name} · notifies only when rain or snow is likely tomorrow.`);
  if (new Date().getHours() >= 15) {
    void sendSwMessage('CHECK_PRECIP_NOW');
  }
});

async function initStaticAwakenings() {
  const saved = await readAlertPrefs();
  if (saved) {
    cachedAlertPrefs = { ...cachedAlertPrefs, ...saved };
  }
  renderAlertPrefsUi();

  const reg = await ensureServiceWorker();
  if (cachedAlertPrefs.enabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    await writeAlertPrefs({ location: serializeOpenLocation(), unit: appState.unit });
    await registerBackgroundPrecipWakeup(reg);
    if (new Date().getHours() >= 15) {
      void sendSwMessage('CHECK_PRECIP_NOW');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!cachedAlertPrefs.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const ageMs = Date.now() - Number(cachedAlertPrefs.lastCheckedAt || 0);
    if (new Date().getHours() >= 15 && ageMs > 4 * 60 * 60 * 1000) {
      void sendSwMessage('CHECK_PRECIP_NOW');
    }
  });
}

// ============================================================================
// Boot
// ============================================================================

(() => {
  installOverlayPolyfillsAndFallbacks();
  void ensureTemporal();
  void initStaticAwakenings();
  loadWeatherForLocation(appState.location);
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    openSceneDebugDialog();
  }
})();
