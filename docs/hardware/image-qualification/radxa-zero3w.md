# ZERO 3W image qualification

## Storage prototype 03 — 2026-09-11

Status: physical boot failed before normal services. The software checks below
passed but missed the initramfs tool mismatch described next. This is Task 2's required boot checkpoint, not completion of the board
images/owner-recovery plan. Requirements: R-HW-04, R-STO-01/02/03/04/05/07,
R-CFG-08; existing camera fixes retain their R-CAM traceability.

Artifact: `image/out/zero3w-storage-03/yonder-zero3w-2026.9.0-storage-prototype.img.xz`.
Compressed size: 1,246,282,916 bytes; expanded size: 8,589,934,592 bytes.

- Compressed SHA-256: `a6763fd4666f93114b7c29f258b003ef29b29b01ba889586865c7e17573ee8fc`
- Expanded SHA-256: `67df4e1c62e99ca3065d7c627f78ad0857bc206596a3089874e691114fa8a0fb`
- Source baseline: `e1c4e1f5539f3353c3d50b029c2ba9727351a252`, with the task's local changes.
  Remote main was checked and still matched that baseline. The exact selected
  source/build-input archive is retained beside the image and hash-verified.

Passed: full first-party build and version check; complete ARM64 payload refresh;
211 focused core/installer tests; 34 installer-image checks; builder argument/base
checks; shell lint and negative U-Boot wrapper fixtures. The actual assembled
image passed kernel/initrd wrapper identity, installed decoder/dashboard file
comparisons, writable-to-read-only transition, exact partition UUID routing,
configuration/machine/SSH identity persistence over mount recreation, real
unprivileged console writes and discarded RAM state, incomplete-state refusal,
four offline filesystem checks, GPT and preserved bootloader-region checks.
Independent host verification read the entire compressed stream, checked its
checksum, expanded hash/size, primary/backup GPT and four filesystem UUIDs, and
verified the retained source snapshot. Builder mounts/loops/container were cleaned.

The temporary bench account remains intentional for this private test image;
its password/key instructions are in `PRIVATE-ACCESS.txt` beside the artifact.
Never publish those access files or distribute this as a credential-free release.

A private manual copy of the working board's two Yonder configuration/secret
files was saved under `image/out/private-pre-storage-test/`. It is not the planned
transactional recovery archive and excludes owner accounts/mesh identity/media.
The running board was not modified or flashed.

## Prototype 03 physical failure and correction

The ZERO 3W did not advertise its AP after either reported power-on. Direct
read-only card inspection found no generated state machine ID, no SSH host
keys and an empty journal partition. The actual initrd read from the card
contained the lightweight initramfs `mount`, which rejected `mount --bind`
with exit status 1. The storage script needs that operation before generating
identity or mounting the persistent journal. A second power cycle does not
correct this executable mismatch.

The hook had attempted to copy full system tools over `/bin` tools, but
`copy_exec` preserves existing destinations. Prior mount simulation ran against
full container tools, so it did not exercise this boot boundary. The correction
places the full tools in a private initramfs directory and selects it explicitly.
The replacement image must execute the packaged tools in its build checks.
Prototype 03 is superseded and must not be used for further boot qualification.

The packaged-tool gate rejects the original initrd at its unsupported bind
operation. A fresh ARM64 initrd with the private tools passes real bind/tmpfs/ext4
mounts, UUID lookup, copy/mode/symlink preservation, sync, rename, and the actual
boot script's tool selection. The test mounts read-only sysfs inside its private
namespace: the installer chroot intentionally has an empty `/sys`, which cannot
supply the block-device discovery available during a board boot. The first
replacement assembly (04) stopped at this fixture limitation and produced no
accepted image. The corrected candidate must pass the gate during assembly.

## Storage prototype 05 — initramfs tool correction

Artifact: `image/out/zero3w-storage-05/yonder-zero3w-2026.9.0-storage-prototype.img.xz`. Compressed size: 1,239,949,800 bytes.
Compressed SHA-256: `0a9e680e705bff0d5b32ab2107327cbcd84758c84125fb28fa43aee788ac9ddd`.

The complete image build passed the packaged-initramfs regression, exact U-Boot
wrapper check, protected-root/persistence probes, four offline filesystem
checks, and GPT/bootloader-preservation checks. The builder exited successfully
and removed its private mounts, loops and container. The application, installer
and payload inputs were compared with prototype 03's retained source archive:
24,571 files match (excluding archive metadata). Camera/UI fixes remain included.

Independent host verification passed the entire compressed stream, expanded
8 GiB size/hash, both GPT tables, all four filesystem UUIDs and retained source
archive. Expanded SHA-256: `df35da7a57e75f477d921b65a722ba7beac9af277b7f939cf498cd148930d699`.

The operator reports that prototype 05 booted, cameras were added and worked,
and the board successfully joined the local LAN through the console. This is
operator-observed boot/camera/network evidence; live mount/service inspection,
persistence across restart and electrical power-loss testing remain pending.
The exact camera modes/codecs were not recorded in this report.

## Next physical checks

1. Flash this exact image to a test card, complete imager verification, insert
   it with board power disconnected and boot the ZERO 3W.
2. Join `yonder` (public AP password `yonder1234`), open
   `http://192.168.77.1:3000`, set the console password, and join the home network.
3. Check actual mount options/capacity with `sudo yonder-storage-prototype-status`;
   verify first-boot identity, SSH/password-required sudo, console and service health.
4. Check CSI camera discovery and the existing Pocket 2 path, memory use and
   recording storage. Extra card space is currently unused by this fixed layout.
5. First verify settings and identities across an orderly restart. Then execute
   the planned controlled power-cut protocol, with results tied to prototype 05 hashes.

Pending: physical U-Boot/initramfs execution and reachability, real workload RAM
budgets, electrical power-loss durability, guarded apt maintenance and kernel
updates, production owner projection, transactional backup/restore, input locking,
GitHub image/release workflow and other board variants. The generic initramfs
builder could not discover the root filesystem type through the image chroot's
UUID path; offline filesystem and exact boot-wrapper checks passed, but those
checks do not establish the board's early-boot repair behavior.

## Prototype 05 live inspection

After the operator initiated a ping from the ZERO 3W to the Mac, SSH became
reachable and accepted prototype 05's dedicated key. The cause of the earlier
LAN discovery failure is not established. The operator reported address
10.0.252.31; do not treat that DHCP address as permanent.

Observed: yonder-core, yonder-console and ssh active; local console HTTP 200;
wlan0 connected via yonder-wifi. Root and boot resolve to read-only mmcblk1p1;
configuration/SSH/application state use p2, journal p3, captures p4. RAM mounts
cover etc, console runtime, temporary/cache/home paths. The 2 GiB board had
about 1.39 GiB available RAM and no swap during inspection. Root used 55%, state
1%, logs 8%. Recording capacity needs privileged inspection.

One failed unit remains: dpkg-db-backup.service, exit status 4. Its detailed
journal requires privileged inspection; resolve its normal-operation policy
before final image qualification. No restart or power-cut was performed here.

### Live package-backup correction

Privileged journal inspection confirmed dpkg-db-backup failed because copying
and rotating package metadata into `/var/backups` hit the read-only system
filesystem. A persistent service drop-in now requires
`ConditionPathIsReadWrite=/var/backups`, preserving backup availability during
writable maintenance and skipping protected operation. The image installer
installs the same drop-in for subsequent builds. The existing prototype 05
artifact is unchanged; the running board has this additional correction.

Live verification: starting the job on protected storage reports successful
condition skip (`ConditionResult=no`, `Result=success`), zero failed units,
root restored read-only, and core/console/SSH still active. No reboot was
performed. Production apt-maintenance workflow remains pending.

### First observed orderly restart

The operator restarted the board. SSH reconnected at the same LAN address
using the existing known host key. Boot ID changed from
`9fc8b216-9ef0-49db-ac90-1ca958be1e17` to
`910331eb-a79e-4876-ae78-0d2315855dd8`. Core, console and SSH are active,
console HTTP 200, zero failed units, and Wi-Fi connected. Protected root/boot,
RAM paths and all three durable partitions restored correctly. Journald lists
both boots. The package-backup drop-in survived and its read-only condition
skipped the job successfully. Configuration and secrets are present; hashes
were recorded privately for the next persistence comparison. No pre-restart
configuration hashes were available, so byte-for-byte settings preservation
is not claimed for this restart. Operator login/camera-stream reconfirmation
and electrical power-loss testing remain pending.

### First operator-reported power-pull check

The operator reports recovery after removing/reconnecting power and confirms
normal operation. Live inspection found boot ID
`5728bcd0-57ef-4bbd-a4b6-8303e3e73f8b`, SSH reachable, console HTTP 200,
core/console/SSH active, zero failed units and restored protected/RAM/durable
mounts. SHA-256 comparisons against the saved orderly-restart baseline matched
configuration, secrets, machine ID and the SSH host public key exactly.
Journals retain four boots (one additional intervening boot was not individually
observed). Kernel records show completed ext4 journal recovery on state, log
and media partitions, with no matching ext4/MMC/I/O error in the bounded current
boot check. The package-backup condition still skips successfully.

This is one operator-reported power-pull result, not repeated or timed
power-loss qualification. There was no controlled concurrent configuration
save or recording write and no offline filesystem examination.
