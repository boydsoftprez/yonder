// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: Leaflet uses the selected ground provider; no implicit URL/proxy layer.
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function createProviderTileLayer(L, provider, kind, onError) {
  const layer = L.gridLayer({
    maxZoom: 19,
    attribution: escape(
      provider?.status().attribution || "Selected geographic source",
    ),
  });
  layer.createTile = (coords, done) => {
    const tile = document.createElement("img"),
      controller = new AbortController();
    let url = null,
      released = false;
    tile.width = tile.height = 256;
    tile.alt = "";
    tile.setAttribute("role", "presentation");
    const revoke = () => {
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
    };
    tile.releaseGroundTile = () => {
      released = true;
      controller.abort();
      revoke();
      tile.onload = tile.onerror = null;
    };
    Promise.resolve()
      .then(() => {
        if (!provider) throw new Error("Ground map provider unavailable");
        return provider.tile(kind, coords.z, coords.x, coords.y, {
          signal: controller.signal,
        });
      })
      .then((blob) => {
        if (released) return;
        url = URL.createObjectURL(blob);
        tile.onload = () => {
          revoke();
          if (!released) done(null, tile);
        };
        tile.onerror = () => {
          revoke();
          if (!released) {
            const error = new Error("Map tile decode unavailable");
            onError?.(error);
            done(error, tile);
          }
        };
        tile.src = url;
      })
      .catch((error) => {
        if (!released) {
          onError?.(error);
          done(error, tile);
        }
      });
    return tile;
  };
  layer.on("tileunload", (e) => e.tile.releaseGroundTile?.());
  return layer;
}
