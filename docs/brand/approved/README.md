# Yonder identity

The primary identity combines the geometric airframe, the split Y, blue anodized
wing surfaces, and satin graphite lettering. The material treatment is used on
both the login and the console header. The night version lifts the ink and blue
for the carbon panel.

## Assets

| File | Use |
| --- | --- |
| `yonder.svg` | Primary material finish, light background |
| `yonder-night.svg` | Material finish, dark background |
| `yonder-mark.svg` | Standalone material airframe |
| `yonder-mark-night.svg` | Standalone airframe for dark backgrounds |
| `yonder-solid.svg` | Flat-colour alternate, light background |
| `yonder-solid-night.svg` | Flat-colour alternate, dark background |
| `yonder-outline.svg` | Secondary linework treatment |

All artwork is SVG: path lettering, vector gradients, and a restrained generated
shadow. No fonts, raster images, or external resources are required.

The master geometry lives in
[`brand.ts`](../../../packages/yonder-core/src/console/brand.ts). After editing it,
regenerate the exports from the repository root:

```sh
npm run build -w yonder-core
node scripts/export-brand.mjs
```

The same module supplies the SVG embedded in the login response and the SVG data
URI carried in the generated header stylesheet. Keep changes in that module;
the exports are generated artifacts.

## Placement

- Login: up to 312 px wide, shrinking with the card on narrow screens.
- Header: 150 px wide, with a 120 px version on screens up to 400 px wide.
- Emblem: use the standalone mark when there is insufficient space for the wordmark.
- Keep at least half the lettering's capital height clear around the full lockup.
- Keep the airframe and wordmark proportions intact. Use the appropriate background
  variant, and keep material effects restrained enough for the operating interface.
- The linework treatment is a secondary large-format graphic; use filled artwork
  at small sizes.

`preview.html` shows the SVGs and placements. `login.html` is generated from the
served login page with its controls disabled for design review.

This implements R-UI-01, R-UI-08, and R-UI-13 within the visual language in
[ADR-0009](../../adr/0009-console-visual-language.md). The approved image-generated
colour/material study remains in `../airframe-colour/` as the visual reference.
