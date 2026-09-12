# Frozen target APT inputs

These scripts capture the exact target package delta for a locked base, then
prove that a fresh copy of the same base can install it without network access.
They also provide the target-chroot adapter used to keep production installer
APT calls on that validated local input.

`capture-apt.sh` is deliberately online and accepts only a base whose compressed
and raw SHA-256 values match `image/bases.lock.json` and the checked-in inspection
record. It requires the component root from the freshly captured application
payload and reads ZeroTier only from its `zerotier/` child; it has no implicit
repository-vendor fallback. For the release input-set layout, pass
`TARGET/payload/files/payload`. It derives its requested package list from
`image/package-sets.sh`, asks
APT for the complete builder-and-installer binary dependency closure, and creates:

- `capture.json`, binding the capture to the target and exact base hashes;
- `requested-packages.txt`, the canonical install request;
- `install-packages.txt`, direct builder requests plus only the role packages
  absent from that exact base, matching `ensure_pkgs` rather than upgrading an
  already-installed base kernel or header package;
- `packages.tsv`, with each binary package's file, name, version, architecture,
  source name/version, SHA-256, and byte count;
- `repo/`, a local APT repository containing every required `.deb`;
- `sources/`, exact source-package downloads for repository binaries;
- `source-packages.tsv`, binding every requested source name and version to
  its retained `.dsc` file, SHA-256, and size;
- `notices/`, one copyright file for every captured binary package (including
  material resolved from Debian's documented shared-notice symlinks); and
- `SHA256SUMS`, covering every retained regular file.

Repository indexes and package resolution run in a disposable copy of the
verified base root. That copy is extended to the 6 GiB assembly root size before
APT runs, which provides room for bases that enable more than one architecture;
the locked compressed base and its GPT remain read-only.

The vendored ZeroTier `.deb` is included in the binary repository and its
copyright file is extracted. Its upstream source archive belongs to the common
application-payload capture and is explicitly named as outside this APT input in
`capture.json`; this directory must not be represented as the complete release
input set until that archive is bound by the higher-level input manifest.
The package set also assumes the qualifying payload contains the pinned Node
distribution (including npm), as current image assembly does; the installer's
online `nodejs`/`npm` fallback is therefore outside this image-capture path.

Run a capture into a new directory:

```sh
image/inputs/capture-apt.sh \
  --target radxa-zero3w \
  --base vendor/image-bases/e78de9cb4b2d8ff1710c65c509d08faef1ba88c07fc3276b9dd637597e8234e8-Armbian_26.8.1_Radxa-zero3_trixie_vendor_6.1.115_minimal.img.xz \
  --payload image/out/inputs/radxa-zero3w/payload/files/payload \
  --output image/out/zero3w-apt-input
```

Replay verifies the complete file inventory, all hashes, every `.deb`'s
metadata, every exact source `.dsc`, and every archive named by each `.dsc`
before any install. It also verifies the locked base, copies it, and starts a
container with `--network none`. It binds the capture read-only at
`/run/yonder-apt` and invokes `install-captured-apt.sh`, which points a temporary
`APT_CONFIG` only at the captured file repository, primes APT's archive cache,
and uses `--no-download`.
Its disposable offset-loop filesystem is grown to the same 6 GiB used by image
assembly before packages are installed; the locked base itself is read-only and
its GPT is not rewritten for this proof. The base's normal APT source files are
compared before and after and left intact.

```sh
image/inputs/replay-apt.sh \
  --target radxa-zero3w \
  --base vendor/image-bases/e78de9cb4b2d8ff1710c65c509d08faef1ba88c07fc3276b9dd637597e8234e8-Armbian_26.8.1_Radxa-zero3_trixie_vendor_6.1.115_minimal.img.xz \
  --input image/out/zero3w-apt-input \
  --output image/out/zero3w-apt-replay
```

For production assembly, the outer builder supplies one accepted,
target-specific capture as a separate read-only mount at `/work/apt-input`.
After mounting the target root and extracting this source tree, the backend
binds that directory read-only at `/target/run/yonder-apt` and runs the existing
installer through:

```sh
chroot /target /opt/yonder-src/image/inputs/install-captured-apt.sh \
  --input /run/yonder-apt \
  --target radxa-zero3w \
  -- /bin/sh /opt/yonder-src/installer/install.sh --image --target radxa-zero3w
```

The adapter rejects a capture that is not a separate root-owned read-only
mount, verifies the complete inventory and its target/base/package-set binding,
installs the exact captured delta, and exports its local-only `APT_CONFIG` and
`YONDER_FROZEN_BUILD=1` to the child installer. Its transient APT state is under
`/run`; it hashes `/etc/apt` before and after and leaves the configured owner
sources intact. Production backends must skip their builder and target online
APT blocks and must not invoke APT outside this adapter. Builder tools come from
the separately frozen builder OCI input.

`apt-test.sh` with no arguments checks the canonical sets and explicit payload
CLI. Supplying `--target`, `--base`, `--payload`, and `--work` runs both capture
and replay, including missing and malformed payload refusals. The capture runtime itself
still installs its tools online from the pinned Debian OCI image; retaining that
tool image is a separate higher-level builder-input task. This delta also does
not retain corresponding sources for binaries already installed in the locked
Armbian or Raspberry Pi base. A complete release-input manifest must bind the
base image's own source/provenance archive, the tool-container snapshot and its
sources, and the application payload sources in addition to this directory.

## Application payload inputs

Production payload capture is an explicit full-target mode of
`installer/make-payload.sh`. Both output paths must be new, and `--only` is
refused so files left by an earlier partial payload cannot enter the result:

```sh
installer/make-payload.sh \
  --arch linux-arm64 \
  --target radxa-rock5c \
  --out image/out/rock5c-payload \
  --capture-inputs image/out/rock5c-payload-input
```

The retained directory contains the exact verified download archives and
indexes, pinned Git source trees, repository patches, SeekerHD IQ inputs when
selected, isolated npm caches and their package manifests, discoverable license
and notice files, and the produced target payload. It also contains a Git
archive of the exact clean first-party source at
`files/inputs/sources/application/source.tar`. Existing ignored `dist/`,
`resources/`, and `node_modules/` directories in the checkout are never
copied. Capture primes the retained npm cache, extracts the Git archive again,
and builds the application a second time in the digest-pinned ARM64 container
with networking disabled. Only that offline build is copied to
`files/payload/application`.

`payload-input.json` records every input identity and origin, every npm
package version and available notice, the selected target components,
unretained toolchain image digests, the first-party source commit and archive
hash, and a full file/directory/symlink inventory. Its
`applicationBundle.offlineBuild` object records the network-disabled
source/cache proof. `SHA256SUMS` covers the manifest and every retained
regular file.

Replay validates the checksum coverage and structural inventory before creating
an output directory:

```sh
python3 -I image/inputs/payload-inventory.py replay \
  --input image/out/rock5c-payload-input \
  --output image/out/rock5c-payload-replayed
```

`payloadReplay.status` is `complete`: the retained produced files can be copied
back exactly without a network. The replayed first-party files are under
`application/packages`. Image assembly must verify that
`application-bundle.json.sourceCommit` is the selected release source commit,
then merge `application/packages/` into the extracted source tree's
`packages/` before appending the other replayed components under `vendor/`.
It must never reuse `dist/` or `node_modules/` from its checkout.

`sourceRebuild.status` remains deliberately `incomplete` for the complete
payload. The manifest identifies three limitations: Node and MediaMTX source
trees are not retained because their verified release binaries are replayed;
the pinned OCI toolchain image bytes are not retained; and neither are the
packages those containers fetch with APT. The ZeroTier and first-party source
archives are retained. The first-party source archive and npm inputs were
successfully rebuilt without networking during capture, but replaying that
source build still requires the separately bound OCI image and retained payload
Node runtime. OCI image digests are recorded, but recording a digest is not
retaining the image or its package sources. Release input orchestration must
bind the separate captures before claiming that a release can be recompiled
entirely offline.
