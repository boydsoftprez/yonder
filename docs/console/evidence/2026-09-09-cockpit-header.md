# Cockpit app-header controls

R-FLT-25 / blueprint F-25. The existing flight-control component now renders in
Dashboard's supported `#app-bar-actions` outlet. The outer material brand remains
owned by the console theme. No flow, core service or command protocol changes
are required. Standalone, fullscreen and very narrow layouts keep the same
toolbar inside the cockpit. The PFD and map are not replaced when it moves.

One Display menu leads to layout/units, PFD settings, background/data and director
settings. Aircraft owns telemetry setup and reported operation status. Flight
plan owns mission read/upload and Home. Contextual map and instrument shortcuts
open these same editors. Dialogs use a shared overlay outside the cockpit's
layout containment, above the app header; fullscreen moves that overlay inside
the fullscreen element. The Home action groups have separation even when no
controller-home comparison is available.

## Automated validation

The widget package passed **924 tests in 82 files** using
`npx vitest run --maxWorkers=4 --minWorkers=1`. Five dedicated header tests cover
the supported outlet, page cleanup, portrait width selection, standalone fallback,
and the shared Display editor. Existing fullscreen tests plus the new Home test
verify that the PFD canvas and entered Home values survive portal moves. Aircraft
API mocks remain untouched by navigation and layout changes. The full suite also
covers mission review, home readback, and instrument-editor keyboard focus.

The production cockpit build passed. Bundle SHA-256:
`7b2d77c8ce63feb6bf06d394c212a09218a6cd078101e740a615721e2316392f`.

## Native browser walkthrough

`packages/node-red-dashboard-2-yonder/cockpit/header-preview.mjs` runs the real
Dashboard 1.31.0 shell and production widget with labeled synthetic data on
loopback port 4228. It uses a temporary Node-RED user directory and refuses every
aircraft write. Build the widget, its node wrappers and core before launching it.

Chrome checks used 1512×754, 1024×768, 768×1024 and 390×844 CSS-pixel viewports.
Temporary viewport overrides were reset afterward. These are responsive browser
checks, not physical iPad/Safari validation.

- At laptop width, controls occupy a single 45.4 px row within the existing
  65 px app header. The PFD canvas is 1048×549 px; no duplicate inner branding or
  bottom PFD menu row remains.
- At 1024 px, Direct-To, RTL and Flight remain visible alongside Flight plan,
  Display, Aircraft and fullscreen. Flight opens all eight command destinations;
  Heading uses the existing editor and Back returns to the menu.
- At 768 px, RTL, Flight, Display and Menu fit in a 498 px header area. The fixed
  sidebar narrows the cockpit, but does not cause the toolbar to fall out of the
  wider app header. Menu exposes Flight plan, Home, status, notices and fullscreen.
- At 390 px, the inline row retains RTL, Flight and Menu with 44 px touch targets.
  No document-level horizontal overflow was measured at any tested width.
- Home, Display and instrument editors were opened and closed. Home occupies
  y=12…742 at laptop size, covering the app header cleanly. Its close control and
  separate action groups are visible. The instrument editor also starts at y=12.
- Navigating to Status removes cockpit actions from the header; returning to
  Flight restores one copy. The primary display continues updating.

Automated fullscreen button activation in the background Chrome tab was refused
by the browser and showed the existing recoverable error. A foreground browser
was in concurrent camera use, so that run does not establish native fullscreen
entry. Fullscreen target/state preservation is covered by the component tests;
no browser security policy was changed. No real flight action or home update was
sent during this walkthrough.
