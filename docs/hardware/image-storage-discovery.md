# Image storage discovery — 10 September 2026

Status: initial live inventory and disposable Linux prototype completed; production
storage layout and board power-loss qualification are **not** approved by these checks.
Requirements: R-STO-01/03/04/05/06, R-CFG-03/08, and proposed R-STO-07/R-SYS-10
in the [implementation plan](../superpowers/plans/2026-09-10-board-images-and-recovery.md).
Source audit baseline: `e1c4e1f5539f3353c3d50b029c2ba9727351a252` (`origin/main`).
Live boards are development installations, not pristine or hash-pinned base images.

## Recovered earlier work

The [historical evidence review](storage-history-review.md) restores prior Radxa repair,
post-repair boot, offline 8 GiB shrink, Pi reboot checks and the earlier storage design.
Those results should be reused. The first discovery pass missed these records; its live
observations reconfirmed some previously known facts. The user subsequently confirmed bounded persistent logs with a 10-second sync interval;
the spec and plan now incorporate this decision.

## Observed boards

| Observation | Raspberry Pi 4 Model B Rev 1.5 | Radxa ZERO 3W (device tree reports ZERO 3) |
|---|---|---|
| OS | Debian 13.5 Trixie, Raspberry Pi packages | Armbian 26.8.1 Trixie, Debian 13.6 |
| Kernel | `6.18.34+rpt-rpi-v8` | `6.1.115-vendor-rk35xx` |
| Usable RAM | 905 MiB | 1968 MiB |
| SD capacity | 31,267,487,744 bytes | 31,267,487,744 bytes |
| Partitions | 512 MiB FAT boot + ext4 root | One ext4 root partition; `/boot` inside it |
| Normal root mount | `rw,noatime` | `rw,relatime,errors=remount-ro,commit=120` |
| ext4 default data mode evidence | Boot log reports ordered mode | Superblock `journal_data_writeback`; boot log confirms writeback mode |
| Boot path | Firmware, `auto_initramfs=1`, `initramfs8`/`initramfs_2712` | U-Boot loads `Image` and `uInitrd` via `boot.scr` |
| Initramfs update integration | `z50-raspi-firmware` | `99-uboot` |
| Logs | journald configured volatile; rsyslog inactive | 50 MiB zram log filesystem; rsyslog and armbian-ramlog active |
| Swap | zram with `/dev/loop0` backing `/var/swap` | zram swap |
| Whole `/etc` allocated size | About 6 MiB | About 4.2 MiB |
| Core and console before/after reads | Active | Active |

All live commands were observational: mount/partition listings, selected boot settings,
service properties, package versions, directory sizes, file metadata and filtered kernel
logs. No account/configuration edits, service restarts, package installation, filesystem
repair, remounts or power cycling were performed on these boards. SSH/sudo may themselves
produce normal system audit logs. Private-key and password-file contents were not collected.

## Findings that change implementation details

1. **Pi swap is not entirely RAM-only.** The generated writeback timer runs after 180
   minutes and then daily, writing idle zram pages to the SD-backed loop device. Protected
   images must explicitly choose RAM-only swap or disable swap; retaining current defaults
   does not satisfy the intended ordinary-write policy. Memory pressure still needs a
   representative camera/telemetry workload test on the 905 MiB Pi.
2. **Armbian RAM logs are copied back to disk.** `/var/log.hdd` is backed by the root
   filesystem. The enabled ramlog service copies logs on stop/reload, and a daily cron job
   invokes its write operation. The bounded persistent-journal policy must replace these duplicate copy mechanisms,
   not only journald's storage setting.
3. **Do not inherit ZERO 3W ext4 defaults for durable owner state.** Its superblock enables
   writeback data mode and fstab requests a 120-second journal commit interval. This does
   not mean an explicit successful fsync necessarily waits 120 seconds, but it is not the
   default policy to copy into the new state partition. Specify and verify ordered data
   mode and the state transaction's file/directory fsync boundaries.
4. **Boot updates differ.** Pi firmware and both installed kernel variants use the FAT
   partition. Armbian uses U-Boot/initramfs conversion and a boot directory within root.
   Maintenance must update the actual boot files in both arrangements. ZERO 3W currently
   has custom camera/UART overlays; these development files are not generic ROCK 5C inputs.
5. **Existing card usage is not an image-sizing baseline.** The Radxa has roughly 1.44 GiB
   of camera bring-up/build/backup material under `/var/lib/yonder`; nearly all of that
   directory's current usage is development scratch. Pi captures occupy roughly 29 MiB.
   Clean-image state and media budgets must be measured separately.
6. **Both machines have apt daily timers.** Installed automatic jobs must be reconciled
   with explicit maintenance, so background package work cannot modify the protected OS.
7. A FAT recovery file exists on the Pi and its boot log reports ext4 orphan cleanup.
   These are historical recovery indicators, not proof of a current filesystem fault or
   evidence attributing a particular power loss. No live fsck or repair was attempted.

## Writer and persistence map

| State | Current paths/source | Proposed class; qualification still required |
|---|---|---|
| Desired config and secrets | `/etc/yonder/{config,secrets}.yaml`; core `config/save.ts`, `secrets/store.ts` | Durable, coordinated generation; individual durable writes already exist |
| Pending apply and owned remote state | `/var/lib/yonder/{apply,remote}.json`; `apply/journal.ts`, `remote/renderer.ts` | Durable with config/identity; retain apply confirmation and rollback |
| UART discovery hint | `/var/lib/yonder/mavlink-link.json`; `mav/hint.ts` | Reconstructible cache, not user configuration |
| Console runtime | `/var/lib/yonder/console`; `console/renderer.ts` | Split generated settings/theme and shipped flows from runtime caches/credentials |
| Node-RED metadata observed | `.config.runtime.json`, `.config.nodes.json` and backup files | Inspect vendor behavior before selecting transient/persistent policy; do not promise arbitrary-flow preservation |
| Generated media/router settings | `/etc/mediamtx/mediamtx.yml`, `/etc/mavlink-router/main.conf` | Regenerate from committed state; media config contains secrets and needs private modes |
| NetworkManager | `/etc/NetworkManager/system-connections`, `/var/lib/NetworkManager` | Yonder-owned profiles regenerate; determine which external device state/identity must persist |
| ZeroTier | `/var/lib/zerotier-one/identity.secret`, `identity.public`, `networks.d` | Persist identity and managed membership; secret observed mode 0600, service ownership `zerotier-one` |
| Local Linux access | passwd/shadow/group/gshadow, sudo/SSH policy | Store managed owner record durably; project it using standard tools without overwriting distro accounts |
| Captures | `/var/lib/yonder/captures`; `video/recorder.ts` | Separate media filesystem mounted at the existing path; filenames/directories are the registry |
| Preview stills and sockets | `/run/yonder/stills`, `/run/yonder/core.sock` | Bounded volatile RAM; already runtime paths |
| OS/package/boot state | `/usr`, `/opt`, `/var/lib/dpkg`, apt state, boot paths | Protected ordinarily; persistent and writable in explicit maintenance |
| Diagnostic logs | Dedicated journal store | Bounded persistence, 10-second sync; isolated from configuration/media capacity |
| Swap, seed/time state | distro services and `/var/lib/systemd` | Bound transient writes; retain necessary entropy/identity separately |

Core `fs/durable.ts` already uses temporary-file write, file fsync, rename and directory
fsync. That is a per-file primitive, not a transaction joining config, secrets, Linux
accounts and ZeroTier. `net/join.ts` currently writes the client secret while constructing
configuration; this reinforces the plan's coordinated-state requirement. A recording's
pipeline writer has no source-established power-loss finalization guarantee. Completed
recordings and interrupted recordings must be tested separately.

## Disposable prototype and results

Reproduce using `./scripts/spikes/image-storage/run.sh` on Docker with a Linux daemon.
The runner uses a pinned Debian container image and one disposable container with
`CAP_SYS_ADMIN` for namespace-local mounts. It attaches no host directories or host block
devices, creates no real host accounts, and removes its container on exit. Package
resolution uses current Trixie repositories; this is an experiment, not a release input lock.
Only artificial credentials are used. Container scripts are fixtures, not installer hooks.

The prototype copies a clean Debian filesystem into a writable backing directory, exposes
it through a read-only bind mount, and overlays **the entire `/etc` directory** with a
bounded 32 MiB tmpfs copy. It saves an artificial owner's credential record outside that
volatile view, then recreates the owner using standard tools. Maintenance operates on the
backing root directly. No full-root writable RAM overlay is used.

Observed passes:

- An ordinary write under `/usr` fails.
- Standard `useradd` and PAM-backed `chpasswd` work with the directory-level RAM view.
- Negative control: an individual bind mount of `/etc/shadow` makes `chpasswd` fail with
  an authentication-token manipulation error. File-by-file bind projection is rejected.
- Apt installation is refused through the protected view.
- Actual `apt-get install hello` installs `hello` 2.10-5 in the writable backing root.
- After teardown/recreation of protected mounts, the package database and executable are
  retained, the owner's saved hash is restored, and a separately created maintenance-time
  service account is preserved.
- After a **container restart**, those checks pass again and `/usr` remains protected.

The service-account check explicitly creates a fixture using `useradd`; it is not evidence
of a package maintainer script creating an account. The saved-owner fixture is not the
production durable coordinator. The experiment verifies mount/account/apt feasibility;
it does **not** verify SD/ext4 crash durability, board boot, SSH/sudo login, initramfs/kernel
upgrades, multiple-account conflict handling, or the final RAM budget.

## Candidate architecture and remaining gates

The directory-level volatile `/etc` view is a viable candidate to investigate further:
start from the installed distro's current `/etc`, then project only supported durable owner
state, preserving any service accounts installed during maintenance. Mount durable Yonder
state and separate media at their documented paths; reconstruct generated service settings.
Only the helper may publish a new owner generation. Merely copying shadow files back and
forth would not implement the required transaction/recovery contract.

Before creating a validated `image/storage-layout.json` entry:

- Inspect exact upstream image bytes and record hashes, partition/bootloader offsets and
  expansion behavior. Live installations cannot establish provenance for release bases.
- Prototype the actual initramfs/boot mount ordering on a spare-card Pi, including service
  sandbox visibility, network startup and local login. Then repeat on ZERO 3W.
- Prove kernel/initramfs upgrades and distro-created users survive maintenance without
  stale runtime `/etc` overwriting newer package configuration.
- Exercise tmpfs limits and state/media capacity boundaries under representative load;
  pick minimum card and RAM requirements from those measurements.
- Implement/inject failures at durable-state transaction boundaries, then qualify real
  power cuts. No electrical interruption test has been performed in this discovery pass.
- Flash and inspect ROCK 5C. Pi 3 and Pi 5 remain untested hardware targets.

No final partition sizes, production boot hooks, or power-cut-qualified claims
are approved by this document. The next physical experiment requires a disposable SD card
and an operator to flash/swap it; the running development cards remain intact.

## Pinned base-file inspection (2026-09-10)

The three files in `image/bases.lock.json` were downloaded and checked against their
compressed SHA-256 identities. `image/inspection/` records actual partition/superblock
reports; both Armbian detached signatures also validated against the documented primary
key. Raspberry Pi's upstream signature remains unverified. All targets remain unqualified.

Read-only partition copies were extracted while checking the complete decompressed image
hash against each report. `debugfs` read ext4 files without `-w` or a filesystem mount;
Mtools read the Pi FAT copy in a disposable container without host devices. This inspection
did not run upstream first-boot programs or modify either live board.

| Fact | Raspberry Pi | ZERO 3W | ROCK 5C |
|---|---|---|---|
| Partition table | MBR | GPT, both copies/CRCs validated | GPT, both copies/CRCs validated |
| Base release inside root | Debian 13.5 Trixie | Debian 13.6 Trixie / Armbian 26.8.1 | Debian 13.6 Trixie / Armbian 26.8.3 |
| Kernel files | 6.18.34+rpt-rpi-v8 and rpi-2712 | 6.1.115-vendor-rk35xx | 6.1.115-vendor-rk35xx |
| Boot files | Separate 512 MiB FAT32 partition, `/boot/firmware` | `/boot` in root ext4 | `/boot` in root ext4 |
| Root selection | PARTUUID in FAT `cmdline.txt` | UUID in `armbianEnv.txt` | UUID in `armbianEnv.txt` |
| Initramfs loading | `auto_initramfs=1`, `initramfs8` and `initramfs_2712` present | `boot.cmd` loads `uInitrd`, `Image` and selected DTB | Same boot-script loading path |
| Upstream root growth | `resize` boot argument; `rpi-resize.service` requests systemd root growth | `armbian-resize-filesystem.service` invokes partition/filesystem resize script | Same resize service/script |
| Root fstab defaults | `defaults,noatime` | `defaults,commit=120,errors=remount-ro` | Same Armbian defaults |

Pi FAT observations: label `bootfs`, serial `B2F0-82D2`, 512-byte sectors,
1,048,572 filesystem sectors inside a 1,048,576-sector partition. Device-tree files for
Pi 3, 4 and 5 and both kernel/initramfs variants are present; this is file evidence,
not proof that the completed Yonder image boots on every model. `config.txt` ends in
`[all]`. The base includes `userconfig.service` on tty8, cloud-init units and commented
boot configuration templates. The templates' example credentials are not evidence of
an active account. Final assembly must explicitly retire competing account/network
setup while preserving per-device identity creation. Its rpi-swap configuration still
contains the upstream automatic mechanism defaults; disk writeback needs an explicit
override, not an assumption that zram means no SD writes.

Both Armbian bases include `armbian-firstrun.service`, whose documented role includes
SSH-key regeneration, and `console=both` in the boot environment. ZERO 3W selects
`rockchip/rk3566-radxa-zero3.dtb`; ROCK 5C selects `rockchip/rk3588s-rock-5c.dtb`.
The shared overlay directory includes both RK3568 and RK3588 overlays. Presence of a
ZERO 3W overlay in ROCK 5C's filesystem does **not** establish compatible header pins.
ROCK 5C UART preparation remains pending and image installation refuses that target
before mutation until its own preparation is established.

Consequences for Task 2: preserve each target's existing bootloader region, root identity
and correct initramfs loading path; replace upstream root expansion with the validated
Yonder layout expansion; retire conflicting first-run setup without losing unique host
identity creation; replace the Armbian writeback/mount defaults explicitly. No final
layout sizes, partition-mutation authorization or physical boot qualification are
established by this file inspection. The earlier live ZERO 3W MBR observation must not
be applied to these GPT inputs.

Kernel configuration files in both Pi variants and both Radxa bases report
`CONFIG_BLK_DEV_INITRD=y`, `CONFIG_EXT4_FS=y`, `CONFIG_TMPFS=y` and
`CONFIG_OVERLAY_FS=m`. The protected-boot prototype must therefore include and load the
matching overlay module in each generated initramfs; kernel support alone does not
prove the module is present in the currently shipped initramfs.

Both Radxa roots begin at sector 32,768 (16 MiB). The disk area after the primary GPT
metadata and before that root is not empty: the first observed nonzero sector is 64
on both targets, and further nonzero data extends through sector 18,866 on ZERO 3W
and 19,229 on ROCK 5C. Treat this area as opaque board boot data, not free space.
For the exact locked inputs, SHA-256 of sectors `[34, 32768)` (512-byte sectors) is:

- ZERO 3W: `e6d47fa7c4cd09b09004cb71f579d135107c86d6bd9fad5c4d854fcf68653269`
- ROCK 5C: `cfb2cd548556513337f36639918e713c65565aaa247e6f312964b92c4019706c`

These measured preservation boundaries exclude the primary GPT header/entry array,
which requires its own validated updates if image geometry changes. Decoding every
boot component and proving the resulting image boots remain separate work.

## ZERO 3W boot prototype — 11 September 2026

The [explicit storage prototype](../../image/prototype/README.md) now implements
Task 2's directory-level RAM `/etc` approach on a copied ZERO 3W base, with
separate state, journal and media filesystems. It does not use a full-root RAM
overlay. The candidate sizes are 6 GiB/512 MiB/256 MiB/remainder within an 8 GiB
image; they remain provisional until hardware memory/capacity observations.

The assembled target's actual mount script passed a Linux namespace exercise
starting from a writable system filesystem, then refusing `/usr` and `/boot`
writes. Tests verified exact state/log/media UUID routing; machine identity,
real first-boot SSH keys and marker persisted across mount recreation; the
unprivileged `yonder` user could write the volatile console directory and those
writes disappeared on recreation. An incomplete state seed was rejected.
Probe identities were removed before compression. The U-Boot wrapper passed
CRC/type checks and matched the inspected initrd byte-for-byte; the boot script
names `Image` and `uInitrd`. Four offline filesystem checks and the original
opaque bootloader-region hash passed.

These are software/image observations. Physical U-Boot execution, AP startup,
SSH/sudo login, CSI/USB camera operation, memory pressure, apt maintenance and
electrical power cuts on this layout remain pending. The whole NetworkManager
state directory is provisionally persisted; this does not settle the final
minimal persistence set. Production generation coordination, owner projection
and recovery remain downstream tasks, rather than claims made by path mounts.
