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

Turn cues use independently authored Yonder geometry and standard coordinated-turn
physics. Behavioral references are Garmin's [G3X Touch Pilot's Guide,
190-02472-00 Rev D](https://static.garmin.com/pumac/190-02472-00_d.pdf),
printed page 53 (green standard-rate bank pointers), and the MSFS mirror's
`RollIndicator` / `TurnRateIndicator` behavior at revision
`366be5056166c639a2189e09e5af7143174fd910`. The reviewed behavior includes a 50-KT
TAS visibility threshold, six-second heading trend, half/standard-rate marks,
and a four-degree-per-second overrange arrow. No Microsoft/Garmin code or assets
were copied; the mirror's MSFS-only license addendum does not permit reuse here.
Yonder explicitly labels its velocity-minus-wind TAS estimate and places the ball
above the HSI at the operator's request.
