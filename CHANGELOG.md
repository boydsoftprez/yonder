# Changes

## 2026.9.0 — in development

The first monthly CalVer version brings the development branches into one
pre-alpha application. This entry describes source changes; it is not a published
SD image or a claim of physical flight acceptance.

- Flight PFD/MFD, configurable instruments, missions, terrain/map/traffic views,
  controller-home workflows and reviewed aircraft commands.
- Unified camera workspace, Pocket 2 native controls and guarded gimbal presets,
  recovery improvements, Adaptive RTSP delivery feedback and independent preview codecs.
- Radxa Zero 3W SeekerHD CSI/ISP bring-up and hardware encoding, with documented
  kernel, thermal and HDR limits.
- Current network addresses and paths, ZeroTier measurements, streamed diagnostics,
  bounded public speed tests, console password changes and guarded reboot.
- Owner-created Linux and SSH access, authenticated recovery backup/restore,
  protected system storage with separate state, journal and recording filesystems,
  and explicit writable package-maintenance boots.
- Pinned Raspberry Pi 3/4/5, Radxa ZERO 3W and ROCK 5C image assembly with
  retained inputs, credential-free finalization and draft-only GitHub release gates;
  final image hardware qualification remains separate.
- Approved Yonder branding, an operator-facing README, a complete base-OS installation
  guide, tested-hardware records and a project-wide user guide.
- Shared `YYYY.M.RELEASE` versions, exact first-party dependency versions and a CI
  consistency check; configuration schema version remains `1`.
- Recovered telemetry/installer fixes, updated browser fixtures and reviewed
  macOS/Linux layout references.
- Reconcile PR #7: recover two-camera/gimbal browser coverage, shared viewer
  validation and missing video requirements; repair Stills status delivery
  and narrow camera controls.

Before installing, read [Getting started](docs/getting-started.md),
[versioning and upgrades](docs/versioning.md), and [known issues](docs/known-issues.md).
The change from 0.1.0 to CalVer does not establish semantic-version compatibility.
