# Graphical instrument design study

R-UI-09 (bounded quantities shown against their bounds), R-FLT-10 (touch display
configuration). This is a design preview requested before production instrument
configuration is approved. It renders the actual `YonderCockpit`, PFD, terrain,
mission and map components, with a prototype instrument bank in the scoped
`instrument-strip` slot. The regular cockpit keeps its existing strip.

## Run and inspect

From the repository root, in separate terminals:

```sh
npm run cockpit:dev -w node-red-dashboard-2-yonder -- --port 4220
node scripts/cockpit/ground-data-server.mjs --allow-origin http://127.0.0.1:4220 --terrain-dir packages/yonder-core/src/terrain/assets/cove --port 4221
```

Open `http://127.0.0.1:4220/instruments.html?ground=http://127.0.0.1:4221`.
Without the optional ground URL, the actual conventional PFD background is used.
The ground URL accepts only a loopback HTTP origin for this local study. There is
no live-mode option or aircraft command transport in the study entry point.

- Switch **Placement** between the left column and top strip. Narrow layouts
  wrap the instruments above the PFD. The sidebar reserves room for the HSI
  between the existing mission and map insets.
- Tap an instrument or **Edit instruments**. Select a slot, choose its reading
  and choose an arc, horizontal scale or vertical scale. Move it earlier/later.
- **Apply to preview** keeps the arrangement for this page session. **Cancel**
  restores the previous arrangement; **Load default** stages the initial six
  instruments. This does not persist an aircraft layout or edit production
  preferences.
- **State** demonstrates normal, caution and unavailable readings. Unavailable
  readings remove the pointer, show a dash and cross the scale. Color bands and
  limits are explicit demonstration values, not aircraft operating limits.

All new instrument measurements are fixtures, including CPU percentage, LTE,
consumed charge and energy. The terrain background uses the existing prepared
Cove survey when enabled. No claim of live instrument ingestion, alert logic,
hardware calibration, aircraft threshold configuration or telemetry scheduling
is made by this study. Those remain for the implementation after operator review.

## Visual references

The instrument geometry follows the circular cursor, graded scales, color zones
and numeric readout conventions present in the community source:

- [Circular gauge definition](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/sdk/components/XMLGauges/GaugeDefinitions/CircularGauge.ts)
- [Circular instrument presentation](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/workingtitle-instruments-g3x-touch/html_ui/Shared/Components/EngineInstruments/Circle/G3XCircleGauge.css)
- [Horizontal scale presentation](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/workingtitle-instruments-g3x-touch/html_ui/Shared/Components/EngineInstruments/Linear/Horizontal/G3XHorizontalGauge.css)
- [Paired vertical scale presentation](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/workingtitle-instruments-g3x-touch/html_ui/Shared/Components/EngineInstruments/Linear/Vertical/G3XDoubleVerticalGauge.css)

`GaugeFace.vue` is a native Vue/SVG study of these conventions, not the simulator
runtime or a proprietary instrument asset. The surrounding cockpit is the actual
application rather than a redrawn illustration. These are not asserted to be
pixel-identical reproductions of any particular certified aircraft's instruments.

## Verification on 2026-09-08

The scoped-slot regression failed before the slot was added, then all ten host
component tests passed. The regular strip fallback and retained PFD were checked.
The dashboard production build passed (682.40 kB, 189.57 kB gzip); the prototype
entry and gauges are not imported into that production bundle.

Playwright exercised the actual study with the prepared terrain source:
instrument selection, all presentation choices across the editor/preview,
reordering, apply, cancel, default restoration, normal/caution/no-data states,
and both placements. The same PFD element stayed mounted. Captures and viewport
bounds were inspected at 1440×900, 1024×768 and 768×1024. There were no browser
exceptions or aircraft HTTP requests. These are browser viewport checks, not
physical iPad performance evidence.
