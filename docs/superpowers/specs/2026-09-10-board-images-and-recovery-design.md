# Board images, owner access and recovery

Date: 2026-09-10. Status: approved for implementation-plan preparation following Yonder brainstorming. The user authorized plan writing; implementation has not started.

## 1. Purpose and evidence

Produce ready-to-flash Yonder images for Raspberry Pi 3/4/5, Radxa ZERO 3W and ROCK 5C. Preserve the existing application and setup experience. Treat removal of power without shutdown as ordinary operation. Keep Linux maintainable through its normal package manager and provide a straightforward way to restore an owner's configuration after reflashing.

The initial review examined `origin/main` at `f7e855f`; the latest locally available main is `e1c4e1f`, which also contains the merged camera-controls work. This task's checkout is the older `codex/yonder-brand` branch. Implement from current reviewed main in an isolated worktree, not from this task's old runtime. Preserve other tasks and uncommitted assets.

Current main already includes configuration/apply/revert, authentication, NetworkManager networking, cellular, ZeroTier, video, telemetry, Flight and camera controls. The shared installer and pinned external payload build are substantial existing assets. Image assembly, protected filesystem operation, owner-account onboarding, and the owner recovery archive are new work.

Relevant source and evidence on main:

- `installer/install.sh`, `installer/lib/common.sh`, `installer/roles/`, `installer/make-payload.sh`.
- `packages/yonder-core/src/console/settings.ts`, `src/daemon/routes.ts`, `src/fs/durable.ts`, `src/secrets/store.ts`, `src/apply/`.
- `systemd/yonder-core.service`, `systemd/yonder-console.service`.
- `docs/hardware/installing-on-a-radxa-zero-3w.md`, `rockchip-video-shipped.md`, `reboot-startup.md`, `2026-09-10-combined-pr-validation.md`.
- `docs/versioning.md`, `docs/requirements.md`, `docs/adr/0007-credential-boundary.md`.

Historical hardware and suite results remain attributed to those records. This design does not claim fresh-flash, power-cut or hardware acceptance has been performed.

## 2. Agreed product behavior

### 2.1 Image family and distribution

| Image | Initial hardware target | Base |
|---|---|---|
| Raspberry Pi | Pi 3, 4, 5 | Raspberry Pi OS Lite Trixie, ARM64 |
| ZERO 3W | Radxa ZERO 3W | Armbian Trixie Minimal, ARM64, vendor kernel |
| ROCK 5C | Radxa ROCK 5C | Armbian Trixie Minimal, ARM64, vendor kernel |

One shared builder customizes exact upstream images through the shared Yonder installer. Board definitions select the base, boot assets and necessary preparation. They do not replace runtime hardware probing. Exact board revisions must appear in acceptance reports; a successful ZERO 3W test does not qualify ROCK 5C.

Manual GitHub builds can select one target or all three. Reviewed version tags automatically produce all three images in a **draft GitHub Release**. Publication is explicit; changing repository visibility does not publish drafts. Publish the already-tested artifacts, without rebuilding them. Use existing monthly CalVer and `vYYYY.M.RELEASE` tags.

### 2.2 Existing first boot

Flash, power on, join the `yonder` AP with its published `yonder1234` passphrase, and open `http://192.168.77.1:3000`. The first page creates the Yonder administrator password. Only afterward is the normal authenticated console available. Subsequent settings are configured there.

No internet, imaging wizard, keyboard, Linux account, or boot configuration file is a prerequisite. Boot-file import remains a separate outstanding R-CFG-05 feature and is not part of this delivery. Generate device identities and secrets on the device; never include an owner or builder identity in an image.

### 2.3 Linux ownership

Offer the same owner-account provisioning through authenticated Yonder Settings and a text-based first-boot prompt on an attached monitor/keyboard. Neither path requires completing the other. The local prompt is a narrow account-creation program, not an automatic root shell; after successful provisioning it gives way to ordinary login.

The owner chooses one administrator username and an independent Linux password. Keep the existing `yonder` service account unchanged and separate. The new account has sudo, requiring its Linux password. Root stays locked for direct login. SSH starts disabled; Settings lets the owner enable SSH, register public keys, and explicitly enable password authentication. Local Linux login and sudo work with the Linux password. Linux access changes through Settings require reauthentication with the current Yonder administrator password.

Both setup paths observe one account state and serialize changes. Reserved/service usernames and incompatible preexisting accounts are rejected before mutation. An interrupted request can be retried without adding duplicate accounts or privileges. Never replace `/etc/passwd`, `/etc/shadow`, groups or sudoers wholesale from an uploaded archive. Use validated account operations and narrowly owned SSH/sudo configuration. Passwords must not appear in command arguments, logs, shell history or responses.

Provisioning and password/key changes must persist in protected mode; the storage layer must explicitly support these records rather than silently placing them in a volatile overlay. Recovery of partly completed account operations must not prevent the AP or console from starting.

## 3. Storage design

### 3.1 Normal operation

Power removal without shutdown is the expected stop operation. The default image uses a protected system and boot filesystem, with bounded RAM-backed storage for transient writes. A small persistent state filesystem stores the settings and identities that must survive; recording uses a separate writable filesystem. Separating filesystems limits filesystem/full-disk effects but does not create physical fault isolation within one SD card.

| Class | Examples | Persistence |
|---|---|---|
| System | OS packages, Yonder runtime, kernel/firmware, shipped flows | Read-only in normal operation |
| Durable owner/device state | Yonder config/secrets/apply recovery, owner account records, SSH keys/policy, mesh identity, required network state | Explicit persistent state, access controlled |
| Reconstructable runtime state | Generated service configuration where reproducible, caches, temporary files, sockets | RAM-backed, bounded |
| Diagnostic logs | System/application events and errors | Bounded persistent journal; 10-second sync interval |
| Media | Saved pictures and video | Separate writable media filesystem with existing capacity reserve |

This is a persistence contract, not permission to bind an entire mutable `/etc` or `/var` to disk without an inventory. Inspect actual writes by Node-RED, NetworkManager, ZeroTier, systemd, SSH and the pipeline host. Node-RED is owned by Yonder; retain authentication/runtime state only as required, not custom flow installations.

Settings reported saved must have completed the durable write path. Existing temp-file, file-fsync, rename and directory-fsync helpers are retained and audited at callers. Multiple related files, including configuration plus secrets and account records, need recoverable transaction semantics; several individually atomic writes are not an atomic transaction. A cut during an operation must leave the old complete generation or recover to the new complete generation, with the AP and console available afterward. Interrupted initial provisioning returns to setup or completes a valid account; it must not leave an inaccessible half-configured state.

Disable disk swap in normal operation; evaluate bounded RAM compression on the smallest supported Pi rather than assuming sufficient memory. Bound journals, caches and transient overlays. Full media must not consume state/system capacity. Honor R-STO-06; preserve completed recordings and test/document the recoverable portion of a recording interrupted by power loss. No promise that the last buffered video frames survive.

Physical SD controller failure cannot be eliminated by a filesystem policy. Product acceptance is measured software recovery on the tested cards/boards under routine power cuts, with the limits documented rather than described as corruption-proof.

Diagnostic logs persist in a bounded, separately capacity-limited journal with `SyncIntervalSec=10s`. Critical, alert and emergency records request immediate synchronization. A power cut can lose the unsynchronized ordinary-log tail (roughly 10 seconds under normal I/O); this is not a strict loss bound or a promise of one physical write every 10 seconds. Settings and credentials use their immediate durable transaction path independently. Remove duplicate syslog/RAM-log copying, suppress routine command tracing by default, and retain bounded RAM fallback if the log store is unavailable. No required persistence depends on shutdown. Log exhaustion must not consume configuration or media capacity; measure limits and actual write activity before qualification.

### 3.2 Maintenance and apt

Provide an explicit maintenance control in Settings and an equivalent administrator terminal command. Normal operation remains protected by default. Maintenance makes the actual installed system and boot filesystems writable so standard `apt update`, `apt upgrade` and package installation persist. Never let apt appear to update only a disposable overlay.

Entering maintenance is an explicit bench operation; disclose a required restart or service interruption before transition. A restart-based transition is acceptable where required by the selected root-mount implementation. The UI distinguishes protected, transition-pending, maintenance and failed states using actual mount/state observations. Exiting returns the device to protected operation; normal boot defaults back to protected mode. Do not automatically run upgrades on the writable state partition during ordinary operation.

The user accepts that losing power during package/kernel maintenance may require reflashing. No A/B update system, rollback bootloader or interruption-safe package manager is required in this effort. Offer backup access alongside maintenance. A recovery archive restores supported configuration, not arbitrary apt-installed software or every local filesystem modification; owners reinstall those packages through apt after reflashing.

## 4. Owner backup and restore

### 4.1 Contents and access

Authenticated Settings offers Download backup and Restore backup. No owner passphrase or archive encryption. Label downloads plainly: **Contains passwords and keys. Store securely.** Require administrator reauthentication for exporting secrets and restoring owner access. Prevent caching and exclude archive contents from diagnostics, logs and error messages. Temporary server-side material is private and removed after completion/failure.

The archive is a versioned, bounded data format with a manifest, source Yonder/schema versions, source board metadata and checksums for corruption detection. A checksum is not a trust signature. Treat every upload as untrusted data even when its checksums match; do not execute archive content or extract arbitrary paths, links or device entries.

Include:

- Yonder configuration and the associated secrets, including the administrator password hash and media credentials.
- Managed Linux administrator identity, password hash, authorized SSH keys and the owner's SSH authentication settings; recreate only the supported sudo entitlement.
- ZeroTier identity and membership configuration, so a replacement can take the old device's place.
- Other persistent Yonder settings explicitly identified by the state inventory.

Exclude:

- Node-RED custom flows/extensions and application/runtime files. Yonder continues to own the shipped Node-RED installation.
- Recordings, pictures, OS/kernel/boot files, arbitrary home-directory contents and apt-installed packages.
- Volatile state, logs, transient sessions, incomplete transactions and arbitrary system-account databases.
- Browser-only Flight plans/preferences unless separately exported using their existing browser path. Explain this limit in the backup UI and documentation.

Regenerate destination SSH host identity rather than copying the source host keys; retain authorized owner keys and policy. This avoids treating all machine identity as interchangeable. Warn in restore review that restored ZeroTier identity replaces the old device and should not run concurrently on both boards.

### 4.2 Restore behavior

The recovery path is reflash, complete initial Yonder setup, upload backup, review the restore summary, then restore. The initial password gates access to the upload. After successful activation, restored Yonder and Linux credentials take effect and previous web sessions are invalidated; state that before starting.

Validate archive structure, size limits, checksums, schema/version compatibility, account constraints and available storage before modifying active state. Restore supported earlier schemas through explicit migrations; reject unsupported future schemas with a clear message. Do not overwrite destination boot/driver configuration or make old service binaries part of restoration.

Stage all persistent state as one recoverable generation. Serialize against account edits, normal config applies, other restores and maintenance transitions. Take a consistent backup under the same state coordination, refusing or waiting for a pending apply rather than exporting mixed config/secrets. Track an operation through planned network/session interruption. On power loss or activation failure, boot recovery selects a complete state generation rather than a mix; retain previous state until activation succeeds. No success message before durable commit.

Reconcile network and hardware-dependent settings with the destination. Preserve compatible saved settings; explicitly report absent cameras/interfaces/UARTs and do not silently substitute a different control device. Invalid/incompatible network settings must not eliminate the destination's setup/recovery AP. Restore may restart services or reboot, with that interruption disclosed. A corrupt/unreadable persistent state filesystem must have a documented fallback to a recoverable console or reflashing; do not claim filesystem repair has been proven without physical tests.

## 5. Image assembly and installer boundaries

### 5.1 Fixed inputs

Use exact upstream base URLs and independently verified SHA-256 values, with upstream signatures where available. Record architecture, release/date, kernel branch and partition layout. Retain release dependency inputs and a full package inventory; do not rely on a transient Actions cache or floating download URL for long-term recovery.

Build the complete current application/payload for ARM64 in a Trixie-compatible userspace. Pin npm locks, external component versions/source commits, tooling/container digest and Actions commits. Resolve APT inputs through snapshots or retained verified packages. A release rebuild uses those captured inputs; normal owner maintenance still uses functional upstream apt sources. Rebuildability of the distributed release does not imply an owner-modified system remains identical to it.

The objective is traceable, locked release inputs and reproducible installed content. Byte-identical image files are not a first-delivery promise. Exact base/package pins and retention mechanisms are outputs of the input-verification task, not invented values in this spec.

### 5.2 Installer and hardware

Introduce explicit image-install behavior: install files and enable intended units offline, suppress package service startup, and do not run service restarts, udev control, host modprobe or configfs changes. Retain live-board install behavior. No host system bus, udev control socket or real device probing is used to decide target features.

The current Rockchip role skips when `/dev/mpp_service` is absent. Split its target filesystem installation from hardware validation: known Radxa image profiles install the verified libraries/plugin, and real runtime probes establish capabilities. Do not fake an MPP device in CI. Hardware failures must be reported without preventing console access.

The observed Armbian ZERO 3W image uses netplan/networkd with a generated NetworkManager deny-list. Hand interface ownership to NetworkManager in the image, verifying subsequent generated state. The current Armbian UART role assumes a ZERO 3W overlay; provide verified target-specific boot preparation for ROCK 5C and verify Pi variants. Preserve upstream firmware/bootloader placement while adding the protected/persistent/media storage layout. Explicitly replace incompatible upstream root-expansion and first-login behavior; no growth operation may overwrite added partitions.

The builder manages its own image file, loop devices and private mount namespace, validates partition assumptions before modification, checks space, and cleans up on failure/cancellation. No successful artifact name/manifest is emitted for partial output. A base or payload checksum mismatch fails before executing its contents.

## 6. GitHub and release behavior

Use native Linux ARM64 VM runners, separate from any existing generic `CI_RUNNER` choice. Verify current availability and resource usage before extending the prototype to the full matrix. Reuse a common application payload where compatible; each image job gets isolated writable staging. Prefer bounded caching and short-lived test artifacts; retained release inputs have a deliberate archival home.

Keep application CI requirements intact. Add inexpensive image/manifest/installer validation for PRs; run privileged full builds on trusted refs/on demand and release tags. Give publishing permissions only to the release job. Do not run untrusted fork code with publishing credentials or on a privileged persistent runner.

Tag runs build all three targets, check the CalVer contract, and attach compressed `.img.xz` files, SHA-256 checksums, package/build manifests and evidence status to a draft. Build failures cannot produce a complete-success draft; reruns must not silently replace artifacts already used for hardware acceptance. The user publishes only after reviewing the evidence. No automation changes repository visibility or publishes a draft on its own.

## 7. Requirements and explicit amendments

Preserve stable existing IDs. The implementation must amend requirements and relevant ADR/documentation to reflect user-approved changes, rather than pretending current wording already permits them:

| Requirement | Design consequence |
|---|---|
| R-HW-04 | One Pi family image, separate boot-compatible Radxa targets, runtime capability detection |
| R-CFG-02/03/09/13/14 | Validation, rollback, schema compatibility, consistent generated state and resilient startup apply to recovery |
| R-CFG-04 | Amend the current ban on secrets in backups: permit an explicit authenticated owner recovery backup; retain exclusion from images and support bundles |
| R-CFG-05 | Remains outstanding and outside this scope; no boot-file import prerequisite |
| R-CFG-07/08 | Offline, no-wizard AP/password-setup first boot |
| R-SEC-01/07/09 | No shared privileged password or image credentials; preserve setup gate |
| R-SEC-02 | Amend key-only administration to permit owner-enabled SSH password auth; keep direct remote root disabled |
| R-SEC-04/10/11/12 | Authorize new privileged operations, protect secrets, fail closed, preserve networking when console work fails |
| R-STO-01/02/03/05/06 | RAM for transient state, bounded writes/media, durable settings and measured power-loss recovery |
| R-STO-04 | Promote protected root from optional later work to the default image design, with explicit apt maintenance |
| R-UI-12/16/19 | Preserve required browser/legibility coverage and actual shipped-console composition |

Add unused requirement IDs for owner Linux provisioning, protected/maintenance transitions and the exact recovery archive contract during plan preparation/implementation; check current main before allocating numbers. Do not reinterpret a generic backup requirement as already implemented.

## 8. Verification and discovery gates

### Software and integration

Before modifying consequential state transitions, establish regression/invariant coverage for concurrent onboarding, rejected account names/keys, auth expiry, incorrect passwords, forbidden archive entries, unsupported schemas, disk-full/fsync failures, restore rollback, and cuts between persistent transaction stages. Test that rejected operations leave state unchanged and retries are safe.

Use mounted disposable filesystems and a real ARM64 image chroot to validate installation, service enablement, permissions, executable/module loading, cleanup, and persistence layout. Validate actual `/etc` account/SSH behavior in an isolated Linux environment, never by mutating the developer's account database.

Check Settings success/failure paths in the real daemon/Node-RED/browser harness: create account, SSH policy changes, backup download, restore review and credential/session changes, maintenance status. Review both palettes and relevant responsive layouts. Follow yonder-page-verification; focused iteration does not replace the existing required final gate and no automatic geometry acceptance is allowed.

### Physical acceptance

For Pi 3/4/5, ZERO 3W and ROCK 5C, record exact model/revision, card, base and artifact hashes. Test unconfigured offline cold boot/AP/DHCP/password setup, local account setup, persistent sudo/SSH access, bad Wi-Fi recovery, reboot, and applicable video/telemetry paths. Existing Pi 4 or ZERO 3W bench evidence is not fresh-image proof for the other boards.

Exercise controlled power cuts during boot, idle, a settings save, password/account provisioning, restore activation, and video recording. Repeat across transaction windows, then verify the complete prior/new state, authentication, AP recovery, completed media and boot health. A physical test plan must state repetitions and observed failures; unit tests alone cannot qualify an SD-card controller. Treat card-space exhaustion and full persistent/RAM storage as separate failure cases.

In maintenance, demonstrate a real apt package install/update survives returning to protected mode. Confirm normal boot restores protection. An interrupted upgrade may require reflash, as accepted; demonstrate the supported recovery archive restores onto the reflash.

### Bounded discoveries before dependent implementation

1. Inspect each exact base's partition layout, boot/root expansion, initramfs support and write paths. Prototype protected root plus durable state/media on Pi first. Proceed only if normal boot and persistent account/config writes work and apt changes survive maintenance; otherwise revise the mount design before rolling it out.
2. Observe default radio regulatory behavior on each board. Establish AP startup without embedding a developer-specific country or requiring a setup wizard; if that cannot be achieved with the selected base/radio, bring the concrete constraint back to the user rather than inventing country settings.
3. Verify ROCK 5C UART/boot assets and real encoder interfaces independently of ZERO 3W.
4. Establish snapshot/retention coverage for every package source and measure runner disk/RAM usage. A manifest alone does not make unavailable inputs rebuildable.

## 9. Delivery boundaries and exclusions

This is one coordinated design with four independently reviewable implementation workstreams: image-safe installer/assembly; storage/persistence/maintenance; owner access/recovery; GitHub release integration and hardware qualification. Storage transaction interfaces must be settled before account/restore implementations depend on them. Account provisioning and backup restoration share a state coordinator, not separate competing mutation paths.

The proper Yonder plan will give each workstream concrete files, consumed/produced interfaces, dependency order, requirement IDs and acceptance commands. It must not reduce the work to an image YAML file and leave persistence/account/recovery behavior implicit.

Out of scope: custom Node-RED flows/extensions and marketplace work, boot-config import, desktop GUI, new camera drivers, HDR, Tailscale, arbitrary home-directory/full-disk backup, arbitrary package restoration, A/B OS updates and guarantees against physical flash-controller failure. Preserve current supported camera functionality and account for any existing board preparation needed to reproduce it.

## 10. Reference guidance

- [Raspberry Pi OS images](https://www.raspberrypi.com/software/operating-systems/).
- [Armbian ZERO 3](https://armbian.com/boards/radxa-zero3) and [ROCK 5C](https://armbian.com/boards/rock-5c).
- [GitHub hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- [Raspberry Pi filesystem resilience guidance](https://pip-assets.raspberrypi.com/categories/685-whitepapers-app-notes/documents/RP-003610-WP/Making-a-more-resilient-file-system).
- [Linux ext4 documentation](https://cdn.kernel.org/doc/html/latest/admin-guide/ext4.html).

The upstream references inform the candidate approach. Exact downloaded images, mount behavior and power-cut results must be measured during the defined discoveries.
