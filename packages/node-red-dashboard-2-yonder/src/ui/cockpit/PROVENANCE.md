# Cockpit source provenance

The PFD, touch controls and pure mission import/edit adapters are Yonder-authored,
GPL-3.0-or-later. They are packaged here without the research host or its server.

VSI geometry/scale and aircraft V-bar wedges derive from Peter Heinrich's SDU460,
Copyright 2024, GPL-3.0-or-later, revision
`5833dfee4f4396389c2e6f275f98e897958fce0f`,
https://github.com/peterheinrich/SDU460 (`PFD/VSI.svg`, `PFD/VSI.js`, `PFD/ADI.svg`).
The license is retained in `SDU460-COPYING`.

The 55-command Plane catalog is pinned in `data/mission-commands/sources.json`.
The metadata carries parameter units, defaults, enum options and firmware notes.
Navigation geometry in `cockpit-state.mjs` is original spherical geometry; no
simulator host, legacy flight-plan classes or external checkout is required.
