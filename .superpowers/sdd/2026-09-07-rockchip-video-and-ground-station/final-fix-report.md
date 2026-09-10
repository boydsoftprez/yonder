# Consolidated final-review fix wave

Base: `368da051675efa1c0c5e25b345988037baae9469`. No SSH, subagents, additional
reviewers, or pipeline backend changes. The controller owns the hardware note.

## Changes and requirement trace

- **Failed camera DELETE — R-CAM-21, R-CTL-01, R-CFG-03:** after the existing
  running/starting refusal, synchronously stop the failed/stopped supervisor
  entry before calling asynchronous apply. This cancels its retry timer. Apply
  rejection and revert retain/restore the camera configuration, while runtime
  Start intent remains stopped; neither path resurrects a removed camera.
- **Manual live bitrate — R-CTL-03, R-VID-07, R-CFG-03, R-NET-07:** construct one
  EncoderChannel beside the production supervisor and give that same object to
  PipelineRenderer and adaptation. The renderer drains prior commands;
  adaptation does not issue new decisions during applying/reverting or while
  the video render is still settling. Only the known bitrate properties may
  differ for a live retune. Codec, source size, preview shape and other launch
  changes retain the restart path. Compare targets with the shared channel's
  observed rates, including an already-matching fixed launch recipe; preserve
  an unchanged adaptive policy's observed rate on unrelated applies.
- After live acknowledgement, retain the effective launch recipe in the
  supervisor. An unrelated apply stays continuous, rollback writes the prior
  configured rate to the actual running encoder, and crash restart uses the
  latest acknowledged configured recipe. A spawn generation identifies the
  channel's cached observations; the starting-to-running settle timestamp
  cannot erase a live retune, and rapid restarts cannot share a stale identity.
- Missing, silent or mismatched host acknowledgements fall back to the existing
  respawn path. Camera Apply returns the renderer's actual `interruption` and
  `video` outcome, including host-reported timestamp breaks and failed respawn.
  A restarted outcome explicitly says the new pipeline is awaiting supervisor
  observation; it does not certify that media is flowing. Video failures
  remain separate from successful configuration/network application.
- Extended existing R-CTL-03 instead of creating or renumbering an ID. Corrected
  Task 11's stale optional-confirmation prose: bitrate, stream and preview
  remain protected by the normal confirmation window, including live retunes.
  Codec-only exemption is unchanged. Updated K-48 with the current integration
  while retaining its dated original evidence.
- **Shell lint — R-CFG-07:** narrowly document the two architecture-indirect
  SHA variables and JavaScript template interpolation suppressions; use POSIX
  `test -g` to check setgid instead of parsing `ls` permissions.
- **Pinned serial status — R-MAV-01, R-MAV-10:** included at the controller's
  request after its synthetic-ground-station run reproduced stale `/dev/ttyS2`
  status while the router forwarded from the selected pty. After a successful
  fully pinned router start, update the tracker's selected device and baud,
  clear evidence from the previous selection, and report `searching` with
  unknown vehicle/system. Selection alone asserts no detection or healthy
  link. The normal tracker still measures subsequent heartbeat arrival/rate.

## RED and focused GREEN

- `npx vitest run --root packages/yonder-core src/daemon/routes.test.ts -t 'retires a failed retry'`
  — RED: both asynchronous DELETE cases observed 2 spawns instead of 1.
- After synchronous retry cancellation:
  `npx vitest run --root packages/yonder-core src/daemon/routes.test.ts -t 'DELETE /cameras'`
  — GREEN: 11 tests, including rejected apply, real rollback and refusal.
- `npx vitest run --root packages/yonder-core src/video/manual-apply.test.ts`
  — initial RED: 9 failures covering restart instead of continuous retune,
  stale rate and missing truthful outcome/interruption reports. During fixture
  refinement the direct engine test was corrected to use the real RTSP base
  and the canonical fixed `bitrate_kbps` field as well as its stream envelope.
- `npx vitest run --root packages/yonder-core src/video/manual-apply.test.ts -t 'fixed target even'`
  — RED: observed 2700 remained instead of the requested fixed 2000 despite
  an identical launch recipe. GREEN after comparing observed fixed rates.
- Final focused manual suite — GREEN: 17 tests. Both MPP codecs, stream and
  preview rates, unchanged `since`/spawn count, explicit and timer rollback,
  failure after live render, confirm then unrelated apply, adaptive observation,
  fallback absent/silent/wrong acknowledgements, host-witnessed interruption,
  failed spawn, Stop during a request, settle identity, and crash retry recipe.
- `npx vitest run --root packages/yonder-core src/video/manual-apply.test.ts src/video/encoder.test.ts src/video/renderer.test.ts`
  — GREEN at the 15-case manual stage: 49 tests. Existing channel and plain
  runner fallback regressions remained green.
- `npx vitest run --root packages/yonder-core src/daemon/server.wiring.test.ts -t 'shares acknowledged rates'`
  — GREEN: production wiring shares host observations between the exposed
  adaptation channel and the video renderer, with one process throughout.
- `npx vitest run --root packages/yonder-core src/mav/renderer.test.ts -t 'replaces a silent'`
  — RED: stale UART, null baud and silent phase; GREEN after propagation.
- `npx vitest run --root packages/yonder-core src/mav/renderer.test.ts src/mav/link.test.ts`
  — GREEN: 89 tests.

## Final verification

- `npx vitest run --root packages/yonder-core` — **114 files, 2,766 tests
  passed**, 31.11 seconds; full suite run once after all executable changes.
  Includes real Python host tests with fake GI, not physical encoder proof.
- `npx tsc --noEmit -p packages/yonder-core/tsconfig.json` — exit 0.
- `shellcheck installer/install.sh installer/make-payload.sh installer/lib/*.sh installer/roles/*.sh scripts/*.sh`
  — exit 0, exact CI shell command; all four reviewed diagnostics cleared.
- `./installer/install.sh --dry-run` — exit 0, reached `== done`.
- `git diff --check` — clean. Only documentation/comments were adjusted after
  the full-suite run. Workspace build is the controller's check.

## Evidence limits and remaining risks

The local suite establishes daemon lifecycle, protocol, apply/rollback and
fallback behavior. The controller must stage and measure the final manual
Apply route on the board; direct encoder spikes do not replace that acceptance.
It reports H.264's existing bench library passing (including live 0.98→3.92
Mb/s without post-retune gaps), while investigating dual RTSP output stalls.
This wave makes no speculative pipeline graph or host bus changes for those
stalls. A process that is merely `starting` or `running` in the supervisor is
not proof of decoded main/preview traffic; the final hardware note must report
that separately. MPP preview size changes still restart. The existing sensor
capability/composer mismatch and failed-backoff configuration-update limitation
remain outside this bounded wave.

The selected pinned serial port is intentionally distinguished from a probed
flight controller: unknown vehicle/system and searching phase are not promoted
from configuration. Physical UART and Mission Planner acceptance remain the
controller's hardware observations.
