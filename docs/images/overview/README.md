# Project overview screenshots

These images show the production UI with **synthetic or fixture data**. They do
not depict a physical flight, and contain no real board password or stream credential.
`manifest.json` identifies each source and records its hash.

`flight.png` was captured at 1440 × 1000 from the current branded Dashboard shell
using `packages/node-red-dashboard-2-yonder/cockpit/header-preview.mjs`, which
refuses aircraft writes. After `npm run build` and staging `vendor/console`, run
that harness, open its printed loopback URL, and capture the settled Flight view.
Keep the SYNTHETIC FIXTURE label visible. The remaining images come from a passing
`scripts/verify-pages.sh` run in `vendor/capture/`; the camera image is the
notebook viewport, not its long full-page capture.

Inspect replacements before committing them. Keep captions explicit about their
data source and regenerate hashes after any update. These instructional copies
are separate from the platform-specific geometry references in `docs/console/shape`.
