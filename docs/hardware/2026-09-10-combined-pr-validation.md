# Combined source integration

The PR combines the accepted Pi camera/network/cockpit baseline `a4d55d5`
with Radxa CSI and ISP work through `b4ae1b9`. Approved branding and Flight
command-result fixes are already ancestors of that Pi baseline.

The branch also restores `fd9a209` stale-heartbeat expiry and the earlier
M5a installer, endpoint validation, telemetry re-detection, and control wiring
fixes. Existing reboot startup and cellular retry fixes are retained.

Integration-specific corrections:

- Core wire tests resolve source modules before a build, including on Node 20.
- The accessory helper packaging test resolves its files from the test module,
  so running it from the repository root checks the same package.
- The browser harness supplies kernel address/route observations for its fixture
  board. Settings and Revert checks use current control names.
- R-UI-29 camera acceptance replaces the retired Live/Setup camera composition.
- The Flight mission label wraps, and camera thumbnail traffic text can shrink
  or wrap on tablet widths.

The full local suite passed 5,078 tests in 265 files after source integration.
Production-source lint, build, generated schema/default consistency, shellcheck,
installer dry run, the 16 installer-library checks, and SeekerHD profile tests
were also exercised. Browser geometry and Linux CI results are recorded in the PR.

K-04 remains open: the separate unpublished test/Vue type-check expansion was
trialled and exposed existing annotation and fixture work. It is not included
in this runtime integration. The established production-source and runtime CI
checks remain in place.

This integration did not deploy to a board or issue aircraft commands. Prior
hardware records retain their own measured scope, outstanding power-cycle or
flight checks, and camera limitations. HDR remains unimplemented.
