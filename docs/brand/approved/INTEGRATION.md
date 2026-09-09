# Integrating the Yonder identity

Use the approved **material airframe and split-Y wordmark** throughout the app.
The original signed implementation is `99d5c0de3c3fc65684ca9cdaee5e51247a4bb099`.
Integrate that change once into the combined app branch, preserving subsequent
work in the console theme and pages. If the files and integrations below are
already present, use them rather than reapplying the original change.

## Shared source and entry points

| Location | Responsibility |
| --- | --- |
| `packages/yonder-core/src/console/brand.ts` | Canonical geometry, lettering, material finish, and day/night variants |
| `packages/yonder-core/src/console/assets.ts` | Embeds the material SVG into the login response |
| `packages/yonder-core/src/console/assets/login.html` | Accessible heading and responsive logo placement |
| `packages/yonder-core/src/console/theme.ts` | Shared app-header SVG and its responsive spacing |
| `docs/brand/approved/` | Generated SVG exports, preview, and usage guide |
| `scripts/export-brand.mjs` | Regenerates exports from the runtime drawing |

Within the core console, the SVG helper is used as follows:

```ts
import { brandSvg, brandDataUri } from "./brand.js";

// Accessible standalone artwork.
brandSvg({ theme: "day", treatment: "material", width: 312 });

// A heading that already supplies the accessible name can hide its SVG.
brandSvg({ treatment: "material", decorative: true });

// A self-contained material SVG for generated header CSS.
brandDataUri("night", 150);
```

These are backend console helpers. Dashboard widgets receive the shared header
automatically and should not import backend code into their browser bundles or
draw a second primary Yonder lockup inside each page. Where a separate asset is
needed, use the exported SVG through that package's existing local asset build.

## Header layout contract

The main brand lives in `.v-app-bar-title::before`, supplied by `theme.ts`.
The title container is flex-aligned with the current page title.

- Above 400 px: 150 × 31.7 px artwork, plus 25 px of divider and spacing.
- At or below 400 px: 120 × 25.36 px artwork, plus the same 25 px spacing.
- The compact rule embeds an SVG with the smaller intrinsic dimensions. Merely
  shrinking the pseudo-element leaves the original image overlapping the title.
- Page-specific controls, including the Flight controls, belong in the remaining
  app-bar space. Preserve the brand area and avoid a second Yonder/Systems masthead.
- Pass the explicit configured theme. Do not infer it from the browser's colour mode.

## Build and activation

```sh
npm run build -w yonder-core
node scripts/export-brand.mjs
```

The affected installed core files are `dist/console/brand.js`, `assets.js`,
`theme.js`, and `assets/login.html`, with their generated declarations alongside
them. Use the app's combined build and existing deployment procedure; do not copy
an older whole core tree over newer network, camera, or cockpit work.

The core renderer generates the theme stylesheet. An already running core can
retain the previous imported `themeCss` implementation after files are replaced.
Coordinate activation with the other tasks and the established camera-safe
deployment procedure so future configuration/theme changes keep the identity.
A one-time replacement of generated CSS alone is not durable integration.

The console caches its login page per process. Its new assets must become active
as part of the coordinated console update as well. No extra asset request or
external font is needed for either placement.

The original commit also carries page captures from its development baseline.
When integrating onto newer page layouts, preserve those newer layouts and
regenerate captures from the combined build rather than reviving obsolete captures.

## Verification

Check the actual unauthenticated login and authenticated app header in both
palettes. At 320 px, the login should fit and the compact header logo should leave
the page title clear. The accessibility tree should name the identity “Yonder”.
Verify that a subsequent theme/configuration change retains the logo.

Run the appropriate combined build/type checks and the console tests, including
the checks that the inline SVG and stylesheet fetch no external assets. Preserve
the app's page-capture gate for the combined layout.
