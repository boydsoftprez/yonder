# Task 11 plan corrections report

## Scope

Corrected command semantics in `docs/superpowers/plans/2026-09-07-rockchip-video-and-ground-station.md` only:

- split `vendor/` into a second `rsync` without `--delete`;
- read camera `.run` from `GET /cameras/cam0` after POST actions;
- bracket both `pgrep` patterns as `[y]onder-pipeline`;
- exclude iowait from the busy numerator while retaining it in the total denominator;
- run `ffprobe` separately for `full.jpg` and `preview.jpg`;
- measure retune bytes and bitrate with a ten-second `ffprobe` packet-size sum;
- record the K-62 through K-66 separator handoff and the controller's responsibility for actual measurements, including the limitation of a black gadget camera.

## Verification

The Task 11 fenced shell blocks were extracted, documentation placeholders were replaced
with inert host names, and the result passed `bash -n`. `git diff --check` passed. No board
commands, SSH sessions, or full test suite were run.

The worktree had an unrelated pre-existing modification in
`packages/yonder-core/src/daemon/server.wiring.test.ts`; it was not staged or changed.
