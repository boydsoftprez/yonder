# Raspberry Pi MBR storage prototype

This directory implements the private image prototype for the accepted topology in
[`docs/hardware/pi-storage-layout-investigation.md`](../../../docs/hardware/pi-storage-layout-investigation.md).
The Pi backend invokes it only in `storage-prototype` mode. The result remains a
temporary bench image and is not release-qualified.

`assemble-layout.sh IMAGE EXPECTED_RAW_SHA256` accepts only a regular copied
image with the locked Raspberry Pi base length, DOS identifier, partition
geometry and FAT/ext4 UUIDs. It verifies the caller's raw SHA-256 before
mutation, grows root to a fixed 6 GiB, adds a fixed 512 MiB state filesystem,
and creates an extended partition containing a fixed 256 MiB journal and final
media filesystem. The output is an 8 GiB sparse image using this topology:

| Number | Role | Start | Initial sectors |
|---|---|---:|---:|
| 1 | primary FAT boot | 16,384 | 1,048,576 |
| 2 | primary ext4 root | 1,064,960 | 12,582,912 |
| 3 | primary ext4 state | 13,647,872 | 1,048,576 |
| 4 | extended container | 14,696,448 | 2,080,768 |
| 5 | logical ext4 journal | 14,698,496 | 524,288 |
| 6 | logical ext4 media | 15,224,832 | 1,552,384 |

`mbr-layout.c` is a small statically linked helper. Assembly changes only the
root count and new partition entries in sector 0, then writes two new EBRs past
the locked base boundary. Growth accepts only a block device and changes only
the extended-container count, the second-EBR link count and the final media
count. It flushes and reads back every four-byte field before proceeding to the next one.

`grow-media.sh MOUNTED_ROOT` derives the parent disk from the supplied mounted
root partition. It has no block-device argument. Before invoking the helper it
requires root to be partition 2 and proves the complete partition geometry,
DOS PARTUUIDs, filesystem UUIDs/types, absence of duplicate UUIDs and that media
is not mounted. It updates the kernel view, grows only media ext4, flushes it and
verifies the UUID and final size.

`install.sh` seeds the mounted state filesystem, makes both `/` and
`/boot/firmware` read-only in fstab, installs the Pi-only initramfs hook and
builds the bounded MBR helper statically. It regenerates both exact installed
kernel variants. Raspberry Pi OS's `raspi-firmware` hook copies the newest v8
archive to `initramfs8` and the newest 2712 archive to `initramfs_2712`; the
builder requires each FAT file to be byte-identical to its `/boot/initrd.img-*`
source and keeps `auto_initramfs=1`.

At init-bottom, `mount-storage.sh` derives the disk from mounted root partition
2, requires the exact p1-p6 topology, mounts FAT partition 1 read-only, and
remounts root read-only. State on p3 supplies durable Yonder, SSH, network and
systemd paths beneath a 32 MiB RAM copy of `/etc`. Journal p5 and media p6 stay
separate. A missing or incomplete state seed stops boot. Journal failure falls
back to bounded RAM; media or growth failure exposes a read-only empty capture
directory while core configuration remains available.

Run the integration proof from the repository root:

```sh
image/pi/storage-prototype/grow-media-test.sh
```

The test uses a pinned ARM64 Debian container and no host block device. It
creates an exact-geometry sparse base with real FAT/ext4 filesystems, verifies
hash and identity preservation, stops after each of the three flushed count
writes, resumes from every prefix, checks an exact second-run no-op, and rejects
a wrong DOS identifier and a duplicate media UUID without table mutation. The
test also executes the real mount script and checks read-only FAT/root plus
separate state/log/media mounts. The test helper alone includes the interruption
environment variable; the normal static helper does not compile that path.

During a full `storage-prototype` build, `verify-initramfs-tools.sh` extracts and
executes both generated archives against its own exact six-partition loop
fixture. `verify-mounts.sh` recreates two boots on the actual assembled image,
checks persistence and volatility, forces journal/media identity failures, and
checks incomplete-state refusal. Its cleanup identifies loops by the private
`/work/disk.img` file and recreates dynamic partition nodes from sysfs, including
block major 259.

The MBR and both EBRs are single-copy metadata. A torn sector can require
reflashing even though completed write stages are retryable. Software fault
injection cannot remove that format limit. Maintenance, owner recovery, backup,
and real Pi 3/4/5 boot/power-cut qualification remain separate gates.
