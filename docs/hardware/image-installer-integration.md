# Image installer foundation integration

Tracking: [issue 11](https://github.com/boydsoftprez/yonder/issues/11).
Branch: `codex/image-storage-discovery`, based on `e1c4e1f`.
This record describes the installer foundation, not a release or boot qualification.

## Evidence scope

The complete application built with `npm run build`. Its standalone core dependencies
were staged with `npm ci --omit=dev --workspaces=false --os=linux --cpu=arm64 --libc=glibc`.
`installer/make-payload.sh --arch linux-arm64` successfully staged Node, ZeroTier,
MAVLink Router, MediaMTX, the Rockchip plugin/libraries and the console. This is real
ARM64 payload evidence; apt/build-container inputs still require the release-input
locking work in the plan.

Disposable Linux ARM64 container checks exercised actual package-service suppression
and actual `systemctl --root=/` enablement, including exact restoration of a synthetic
prior package policy. Regression fixtures cover interrupted policy setup, absent and
mismatched payloads, forbidden live operations and target-specific preparation.

A second experiment used files extracted from the exact pinned Pi base. The root and
FAT copies were obtained from hash-verified decompression; `debugfs rdump` and Mtools
populated a disposable container's chroot. No host directory or physical disk was
mounted. Proc and temporary device files existed only inside the container. DNS was
provided by the container for ordinary apt package installation.

**Extraction limitation:** `rdump` did not preserve special permission bits. The fixture
restored known sticky temporary-directory modes and sudo's setuid mode. It is therefore
an extracted-userland installer test, not a faithful disk-image build, filesystem
metadata audit, login test or hardware boot test. No claim about protected storage or
power-loss survival follows from this experiment.

## Raspberry Pi userland result

`installer/install.sh --image --target rpi` completed successfully with the real payload.
A second invocation also completed successfully. Postconditions, evaluated inside the
chroot so absolute symlinks resolve correctly, established:

- The installed Node executable and core/console entry points exist. The installer loaded
  the core import graph and started the pipeline's bounded dependency check successfully.
- Core, console, Avahi and ModemManager are enabled offline.
- ZeroTier, MediaMTX and MAVLink Router remain disabled for configuration-owned activation.
- The MediaMTX configuration directory exists before core activation would occur.
- The Pi did not install the staged Rockchip-only plugin.
- The temporary package-start policy and its backup were removed on success.
- After installer completion, the container process inventory contained only its idle
  supervisor; Yonder and package services were not running.

No first-boot AP, UART, camera, local account, SSH or power-cut behavior was tested here.
The new owner/recovery/protected-storage implementation and the GitHub image-release
workflow remain subsequent plan tasks.

The extracted Pi fixture's allocated sizes after installation were approximately
5.4 MiB for `/etc`, 532 MiB for `/opt/yonder`, 2.17 GiB for `/usr`, 185 MiB for
`/var/lib` and 75 MiB for boot files. These figures exclude the separate source staging
tree from the installed-application measurement and are only sizing inputs. They do
not establish a minimum card capacity or the runtime RAM budget.

## ZERO 3W userland result and integration correction

The same extraction procedure populated a second chroot from the pinned Armbian ZERO
3W root. Its real ARM64 payload passed exact-soname, recursive required-dependency and
safe core-import preflight. The initial full run caught an actual upstream difference:
`deb-systemd-helper disable` did not remove Armbian-created networkd enable links that
were absent from its package tracking state. Image service disablement now uses
`systemctl --root=/ disable`, followed by the existing actual-link postcondition. The
live installation path retains its previous package-helper behavior.

A regression reproduces the untracked link and package-helper no-op. Target fixtures
use explicit systemctl stubs so they cannot operate the test runner's units. Corrected
installer files were copied into the chroots with source/destination hash equality
checked before execution. The corrected ZERO 3W and Pi full installer commands passed. A subsequent ZERO 3W
repeat also passed, and the disposable integration container was removed.
ZERO 3W postconditions established:

- Core, console and NetworkManager are enabled offline.
- Networkd service/socket/wait-online and configuration-owned mesh/media/router units
  are disabled.
- Active netplan YAML was retired; the ZERO 3W UART overlay and display-only console
  settings are present.
- The installed Rockchip plugin has no unresolved dynamic-library dependencies.
- Temporary package policy/backup files are absent after successful completion.
- No installed service remained running in the container.

The fixture also needed standard `/dev/ptmx` and `/dev/fd` links for distro package hooks;
those belong to the test environment, not the image-installer changes. Captured package
lists identify the actual apt results but are not a release dependency lock.

## Final foundation verification

- Base acquisition/evidence checks: 5 passed; inspector corruption/bounds/provenance
  fixtures: 14 passed. All three real compressed bases were inspected successfully.
- Image installer verifier: 26 passed, including cancellation, exact and indirect
  library-link failures, missing transitive dependencies and Armbian enablement.
- Installer library verifier: 16 passed. Existing installer suite: 127 passed.
- Whole-workspace baseline: 5,149 passed before installer integration; no application
  runtime source was changed in this slice. Full application and ARM64 payload builds
  subsequently passed.
- Shellcheck, live installer dry-run, CI YAML parsing and whitespace checks passed.

The integrated review's concrete findings were corrected and verified by the lead.
No finished disk image, physical-board qualification, protected filesystem, owner
recovery interface or GitHub image-release workflow is claimed by these results.

## ROCK 5C mounted bench integration — 2026-09-10

The private bench path now runs the shared installer against an actual mounted
copy of the pinned ROCK 5C ext4 filesystem, preserving its ownership and special
permission bits. The command is `--image --target radxa-rock5c --hardware-test`.
This is the operator-approved temporary SSH and writable-storage exception in
the board-image plan; it does not satisfy final protected-storage acceptance.

Observed on the candidate build:

- The locked compressed and raw base SHA-256 checks passed before mutation.
- The image grew to 8 GiB, retaining root start sector 32768, partition GUID,
  filesystem UUID, and the exact opaque bootloader bytes before the root.
- The complete ARM64 application and hardware payload installed successfully.
- The exact ROCK 5C DTB accepted UART4_M2. Inspection confirmed the enabled UART4
  node references GPIO1_B2/B3 with mux function 10. UART2 recovery stays enabled.
- Real target `visudo`, `sudo`, and `sshd` validated the temporary account policy:
  passwordless sudo fails, the supplied password succeeds, password/key SSH is
  enabled for the bench account, and remote root is disabled.
- Build-time SSH host keys, machine identity, and Yonder/ZeroTier identities were
  removed; the first-boot unit will create board-specific machine/SSH identities.
- After unmount, all five ext4 check passes completed without errors. GPT
  validation and the bootloader-region hash comparison passed again.

Two preliminary attempts exposed missing builder `fdisk` tooling and a temporary
DNS file unreadable by APT's restricted download account. Both recipe defects
were corrected. The latter attempt also exercised cancellation with the root
mounted: the builder unmounted its filesystems, detached its copied-file loop,
and removed its own container.

The [bench procedure](../../image/bench/README.md) describes the generated-pattern
encoder test and physical gates. A completed image and its package inventory,
checksum, and build provenance are local private artifacts; none are published
by this builder. Hardware boot, AP/DHCP, console setup, UART loopback, SeekerHD
capture and H.265 encoding remain pending on the actual board. The SeekerHD's
existing cable cannot connect directly to the ROCK 5C CSI socket.

The private build subsequently completed compression and host copy with exit 0.
An independent host SHA-256 check matched
`3f6bedb20e103bf6eb6a5b4648ac6d8affa64c0ad15e993478a602f47a2afc5a`
for `yonder-rock5c-2026.9.0-bench.img.xz` (8 GiB expanded). The builder container
was removed successfully. This identifies the bench candidate tested above;
it is not a published release or a physical boot result.

## ZERO 3W private bench candidate — 2026-09-10

The same mounted-image builder now selects `radxa-zero3w` explicitly and uses
its own pinned Armbian 26.8.1 base and inspected partition/filesystem identifiers.
The real target installation, temporary SSH/sudo policy checks, unmounted ext4
check, GPT validation and opaque bootloader-region comparison passed. The
ROCK 5C hardware-test flag is not used for this target; its existing ZERO 3W
installer prepares UART2 and NetworkManager.

`yonder-zero3w-2026.9.0-bench.img.xz` has compressed SHA-256
`b13e4c3e426a879524d287143a5a32c5470e10a5911a7ecc15f7b252dfc6feaf`.
Independent full decompression and SHA-256 checking produced exactly 8 GiB with
raw SHA-256
`eb37285accb7936e8d9317c55849a82d55cf0180cdb6a38742e7d0c72d03d720`,
matching the raw image supplied to the operator-authorized SD-card flash.
Physical boot, AP operation and camera/UART qualification remain separate.
