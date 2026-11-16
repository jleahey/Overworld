# Overworld

A pure static, zero-build, zero-clutter isometric weather page powered by free, keyless, CORS-enabled weather APIs.

## Features
- **Only what matters:** Current conditions, Next 24 Hours with 3D isometric temperature pillars, 7-Day Forecast with temperature range bars, active NWS weather alerts (US only, hidden when clear), and a **Smart Conditional Radar** that opens automatically when weather is interesting and stays collapsed to a 1-line bar when skies are quiet.
- **Best radar automatically picked by region (with cartoon pixel-art map):**
  - **Basemap:** Client-side 16-bit cartoon pixel-art terrain, coasts, highways, and city labels rendered from free, keyless [OpenFreeMap](https://openfreemap.org/) vector tiles (with an automatic keyless Esri pixel-shader fallback).
  - **Contiguous US:** Street-level animated **NOAA NEXRAD** composite tiles via [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/).
  - **Rest of the world (plus AK/HI/PR):** Animated global radar loop via [RainViewer](https://www.rainviewer.com/).
- **Forecast & search:** [Open-Meteo](https://open-meteo.com/) Forecast & Geocoding APIs, plus [BigDataCloud](https://www.bigdatacloud.com/) keyless reverse geocoding for the Locate button.
- **Isometric SVG art:** Hand-crafted 2:1 axonometric floating sky-island diorama and matching voxel weather icons that adapt to weather conditions, temperature extremes, day/night, and system light/dark mode.
- **Fast & bookmarkable:** Instant stale-while-revalidate `localStorage` caching, instant client-side `°F`/`°C` switching, URL coordinate sync (`?lat=...&lon=...`), and installable PWA manifest.

## Local Preview

Serve the directory with any static HTTP server:

```sh
python3 -m http.server 8123
```

Then open `http://localhost:8123`.

## Deploy

Drop the files directly onto GitHub Pages, Cloudflare Pages, Netlify, or any static host — no build step or API keys required.
