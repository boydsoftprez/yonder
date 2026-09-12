# Pinned board-image inputs

Work in progress for [issue 11](https://github.com/boydsoftprez/yonder/issues/11).
The input tools acquire and inspect upstream bases. The separate
[private bench builder](bench/README.md) assembles writable Pi/Radxa test images and an
explicit [ZERO 3W storage prototype](prototype/README.md), with temporary SSH access.
Production protected boot/state and owner recovery are implemented on this
branch and remain subject to complete image assembly and hardware qualification.
The GitHub release workflow is still being integrated; no distributable release
candidate exists yet.

The [draft release assembler](release/README.md) validates target assets and retained
inputs, refuses bench images, and verifies uploaded bytes by downloading them again.
It is one component of the planned GitHub release workflow; no successful GitHub
image-release run has been recorded yet.

## Bases

| Target | Pinned base | Hardware qualification |
|---|---|---|
| `rpi` | Raspberry Pi OS Lite Trixie ARM64, 2026-06-18 | Pi 3/4/5 candidate; pending |
| `radxa-zero3w` | Armbian 26.8.1 Trixie Minimal, vendor 6.1.115 | Pending |
| `radxa-rock5c` | Armbian 26.8.3 Trixie Minimal, vendor 6.1.115 | Pending |

Exact versioned URLs and compressed SHA-256 hashes are in `bases.lock.json`. Sources:
[Raspberry Pi download archive](https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-06-19/),
[Armbian ZERO 3](https://armbian.com/boards/radxa-zero3), and
[Armbian ROCK 5C](https://armbian.com/boards/rock-5c). Armbian's moving download aliases
were resolved during selection; builds use explicit archive filenames and hashes.

## Fetch

With Node 20 or newer:

```sh
node image/fetch-base.mjs --target rpi --cache ./vendor/image-bases
node image/fetch-base.mjs --target radxa-zero3w --cache ./vendor/image-bases
node image/fetch-base.mjs --target radxa-rock5c --cache ./vendor/image-bases
node --test image/lib/bases.test.mjs
```

The command prints the verified cache path. Existing files are hashed before reuse;
a mismatch fails without silently replacing them or refreshing the lock. Failed,
interrupted or oversized downloads are not published into the completed cache. Base
image bytes are not committed. Verification compares the compressed bytes against the
reviewed lock; it does not claim that every package installed later is pinned.

Change base versions in a separate, explicit input-refresh change with new source
checksums and inspection evidence. Preserve old inputs needed for previous builds.
Hardware qualification applies to the final image bytes, not merely the base filename.

## Inspection

`inspect-base.py` performs read-only bounded inspection of the compressed image, verifies
the pinned checksum first, and reports partition/superblock facts. It does not mount or
modify a filesystem. See `--help` for arguments. Inspection reports are evidence, not
approved partition-mutation plans. MBR and primary/backup GPT integrity are checked;
ext filesystem superblocks are reported. FAT metadata and selected boot/first-run files were separately inspected read-only;
see [the discovery record](../docs/hardware/image-storage-discovery.md). This inspector
does not itself traverse FAT or inspect file contents. Final storage-layout validation
remains required before boot or partition mutation. The downloaded Radxa bases use GPT; the live ZERO 3W's older
MBR layout must not be used as a template for them. Base signature verification is a separate check;
`fetch-base.mjs` currently enforces SHA-256 only.

Read the [installer integration evidence](../docs/hardware/image-installer-integration.md)
for the real ARM64 payload, extracted-base tests and mounted bench-image checks,
including their hardware and boot limitations.

## Production input sets and builds

The production assembler consumes one versioned input set per target. Put the
sets under `image/out/input-sets/TARGET`, or point `YONDER_INPUTS_ROOT` at a
directory with the same target subdirectories. Each `input-set.json` binds the
exact base image, target APT capture, application payload capture and frozen
ARM64 builder by hash. The normal command is:

```sh
image/capture-inputs.sh \
  --target radxa-zero3w \
  --output image/out/input-sets/radxa-zero3w
image/build.sh --target radxa-zero3w --output image/out/production-zero3w
```

Capture is the explicit, online input-refresh operation. It writes only to a
new directory and removes an incomplete top-level result on failure. A locked
build never invokes capture or falls back to the network.

The low-level `node image/build.mjs` interface accepts those four inputs
explicitly for diagnostics. Both paths refuse a dirty source tree. The retained
payload is verified and replayed into the source snapshot, so an untracked local
`vendor/` directory cannot change a production image. The builder runs the
actual image mutation with container networking disabled.

The command emits the target-specific image, checksum, package list, build
manifest and verification manifest expected by the draft-release gate. A
successful static build records `hardwareQualified: false`; only the separate
physical-board protocol can change that evidence.

Complete and retain the three target input sets, assemble all three
credential-free images, and run the manual/tag GitHub draft workflow. Never
claim source rebuildability while a captured input manifest reports an
unretained toolchain input. Follow [the approved plan](../docs/superpowers/plans/2026-09-10-board-images-and-recovery.md).
