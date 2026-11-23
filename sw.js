// ============================================================================
// Overworld — 100% Static Service Worker (Offline App Shell + Local Awakenings)
// ============================================================================

const SHELL_CACHE = 'overworld-shell-v6';
const PRECIP_SYNC_TAG = 'overworld-precip-check';
const DB_NAME = 'overworld_db';
const DB_STORE = 'kv';
const PREFS_KEY = 'alert_prefs';

const APP_SHELL_URLS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/api.js',
  './js/iso-art.js',
  './js/pixel-map.js',
  './js/radar.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
];

// ============================================================================
// IndexedDB Shared Store (accessible from both Window and Service Worker)
// ============================================================================

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================================
// Lifecycle & Network-First App Shell Caching
// ============================================================================

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.all(
          APP_SHELL_URLS.map(async (url) => {
            const res = await fetch(new Request(url, { cache: 'no-cache' }));
            if (res.ok) await cache.put(url, res);
          }),
        ),
      )
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-cache' });
        if (fresh && fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const fallbackDoc = await caches.match('./index.html');
          if (fallbackDoc) return fallbackDoc;
        }
        throw new Error('Offline and not cached');
      }
    })(),
  );
});

// ============================================================================
// Tomorrow Rain / Snow Evaluation & Silent-Unless-Needed Local Notifications
// ============================================================================

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weekdayFromIsoDate(isoDate) {
  let [y, m, d] = String(isoDate).split('-').map(Number);
  if (!y || !m || !d) return 'Tomorrow';
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  if (m < 3) y -= 1;
  const dowSun0 = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7;
  const isoDow = dowSun0 === 0 ? 7 : dowSun0;
  return WEEKDAYS[isoDow - 1] || 'Tomorrow';
}

function fmtTemp(f, unit) {
  const val = Math.round(unit === 'C' ? ((Number(f) - 32) * 5) / 9 : Number(f));
  return `${val}°${unit === 'C' ? 'C' : 'F'}`;
}

function fmtPrecipAmount(inches, unit) {
  const v = Number(inches || 0);
  if (v <= 0.01) return '';
  if (unit === 'C') return ` (~${(v * 25.4).toFixed(1)} mm)`;
  const s = v < 1 ? v.toFixed(2).slice(1) : v.toFixed(2);
  return ` (~${s}")`;
}

function classifyTomorrowPrecip(code, highF, lowF, snowSumIn = 0) {
  const c = Number(code ?? 0);
  if (c >= 95) {
    return { kind: 'storm', glyph: '⛈️', noun: 'Storms' };
  }
  const isSnow =
    (c >= 71 && c <= 77) ||
    c === 85 ||
    c === 86 ||
    Number(snowSumIn) >= 0.1 ||
    Number(highF) <= 33 ||
    ((c >= 51 && c <= 67) && (Number(highF) + Number(lowF)) / 2 <= 32);
  if (isSnow) {
    return { kind: 'snow', glyph: '❄️', noun: 'Snow' };
  }
  return { kind: 'rain', glyph: '💧', noun: 'Rain' };
}

function buildCityUrl(loc) {
  const params = new URLSearchParams({
    lat: Number(loc.lat).toFixed(4),
    lon: Number(loc.lon).toFixed(4),
    name: loc.name || 'Saved Location',
  });
  if (loc.admin1) params.set('admin1', loc.admin1);
  if (loc.countryCode) params.set('cc', loc.countryCode);
  return `./?${params.toString()}`;
}

async function checkTomorrowPrecipAndNotify({ forceTest = false } = {}) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { notified: false, reason: 'permission-not-granted' };
  }

  const prefs = (await idbGet(PREFS_KEY)) || {};
  if (!forceTest && !prefs.enabled) {
    return { notified: false, reason: 'disabled' };
  }

  const loc = prefs.location;
  if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon))) {
    return { notified: false, reason: 'no-location' };
  }

  const unit = prefs.unit === 'C' ? 'C' : 'F';
  const threshold = Number.isFinite(Number(prefs.threshold)) ? Number(prefs.threshold) : 35;

  const params = new URLSearchParams({
    latitude: Number(loc.lat).toFixed(4),
    longitude: Number(loc.lon).toFixed(4),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,snowfall_sum',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: '3',
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) {
    return { notified: false, reason: 'fetch-failed' };
  }
  const data = await res.json();
  const daily = data?.daily;
  if (!daily?.time || daily.time.length < 2) {
    return { notified: false, reason: 'missing-daily' };
  }

  const tomorrowDate = daily.time[1];
  const dayLabel = weekdayFromIsoDate(tomorrowDate);
  const pop = Math.round(Number(daily.precipitation_probability_max?.[1] ?? 0));
  const precipIn = Number(daily.precipitation_sum?.[1] ?? 0);
  const snowIn = Number(daily.snowfall_sum?.[1] ?? 0);
  const code = Number(daily.weather_code?.[1] ?? 0);
  const highF = Number(daily.temperature_2m_max?.[1] ?? 60);
  const lowF = Number(daily.temperature_2m_min?.[1] ?? 45);

  const dedupeKey = `${tomorrowDate}:${Number(loc.lat).toFixed(2)},${Number(loc.lon).toFixed(2)}`;
  const nowTs = Date.now();

  if (!forceTest && prefs.lastNotifiedKey === dedupeKey) {
    await idbSet(PREFS_KEY, { ...prefs, lastCheckedAt: nowTs });
    return { notified: false, reason: 'already-notified', pop, tomorrowDate };
  }

  const notable = pop >= threshold || precipIn >= 0.08 || snowIn >= 0.1;

  if (!forceTest && !notable) {
    await idbSet(PREFS_KEY, { ...prefs, lastCheckedAt: nowTs });
    return { notified: false, reason: 'below-threshold', pop, tomorrowDate };
  }

  const info = classifyTomorrowPrecip(code, highF, lowF, snowIn);
  const title = forceTest && !notable
    ? `☀️ Quiet skies tomorrow in ${loc.name} (Test)`
    : `${info.glyph} ${info.noun} heads-up for ${dayLabel} in ${loc.name}`;

  const amountLabel =
    info.kind === 'snow' && snowIn >= 0.1
      ? unit === 'C'
        ? ` (~${(snowIn * 2.54).toFixed(1)} cm)`
        : ` (~${snowIn.toFixed(1)}")`
      : fmtPrecipAmount(precipIn, unit);
  const body = forceTest && !notable
    ? `Only ${pop}% precip chance tomorrow (${fmtTemp(highF, unit)} / ${fmtTemp(lowF, unit)}) — real alerts stay silent on days like this.`
    : `${pop}% chance of ${info.noun.toLowerCase()}${amountLabel} · High ${fmtTemp(highF, unit)} / Low ${fmtTemp(lowF, unit)}`;

  await self.registration.showNotification(title, {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    tag: forceTest ? 'overworld-test-precip' : `overworld-precip-${tomorrowDate}`,
    renotify: Boolean(forceTest),
    data: { url: buildCityUrl(loc) },
  });

  await idbSet(PREFS_KEY, {
    ...prefs,
    lastCheckedAt: nowTs,
    ...(forceTest ? {} : { lastNotifiedKey: dedupeKey }),
  });

  return { notified: true, pop, tomorrowDate };
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === PRECIP_SYNC_TAG) {
    event.waitUntil(checkTomorrowPrecipAndNotify().catch(() => {}));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === PRECIP_SYNC_TAG) {
    event.waitUntil(checkTomorrowPrecipAndNotify().catch(() => {}));
  }
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'CHECK_PRECIP_NOW' || type === 'TEST_PRECIP_ALERT') {
    const forceTest = type === 'TEST_PRECIP_ALERT';
    const port = event.ports?.[0];
    event.waitUntil(
      checkTomorrowPrecipAndNotify({ forceTest })
        .then((res) => port?.postMessage({ ok: true, ...res }))
        .catch((err) => port?.postMessage({ ok: false, error: String(err?.message || err) })),
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetRelUrl = event.notification.data?.url || './';
  const targetUrl = new URL(targetRelUrl, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            await client.navigate(targetUrl).catch(() => {});
          }
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
