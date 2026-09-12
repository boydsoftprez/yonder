# Raspberry Pi private image backend

This directory is supporting work for the image pipeline. It assembles a
writable or storage-prototype Raspberry Pi test image so the complete Pi
installer path can run in native ARM64 Linux CI. Neither mode is a final release
image; both retain the temporary bench account and hardware qualification is
pending.

`build-inside.sh private-test|storage-prototype` runs inside the same privileged, disposable
ARM64 Linux builder used by the existing bench images. It consumes:

- `/work/base.img.xz`, `/work/expected-sha` and `/work/target.json`;
- `/work/source.tar`, containing the complete application and Pi payload but no
  Rockchip or SeekerHD payload;
- root-only `/work/input/password` and `/work/input/authorized_key` files; and
- an existing `/work/result` directory.

It writes `/work/result/image.img.xz`, `image.sha256`, `packages.tsv` and
`verification.txt`. The compressed image expands to 8 GiB. Partition 1 and its
FAT filesystem stay in place; partition 2 grows to the end and its ext4
filesystem is resized offline. `cleanup.sh` is the cancellation path and
refuses to detach any loop that is not backed by `/work/disk.img`.

`private-test` keeps the two-partition writable layout. `storage-prototype`
uses the six-partition MBR/EBR layout documented in
[`storage-prototype/README.md`](storage-prototype/README.md), protects both root
and FAT firmware filesystems during ordinary boot, and runs the generated v8
and 2712 initramfs plus real mount lifecycle gates before compression.

The outer builder must validate the locked base and provide these target facts:

| Field | Locked Raspberry Pi base |
|---|---:|
| `rawSha256` | `e235fd24fc5f039c08daba7d3abc04aecc7313f979d16d2a3fdad29dd44c33a9` |
| `uncompressedBytes` | `2977955840` |
| `partitionTable` | `mbr` |
| `mbrDiskId` | `0x041bba91` |
| `bootStartSector` | `16384` |
| `bootSectorCount` | `1048576` |
| `bootType` | `0x0c` |
| `bootFilesystemUuid` | `B2F0-82D2` |
| `bootFilesystemLabel` | `bootfs` |
| `rootStartSector` | `1064960` |
| `rootSectorCount` | `4751360` |
| `rootType` | `0x83` |
| `rootFilesystemUuid` | `15f4c6be-1102-4331-9904-f78e78afd1fd` |

The backend mounts the real FAT boot filesystem at `/boot/firmware`, runs
`installer/install.sh --image --target rpi`, and checks that one image retains
the Pi 3, Pi 4 and Pi 5 firmware, kernels and device trees. Private-test mode
then creates the temporary `yonder-bench` account, disables the upstream
cloud-init/user wizard/root-grow/SSH-switch paths, removes builder identities,
and leaves Yonder at its normal access-point and administrator-password setup
gate.

Run `image/pi/test.sh` on a Linux Docker host. Its ARM64 fixture grows an actual
DOS image containing FAT and ext4 filesystems, remounts both and checks their
data and identifiers. A second fixture executes the rootfs preparation against
real account, sudo, SSH and systemd tools. The full builder invocation against
the exact pinned Raspberry Pi OS archive remains the integration gate.

Owner creation/recovery, maintenance mode, backup, power-cut qualification and
physical Pi 3/4/5 boots remain required before this backend can contribute a
final release image. Temporary credentials are explicitly private test
behavior and are not a release contract.
