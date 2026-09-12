# ADR-0010 — Board images, protected storage and owner recovery

Status: accepted design; implementation and physical qualification in progress.
Date: 2026-09-10. Tracking: [issue 11](https://github.com/boydsoftprez/yonder/issues/11).

## Decision

Customize pinned Trixie ARM64 base images through the shared installer: Raspberry Pi OS
Lite for Pi 3/4/5, Armbian Minimal vendor for ZERO 3W and ROCK 5C. Install complete Yonder
payloads offline. Image installation must never operate the build host's services or
hardware. Release tags build all three targets into a draft GitHub release; publication
is an explicit action using those same inspected artifacts. Pinned bases alone do not
establish reproducibility of apt or other downloaded payload inputs.

Preserve the existing AP and console-password setup. Offer a separate Linux owner account
through authenticated/re-authenticated Settings or local keyboard/monitor setup. Sudo
requires that account's password; direct root login is disabled; SSH starts off and permits
owner-enabled password and/or key authentication. The service account remains separate.

Normal operation expects power removal. Protect system and boot filesystems, bound RAM
runtime storage, and separate durable configuration/identity, bounded persistent diagnostic
logs and recordings. Ordinary journal synchronization is every 10 seconds; critical,
alert and emergency records synchronize immediately. The unsynchronized tail may be lost;
the interval is not a strict physical-write cadence or a guarantee under stalled storage.
Configuration/credential durability is independent and immediate. Remove duplicate log
copies and unnecessary polling traces. Exact partition sizes and boot hooks require evidence.

Explicit maintenance exposes the real persistent system and boot filesystems to standard
apt. Interrupted maintenance may require reflash. Provide authenticated, reauthenticated,
plain owner backup/restore for supported configuration, secrets, owner access and ZeroTier
identity. Restore must validate first and recover related state together after interruption.
No custom Node-RED flows, arbitrary packages/home files, recordings or OS files are restored.

## Requirement changes and limits

R-CFG-04 permits explicit owner recovery archives containing secrets while retaining image
and support-bundle exclusions. R-SEC-02 permits owner-enabled SSH password authentication.
R-STO-02 includes persistent bounded diagnostics. R-STO-04 becomes the default image policy.
R-CFG-15, R-SYS-10 and R-STO-07 define recovery, owner access and maintenance.

R-SYS-05 remains a separate unmet requirement; this scope does not implement A/B bootable
slots or claim interrupted-update availability. R-CFG-05 boot-file import also remains
outside this scope. Historical custom-flow and A/B proposals do not override these decisions.

The [design](../superpowers/specs/2026-09-10-board-images-and-recovery-design.md),
[plan](../superpowers/plans/2026-09-10-board-images-and-recovery.md), and
[discovery evidence](../hardware/image-storage-discovery.md) define acceptance. Existing
board boot/repair results are reused within their tested scope. A candidate image must
still prove its changed storage/boot behavior and power-loss recovery on the actual boards.
