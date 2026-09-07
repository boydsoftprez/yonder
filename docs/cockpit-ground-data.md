# Ground data and offline preparation

R-FLT-11/12. Geographic data and observed internet traffic belong to the ground browser by default. Individual terrain, imagery and traffic sources default off and remain opt-in; previously enabled source flags are read from the aircraft configuration. Each newly opened browser selects ground routing, even if another client previously selected the aircraft proxy.

In **Display & data → Connection & offline data**, select Ground browser internet,
Offline browser packs, or the explicit Aircraft proxy. The browser's own network
route still matters: a browser connected to the aircraft modem will use that
connection even for a direct public URL. Give the ground device its own internet
route to keep public downloads away from the aircraft link.

The same panel exposes **Display telemetry updates** at 1, 2, 4 or 8 reads per
second and reports received JSON bytes. The recurring `/cockpit/api/flight`
response carries scalar telemetry, freshness, navigation and mission progress.
It omits the mission list, command history and traffic. Separate `/details` and
`/mission` reads refresh only when their tokens change and do not block flight
updates. The displayed KiB/s includes those occasional JSON transfers; it excludes
HTTP/TLS overhead, compressed wire size, video and public geographic downloads.

## Source modes

| Mode | Elevation and imagery | Prepared terrain | Traffic |
| --- | --- | --- | --- |
| Ground (default) | Browser uses its internet connection; optionally an explicitly configured ground relay | Imported browser package only | Browser queries ADSB.lol; trails stay local |
| Offline | Explicitly imported map files; a missing tile stays missing | Imported browser package only | Unavailable; no requests |
| Aircraft | Explicit same-origin aircraft proxy requests | Explicit aircraft package requests | Current points from `/cockpit/api/traffic`; trails reconstructed locally |

There is no automatic change of mode after an error. In particular, ground failure never switches public downloads or a terrain package onto the aircraft link. Mode/source changes abort pending browser requests and invalidate source-specific render caches. Aircraft proxying must also be explicitly enabled in the authenticated aircraft data settings.

## Prepare the ground browser

Use **Import terrain folder**, **Import offline map folder**, and **Import EGM96
geoid** in that panel. Imported terrain/map folders persist in this browser's
IndexedDB; the geoid is loaded for the current session. With a configured ground
relay, **Preload terrain from ground relay** explicitly downloads and verifies its
prepared terrain pack. The button never reads the aircraft terrain endpoint in
Ground mode.

Import the directory `packages/yonder-core/src/terrain/assets/cove` using the terrain-directory picker, including `manifest.json` and all 227 `.bin.gz` files. The package contains 20,973,049 compressed tile bytes. Browser validation checks the manifest, each file hash, decoded lengths, coordinate references and missing-cell behavior before atomically replacing the previous package in IndexedDB. A failed import leaves the previous package intact. HTTPS or localhost is required for browser cryptographic validation. Browser storage can be evicted; check its available-package status before disconnecting.

The package survives a page reload. Ground and offline modes use that local copy; they do not fetch the package from the aircraft. The pack's own README and preparation report document its 2016 survey, EGM96 conversion and 28 suspect surface cells retained as unknown. One metre sampling does not establish one metre absolute accuracy or a complete current obstacle inventory.

For a licensed offline map, import `map-manifest.json` and its named PNG/JPEG tile files. This is an explicit import of operator-provided data, not a provider tile scraper. A manifest has this shape:

```json
{"schemaVersion":1,"id":"my-ground-map","title":"Local map","attribution":"USGS","sourceUrl":"https://www.usgs.gov/","license":"Public domain","offlineAllowed":true,"tiles":[{"layer":"imagery","z":15,"x":8795,"y":12871,"file":"image-15-8795-12871.jpg","sha256":"<64 lowercase hex digits>","bytes":18020,"type":"image/jpeg"}]}
```

Allowed layers are `imagery`, `places`, `roads` and Terrarium-encoded `elevation`. Tile coordinates follow XYZ order. At most 1,024 listed tiles and 64 MiB of files can be imported per package. Source attribution and a declaration that offline use is allowed are mandatory; the operator must have the rights described by that declaration. Ordinary Esri live tiles are kept in session memory only and are not exported to IndexedDB.

Traffic remains map-only when a geometric altitude reference is unavailable. An optional local import of `packages/yonder-core/src/cockpit/assets/egm96-5.pgm` enables the same WGS84 geometric-height to EGM96 conversion used by the aircraft service. The browser validates its SHA-256 (`c4b25a03ec5845cec4778a54b580aeda676363f2205a89137e8677b2337af3ec`). This file is selected from ground storage; it is never automatically downloaded over the aircraft link. Pressure altitude is never substituted for geometric height. The grid stays in memory for that page session and must be reimported after reload.

## Optional operator-owned ground relay

Direct providers may reject browser CORS or a network address. The optional relay runs on the operator's ground computer, with no aircraft transport or command route:

```sh
node scripts/cockpit/ground-data-server.mjs --allow-origin http://127.0.0.1:4196 --port 4197 --terrain-dir packages/yonder-core/src/terrain/assets/cove
```

The service binds loopback. Set the allowed origin to the exact cockpit page origin. Set the cockpit's ground relay origin to `http://127.0.0.1:4197` only when that relay is intentionally in use. Remote tablets require an operator-managed HTTPS ground service; a laptop's loopback address does not identify the laptop from a tablet. Browser private-network/mixed-content permissions still apply and failures remain visible. Do not deploy this helper on the aircraft and label it ground internet.

The relay accepts GET for fixed geographic/traffic paths and explicitly listed package files. It rejects other origins, command methods, arbitrary target URLs, oversized responses and excessive concurrency. It does not bypass provider authentication, quotas or refusal: a provider's HTTP 403 remains unavailable. The optional `--terrain-dir` makes a ground package available for the explicit `preloadTerrainPack(origin)` action; that action downloads the package to IndexedDB and verifies it just like a local file import. Starting the relay does not preload anything.

## Provider contract for the native host

Import `createGroundDataProvider` from `src/ui/cockpit/ground-data.mjs`. Construct one provider for the cockpit and pass it as `dataProvider` to `YonderCockpitMap`, `TerrainVision` and `CameraTerrainOverlay`. Close it when the cockpit unmounts.

- `configure({mode, terrain, imagery, traffic, trafficRadiusNm, groundRelayUrl})`: validated source settings. Radius is an integer from 1 through 100 NM. Defaults are ground mode, 25 NM and all sources off.
- `options`, `revision`, `subscribe(callback)`, `status()`: inspect settings/status and invalidate renderers on changes; subscribe returns an unsubscribe function.
- `tile(layer,z,x,y,{signal})`: selected-source image Blob, with bounded fetch/cache and no fallback.
- `terrainManifest({signal})` and `terrainTile(descriptor,{signal})`: selected-source manifest and raw decoded DTM/DSM bytes.
- `pollTraffic({lat,lon})`: requests only the selected traffic source, at most once per two seconds, with backoff. There is no timer in the provider constructor. Call it only while the cockpit is visible and has a fresh position.
- `trafficSnapshot({lat,lon})`: observed targets and browser-maintained trails. Current aircraft points are obtained only in explicit aircraft mode via `/cockpit/api/traffic`; the recurring flight endpoint is never polled by this provider.
- `refreshOffline()`: load retained-package summaries after construction. `importTerrainPack(File[])`, `importOfflineMap(File[])`, `preloadTerrainPack(groundOrigin,{signal})` and `clearOffline()` manage explicit imports. `importGeoid(File)` provisions optional local traffic height conversion.

Live image memory is bounded to 32 MiB and 128 entries, decoded terrain memory to 16 MiB, and terrain renderer sample caches to 64 tiles. Requests are bounded to six active and 64 waiting, with 12-second timeouts, 512 KiB image responses and 4 MiB public traffic responses. Images receive short session reuse; they are not bulk-downloaded for offline export. Terrain imports are bounded to 64 MiB and decoded tile lengths are checked before use.

Traffic preserves the core normalization: provider observation time and `seen_pos`, 15-second stale status, 60-second target expiry, at most 128 targets, five minutes of history and 150 points per target, with breaks for invalid positions, long gaps and implausible jumps. A source refresh cannot make an old observation fresh.

## Verified provider behavior and limits

On 2026-09-07 an isolated Chromium page at localhost successfully fetched and decoded a Terrarium PNG and Esri World Imagery JPEG directly. Both returned HTTP 200 and `Access-Control-Allow-Origin: *`. ADSB.lol failed direct browser access from this network, and the corresponding Node request returned HTTP 403 without a CORS header. No live traffic-success claim is made for that network; tests cover honest error/backoff and no aircraft fallback.

The actual 227-file USGS pack was imported into Chromium IndexedDB, the page reloaded, and the native adapter loaded one metre nearby and four metre distant meshes. Home sampling returned DTM 316.383 m and mapped surface 319.187 m EGM96. The verification observed **zero `/cockpit/api/` requests**.

Primary provider references:

- [ADSB.lol public API and ODbL license](https://www.adsb.lol/docs/open-data/api/); [official radius implementation](https://github.com/adsblol/api/blob/main/src/adsb_api/utils/api_v2.py) accepts integer radii up to 250 NM. Yonder bounds operator queries to 100 NM. [Provider rate limits are dynamic](https://github.com/adsblol/api/blob/main/README.md); 4xx responses are not a reason to switch connections automatically.
- [Terrarium endpoint and zoom limits](https://github.com/tilezen/joerd/blob/master/docs/use-service.md), [encoding](https://github.com/tilezen/joerd/blob/master/docs/formats.md) and [upstream attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Terrarium display heights do not establish a verified terrain-warning datum.
- [ArcGIS export-task documentation](https://developers.arcgis.com/ios/api-reference/interface_a_g_s_export_tile_cache_task.html) distinguishes normal live basemap services from export-enabled services. This implementation performs live viewing only; offline maps are separately imported with provenance.
