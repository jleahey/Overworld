// ============================================================================
// Overworld — Keyless Weather Data, Geocoding, NWS Alerts & SWR Cache
// ============================================================================

const CACHE_FRESH_MS = 10 * 60 * 1000;
const CACHE_MAX_MS = 60 * 60 * 1000;

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico',
};

const US_STATE_ABBR_BY_NAME = Object.fromEntries(
  Object.entries(US_STATES).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

export function toUnitTemp(fahrenheit, unit = 'F') {
  const f = Number(fahrenheit);
  return Math.round(unit === 'C' ? ((f - 32) * 5) / 9 : f);
}

export function formatTemp(fahrenheit, unit = 'F') {
  return `${toUnitTemp(fahrenheit, unit)}°`;
}

export function formatSpeed(mph, unit = 'F') {
  const v = Number(mph);
  return unit === 'C' ? `${Math.round(v * 1.60934)} km/h` : `${Math.round(v)} mph`;
}

export function formatPrecip(inches, unit = 'F') {
  const v = Number(inches);
  return unit === 'C' ? `${(v * 25.4).toFixed(1)} mm` : `${v.toFixed(2)}"`;
}

export function formatPlaceLabel(loc) {
  const parts = [];
  if (loc.admin1) {
    const abbr = loc.countryCode === 'US' ? US_STATE_ABBR_BY_NAME[loc.admin1.toLowerCase()] : null;
    parts.push(abbr || loc.admin1);
  }
  if (loc.countryCode && loc.countryCode !== 'US') {
    parts.push(loc.countryCode);
  } else if (!loc.admin1 && loc.country) {
    parts.push(loc.country);
  }
  return parts.join(', ');
}

function cacheKey(lat, lon) {
  return `ws_cache_v3_${Number(lat).toFixed(2)}_${Number(lon).toFixed(2)}`;
}

export function getCachedForecast(lat, lon) {
  try {
    const raw = localStorage.getItem(cacheKey(lat, lon));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data || !parsed?.savedAt) return null;
    const age = Date.now() - parsed.savedAt;
    if (age > CACHE_MAX_MS) return null;
    return {
      data: parsed.data,
      savedAt: parsed.savedAt,
      isFresh: age < CACHE_FRESH_MS,
      isStale: age >= CACHE_FRESH_MS,
    };
  } catch {
    return null;
  }
}

export async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: Number(lat).toFixed(4),
    longitude: Number(lon).toFixed(4),
    current: 'temperature_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    minutely_15: 'precipitation,weather_code',
    forecast_minutely_15: '8',
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: '8',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  let res;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
    } catch (err) {
      if (attempt === 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!res || !res.ok) {
    throw new Error(`Forecast request failed (${res?.status ?? 'network'})`);
  }
  const data = await res.json();

  try {
    localStorage.setItem(cacheKey(lat, lon), JSON.stringify({ data, savedAt: Date.now() }));
  } catch {
    // Ignore storage quota errors
  }

  return data;
}

async function queryOpenMeteoGeo(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

function matchesQualifier(item, qualifier) {
  if (!qualifier) return false;
  const q = qualifier.toLowerCase();
  const stateName = US_STATES[q.toUpperCase()]?.toLowerCase();
  const fields = [item.admin1, item.country, item.country_code]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  if (stateName && item.country_code === 'US' && item.admin1?.toLowerCase() === stateName) {
    return true;
  }
  return fields.some((f) => f === q || f.startsWith(q));
}

export async function searchLocations(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const commaIdx = trimmed.indexOf(',');
  let results = [];
  let qualifier = '';

  if (commaIdx > 0) {
    const cityPart = trimmed.slice(0, commaIdx).trim();
    qualifier = trimmed.slice(commaIdx + 1).trim();
    const [fullHits, cityHits] = await Promise.all([
      queryOpenMeteoGeo(trimmed),
      cityPart.length >= 2 ? queryOpenMeteoGeo(cityPart) : Promise.resolve([]),
    ]);
    const byId = new Map();
    for (const item of [...fullHits, ...cityHits]) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    results = Array.from(byId.values());
    if (qualifier) {
      results.sort((a, b) => Number(matchesQualifier(b, qualifier)) - Number(matchesQualifier(a, qualifier)));
    }
  } else {
    results = await queryOpenMeteoGeo(trimmed);
  }

  return results.slice(0, 6).map((r) => ({
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    countryCode: r.country_code || '',
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('Reverse geocode error');
    const data = await res.json();
    const code = data.principalSubdivisionCode || '';
    const admin1 = code.startsWith('US-') ? code.slice(3) : data.principalSubdivision || '';
    return {
      name: data.city || data.locality || data.principalSubdivision || 'Current Location',
      admin1,
      country: data.countryName || '',
      countryCode: data.countryCode || '',
      lat,
      lon,
    };
  } catch {
    return {
      name: 'Current Location',
      admin1: '',
      country: '',
      countryCode: '',
      lat,
      lon,
    };
  }
}

function isLikelyUsCoord(lat, lon) {
  const inConus = lat >= 24 && lat <= 50 && lon >= -126 && lon <= -65;
  const inAlaska = lat >= 51 && lat <= 72 && lon >= -179 && lon <= -129;
  const inHawaii = lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154;
  return inConus || inAlaska || inHawaii;
}

export async function fetchNwsAlerts(lat, lon, countryCode = '') {
  if (countryCode && countryCode !== 'US') return [];
  if (!countryCode && !isLikelyUsCoord(lat, lon)) return [];

  try {
    const url = `https://api.weather.gov/alerts/active?point=${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    return features.map((f) => {
      const p = f.properties || {};
      return {
        event: p.event || 'Weather Alert',
        headline: p.headline || p.event || '',
        severity: p.severity || 'Advisory',
        description: p.description || '',
        instruction: p.instruction || '',
      };
    });
  } catch {
    return [];
  }
}

function findCurrentMinutelyIndex(minutelyTimes, currentTimeStr) {
  if (!Array.isArray(minutelyTimes) || !minutelyTimes.length || !currentTimeStr) return 0;
  let best = 0;
  for (let i = 0; i < minutelyTimes.length; i += 1) {
    if (String(minutelyTimes[i]).localeCompare(String(currentTimeStr)) <= 0) {
      best = i;
    } else {
      break;
    }
  }
  return best;
}

function isWet15(minutely15, idx) {
  if (!minutely15 || idx < 0 || idx >= (minutely15.time?.length ?? 0)) return false;
  return Number(minutely15.precipitation?.[idx] ?? 0) >= 0.004 || Number(minutely15.weather_code?.[idx] ?? 0) >= 51;
}

export function describeImmediatePrecip(forecast, currentHourIndex = 0, unit = 'F') {
  const current = forecast?.current || {};
  const m15 = forecast?.minutely_15;
  const mStart = findCurrentMinutelyIndex(m15?.time, current.time);
  const wetNow =
    Number(current.precipitation) > 0 ||
    Number(current.weather_code) >= 51 ||
    isWet15(m15, mStart);

  if (wetNow) {
    if (m15?.time?.length) {
      const limit = Math.min(m15.time.length - 1, mStart + 7);
      for (let idx = mStart + 1; idx <= limit; idx += 1) {
        if (!isWet15(m15, idx)) {
          return { label: 'Rain Ends', value: `In ${(idx - mStart) * 15} min` };
        }
      }
    }
    const rate = Math.max(Number(current.precipitation || 0), Number(m15?.precipitation?.[mStart] || 0));
    return {
      label: 'Rain Now',
      value: rate > 0 ? `${formatPrecip(rate, unit)}/hr` : 'Steady',
    };
  }

  if (m15?.time?.length) {
    const limit = Math.min(m15.time.length - 1, mStart + 6);
    for (let idx = mStart + 1; idx <= limit; idx += 1) {
      if (isWet15(m15, idx)) {
        const mins = (idx - mStart) * 15;
        return { label: 'Rain Starts', value: `In ${mins} min`, startingInMins: mins };
      }
    }
  }

  const hourly = forecast?.hourly;
  const nextHrPop = Math.round(
    Math.max(
      Number(hourly?.precipitation_probability?.[currentHourIndex] ?? 0),
      Number(hourly?.precipitation_probability?.[currentHourIndex + 1] ?? 0),
    ),
  );
  return { label: 'Next Hour', value: `${nextHrPop}% rain` };
}

export function evaluateRadarInterest(forecast, alerts = [], currentHourIndex = 0) {
  if (alerts.length > 0) {
    return { interesting: true, reason: alerts[0].event };
  }

  const current = forecast?.current || {};
  if (Number(current.precipitation) > 0 || Number(current.weather_code) >= 51) {
    return { interesting: true, reason: 'Active precipitation nearby' };
  }

  const m15 = forecast?.minutely_15;
  if (m15?.time?.length) {
    const mStart = findCurrentMinutelyIndex(m15.time, current.time);
    const limit = Math.min(m15.time.length - 1, mStart + 6);
    for (let idx = mStart + 1; idx <= limit; idx += 1) {
      if (isWet15(m15, idx)) {
        return { interesting: true, reason: `Starting in ${(idx - mStart) * 15}m` };
      }
    }
  }

  const hourly = forecast?.hourly;
  if (hourly?.time?.length) {
    const endIdx = Math.min(hourly.time.length, currentHourIndex + 6);
    let maxProb = 0;
    let precipLikely = false;
    for (let i = Math.max(0, currentHourIndex); i < endIdx; i += 1) {
      const prob = Number(hourly.precipitation_probability?.[i] ?? 0);
      const amount = Number(hourly.precipitation?.[i] ?? 0);
      const code = Number(hourly.weather_code?.[i] ?? 0);
      if (prob > maxProb) maxProb = prob;
      if (prob >= 35 || amount > 0.01 || code >= 51) {
        precipLikely = true;
      }
    }
    if (precipLikely) {
      const label = maxProb >= 35 ? `Precip likely within 6h (${maxProb}%)` : 'Precip likely within 6h';
      return { interesting: true, reason: label };
    }
  }

  if (Number(current.wind_speed_10m) >= 22 || Number(current.wind_gusts_10m) >= 32) {
    return { interesting: true, reason: 'Gusty winds right now' };
  }

  return { interesting: false, reason: 'Quiet skies' };
}

function parseLocalMinutesOfDay(isoStr) {
  if (!isoStr) return null;
  const timePart = String(isoStr).split('T')[1];
  if (!timePart) return null;
  const [hh, mm] = timePart.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

/**
 * Derive a multi-signal Hero Diorama scene state from live forecast data.
 */
export function buildHeroSceneState(forecast, currentHourIndex = 0) {
  const current = forecast?.current || {};
  const m15 = forecast?.minutely_15;
  const hourly = forecast?.hourly;
  const daily = forecast?.daily;

  const isDay = Number(current.is_day ?? 1) ? 1 : 0;
  const tempF = Number(current.temperature_2m ?? 62);
  const windMph = Number(current.wind_speed_10m ?? 6);
  const windGustsMph = Number(current.wind_gusts_10m ?? 0);
  const weatherCode = Number(current.weather_code ?? 0);
  const precipNow = Number(current.precipitation ?? 0);

  const nowMins = parseLocalMinutesOfDay(current.time);
  const sunriseMins = parseLocalMinutesOfDay(daily?.sunrise?.[0]);
  const sunsetMins = parseLocalMinutesOfDay(daily?.sunset?.[0]);

  let timePhase = isDay ? 'day' : 'night';
  if (nowMins !== null && sunriseMins !== null && nowMins - sunriseMins >= -35 && nowMins - sunriseMins <= 50) {
    timePhase = 'dawn';
  } else if (nowMins !== null && sunsetMins !== null && nowMins - sunsetMins >= -50 && nowMins - sunsetMins <= 35) {
    timePhase = 'dusk';
  }

  const mStart = findCurrentMinutelyIndex(m15?.time, current.time);
  let sky = 'clear';
  if (weatherCode === 0) sky = 'clear';
  else if (weatherCode === 1) sky = 'mostly-clear';
  else if (weatherCode === 2) sky = 'partly';
  else if (weatherCode === 3) sky = 'overcast';
  else if (weatherCode === 45 || weatherCode === 48) sky = 'fog';
  else if (weatherCode >= 51 && weatherCode <= 57) sky = 'drizzle';
  else if (weatherCode === 65 || weatherCode === 67 || weatherCode === 82) sky = 'heavy-rain';
  else if ((weatherCode >= 61 && weatherCode <= 66) || weatherCode === 80 || weatherCode === 81) {
    sky = precipNow >= 0.18 ? 'heavy-rain' : 'rain';
  } else if (weatherCode === 75 || weatherCode === 86) sky = 'heavy-snow';
  else if ((weatherCode >= 71 && weatherCode <= 77) || weatherCode === 85) sky = 'snow';
  else if (weatherCode >= 95) sky = 'storm';

  if (weatherCode < 51) {
    if (precipNow >= 0.18) sky = 'heavy-rain';
    else if (precipNow > 0.02) sky = 'rain';
    else if (precipNow > 0 || Number(m15?.precipitation?.[mStart] ?? 0) >= 0.004) {
      sky = tempF <= 32 ? 'snow' : 'drizzle';
    }
  }

  const wetNow = ['drizzle', 'rain', 'heavy-rain', 'snow', 'heavy-snow', 'storm'].includes(sky);
  let transition = 'none';
  let transitionMins = null;

  if (!wetNow) {
    let etaMins = null;
    let futureCode = null;

    if (m15?.time?.length) {
      const limit = Math.min(m15.time.length - 1, mStart + 7);
      for (let idx = mStart + 1; idx <= limit; idx += 1) {
        if (isWet15(m15, idx)) {
          etaMins = (idx - mStart) * 15;
          futureCode = Number(m15.weather_code?.[idx] ?? 61);
          break;
        }
      }
    }

    if (etaMins === null && hourly?.time?.length) {
      const maxOffset = Math.min(3, hourly.time.length - 1 - currentHourIndex);
      for (let offset = 1; offset <= maxOffset; offset += 1) {
        const idx = currentHourIndex + offset;
        const pop = Number(hourly.precipitation_probability?.[idx] ?? 0);
        const amt = Number(hourly.precipitation?.[idx] ?? 0);
        const code = Number(hourly.weather_code?.[idx] ?? 0);
        if (pop >= 40 || amt >= 0.015 || code >= 51) {
          etaMins = offset * 60;
          futureCode = code >= 51 ? code : 61;
          break;
        }
      }
    }

    if (etaMins !== null) {
      transitionMins = etaMins;
      if (futureCode >= 95) transition = 'storm-soon';
      else if (
        (futureCode >= 71 && futureCode <= 77) ||
        futureCode === 85 ||
        futureCode === 86 ||
        tempF <= 32
      ) {
        transition = 'snow-soon';
      } else {
        transition = 'rain-soon';
      }
    } else if (
      (sky === 'clear' || sky === 'mostly-clear') &&
      (Number(hourly?.weather_code?.[currentHourIndex + 1] ?? 0) === 3 ||
        Number(hourly?.weather_code?.[currentHourIndex + 2] ?? 0) === 3)
    ) {
      transition = 'cloudy-soon';
      transitionMins = 90;
    }
  } else {
    if (m15?.time?.length) {
      const limit = Math.min(m15.time.length - 1, mStart + 7);
      for (let idx = mStart + 1; idx <= limit; idx += 1) {
        if (!isWet15(m15, idx)) {
          transition = 'clearing';
          transitionMins = (idx - mStart) * 15;
          break;
        }
      }
    }
    if (transition === 'none' && hourly?.time?.length) {
      const maxOffset = Math.min(2, hourly.time.length - 1 - currentHourIndex);
      for (let offset = 1; offset <= maxOffset; offset += 1) {
        const idx = currentHourIndex + offset;
        const pop = Number(hourly.precipitation_probability?.[idx] ?? 100);
        const code = Number(hourly.weather_code?.[idx] ?? 3);
        if (pop < 25 && code <= 2) {
          transition = 'clearing';
          transitionMins = offset * 60;
          break;
        }
      }
    }
  }

  return {
    sky,
    timePhase,
    transition,
    transitionMins,
    tempF,
    windMph,
    windGustsMph,
    weatherCode,
    isDay,
  };
}

const SKY_STORY_LABELS = {
  clear: 'Clear skies',
  'mostly-clear': 'Mostly clear',
  partly: 'Partly cloudy',
  overcast: 'Overcast',
  fog: 'Foggy',
  drizzle: 'Light drizzle',
  rain: 'Rain',
  'heavy-rain': 'Heavy rain',
  snow: 'Snowfall',
  'heavy-snow': 'Heavy snow',
  storm: 'Thunderstorm',
};

/**
 * Produce a readable summary describing all composed diorama cues.
 */
export function describeSceneStory(scene) {
  const skyText = SKY_STORY_LABELS[scene?.sky] || 'Clear skies';
  const timeText =
    scene?.timePhase === 'dawn'
      ? ' at dawn'
      : scene?.timePhase === 'dusk'
        ? ' at dusk'
        : scene?.timePhase === 'night'
          ? ' at night'
          : '';

  let transText = '';
  const mins = scene?.transitionMins;
  if (scene?.transition === 'rain-soon') {
    transText = mins ? `, rain arriving in ${mins} min` : ', rain approaching';
  } else if (scene?.transition === 'storm-soon') {
    transText = mins ? `, storm approaching in ${mins} min` : ', storm approaching';
  } else if (scene?.transition === 'snow-soon') {
    transText = mins ? `, snow arriving in ${mins} min` : ', snow approaching';
  } else if (scene?.transition === 'cloudy-soon') {
    transText = ', clouds moving in';
  } else if (scene?.transition === 'clearing') {
    transText = scene?.timePhase === 'night' ? ', clearing skies' : ', clearing to a rainbow';
  }

  const t = Number(scene?.tempF ?? 62);
  let biomeText = 'mild meadow';
  if (t <= 22) biomeText = 'deep freeze';
  else if (t <= 32) biomeText = 'freezing snowpack';
  else if (t <= 48) biomeText = 'chilly highland';
  else if (t >= 88) biomeText = 'scorching desert';
  else if (t >= 75) biomeText = 'warm poolside';

  const w = Number(scene?.windMph ?? 6);
  const g = Number(scene?.windGustsMph ?? 0);
  const windText = w >= 22 || g >= 32 ? 'windy' : w >= 10 ? 'breezy' : 'calm wind';

  return `${skyText}${timeText}${transText} · ${biomeText} · ${windText}`;
}
