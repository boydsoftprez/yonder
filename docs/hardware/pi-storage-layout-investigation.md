# Raspberry Pi protected-storage layout investigation

Status: design recommendation only; no production layout is approved or implemented.
Date: 11 September 2026.
Scope: one Raspberry Pi OS image for Pi 3, 4 and 5, starting from the exact
pinned image recorded in [`image/inspection/rpi.json`](../../image/inspection/rpi.json).
Physical boot and power-loss qualification on all three models remain required.

## Required boundary

The storage contract requires separate protected boot and system filesystems,
durable owner/configuration state, bounded persistent diagnostics, and recording
capacity which cannot consume the state or log capacity. Ordinary runtime writes
stay in bounded RAM. The log store keeps the existing 10-second journal sync
policy and its permitted unsynchronised tail. These are independent filesystems,
not only directory quotas, so failure or exhaustion of recording storage cannot
consume state or journal blocks. See [R-STO-01 through R-STO-07](../requirements.md#r-sto--storage-and-resilience)
and [ADR-0010](../adr/0010-image-storage-and-owner-recovery.md).

The pinned Raspberry Pi input is a DOS/MBR disk with identifier `0x041bba91`:

| Partition | Start sector | Sector count | Type | Filesystem |
|---|---:|---:|---:|---|
| 1 | 16,384 | 1,048,576 | `0x0c` | FAT32 `bootfs`, UUID `B2F0-82D2` |
| 2 | 1,064,960 | 4,751,360 | `0x83` | ext4 `rootfs`, UUID `15f4c6be-1102-4331-9904-f78e78afd1fd` |

Raspberry Pi documents that Raspberry Pi OS puts boot files on the first,
FAT-formatted partition and mounts it at `/boot/firmware`; Pi 4 and Pi 5 load
their first stage from EEPROM while earlier models use `bootcode.bin` from the
boot filesystem. [Raspberry Pi boot-folder documentation](https://www.raspberrypi.com/documentation/computers/configuration.html#boot-folder-contents)
The locked FAT contains the Pi 3, Pi 4 and Pi 5 device trees and both kernel
families, but file presence is not boot qualification.

## Firmware constraint

Keep MBR and keep the boot filesystem as primary partition 1. A Raspberry Pi
documentation issue reports that a Pi 3B would not boot a pure GPT disk and
required an MBR or hybrid MBR with the FAT entry first. That report is evidence
for a conservative compatibility boundary, not a normative firmware guarantee.
[Raspberry Pi documentation issue 1291](https://github.com/raspberrypi/documentation/issues/1291)

GPT is supported in some newer boot paths, but the tracker contains concrete
compatibility failures: Pi 4 partition selection behaved differently with GPT,
and a Pi 5 bootloader failed when valid GPT entries were relocated away from
LBA 2. [firmware issue 1733](https://github.com/raspberrypi/firmware/issues/1733),
[rpi-eeprom issue 585](https://github.com/raspberrypi/rpi-eeprom/issues/585)
Another Pi 4/5 report shows an ESP that the bootloader identified but could not
read as FAT. [rpi-eeprom issue 558](https://github.com/raspberrypi/rpi-eeprom/issues/558)
The defects and fixes vary with EEPROM/firmware version, while a Pi 3 has no Pi
4/5 EEPROM update path. Converting the shared image to GPT therefore expands the
firmware matrix before it provides a storage benefit.

Hybrid GPT is worse for this use. It would retain a Pi 3-visible FAT entry but
make MBR and GPT describe overlapping storage. Every assembly and growth update
would have to keep two partition tables consistent across interruption. A valid
GPT copy paired with a stale hybrid MBR could make the firmware and Linux select
different geometry. Do not use hybrid GPT for the shared image.

Linux directly supports DOS extended partitions. Its parser recognises the
extended partition types, follows the EBR linked list, creates devices for the
logical data partitions, and assigns DOS PARTUUIDs from the disk signature and
partition number. [Linux DOS partition parser](https://github.com/torvalds/linux/blob/master/block/partitions/msdos.c),
[Linux early PARTUUID lookup](https://github.com/torvalds/linux/blob/master/block/early-lookup.c)
The Raspberry Pi firmware never needs to traverse that list: it continues to
read primary FAT partition 1, and the kernel/initramfs finds the other
filesystems after it has started.

## Recommended topology

Use the two existing primary partitions, one new primary state partition, and
one extended container holding logical log and media partitions:

| Linux number | MBR role | Filesystem role | Size policy |
|---|---|---|---|
| 1 | primary `0x0c` | FAT boot | preserve exact start, size, type, label and UUID; mount read-only normally |
| 2 | primary `0x83` | ext4 system/root | preserve start and UUID; enlarge offline to a measured fixed size; mount read-only normally |
| 3 | primary `0x83` | ext4 durable state | fixed capacity; ordered data and explicit file/directory fsync transactions |
| 4 | extended `0x0f` | container only | begins after state and ends at current medium size |
| 5 | logical `0x83` | ext4 journal | fixed capacity; journal capped below filesystem capacity with reserved headroom |
| 6 | logical `0x83` | ext4 recordings | consumes the remaining release image and is the only filesystem grown on larger media |

Putting state in primary partition 3 keeps the most important writable
filesystem independent of the EBR chain. The only EBR link is from fixed log
partition 5 to final media partition 6. All durable mounts must use recorded
filesystem UUIDs and additionally prove the expected root-backed disk, DOS disk
identifier, partition number, type and exact fixed starts before mounting or
growing anything.

The 6 GiB system, 512 MiB state and 256 MiB journal allocations below are an
**illustrative 8 GiB prototype geometry**, carried over only to make mutation
boundaries testable. They are not release sizes until clean Pi package use,
minimum recording reserve, state pressure, journal pressure and the 1 GiB Pi 3
RAM/runtime budget have been measured.

| Item | Start sector | Sector count | End sector |
|---|---:|---:|---:|
| boot primary 1 | 16,384 | 1,048,576 | 1,064,959 |
| system primary 2 | 1,064,960 | 12,582,912 | 13,647,871 |
| state primary 3 | 13,647,872 | 1,048,576 | 14,696,447 |
| extended primary 4 | 14,696,448 | 2,080,768 | 16,777,215 |
| EBR 1 | 14,696,448 | one sector | 14,696,448 |
| journal logical 5 | 14,698,496 | 524,288 | 15,222,783 |
| EBR 2 | 15,222,784 | one sector | 15,222,784 |
| media logical 6 | 15,224,832 | 1,552,384 | 16,777,215 |

Every data filesystem begins on a 2,048-sector boundary. The 8 GiB image leaves
758 MiB for prototype media after the two 1 MiB EBR alignment gaps. That small
remainder is another reason to measure and approve final sizes rather than copy
the ZERO 3W values into a release profile.

The successful private Pi build `191aa2f4b4303c3b4981cd0d19c1cc2a051567854767f43094f2d51ac6124b07`
reported 811,620 allocated 4 KiB root blocks, about 3.10 GiB, after the complete
application and Pi packages were installed. This supports a 6 GiB prototype
root with about 2.90 GiB for maintenance growth, but does not yet prove the
long-term package budget. A 16 GB minimum-card policy gives the final media
partition materially more than the 758 MiB present in the 8 GiB build; the
grower must use the card's observed sector count because marketed capacity is
not exact.

### Assembly mutation boundary

Start from the verified raw input, fail before mutation on any fact mismatch,
and change only these partition-table bytes:

1. Preserve sector 0 bytes 0–473, including boot code, disk identifier, all of
   partition 1 and partition 2's type/start. Change partition 2's sector count
   at bytes 474–477.
2. Populate the new 16-byte partition 3 entry at bytes 478–493 and the new
   partition 4 extended entry at bytes 494–509. Preserve bytes 510–511 (`55aa`).
3. Create EBR 1 at sector 14,696,448 and EBR 2 at sector 15,222,784. Preserve no
   pre-existing bytes at or beyond the original image end; nevertheless verify
   those regions were newly allocated by the builder.
4. Grow ext4 system partition 2 offline while retaining its UUID. Create state,
   log and media with generated, manifest-recorded filesystem UUIDs. Leave the
   FAT geometry, filesystem identity and content unchanged except for explicit
   installer/kernel boot-file updates.

Hash the preserved sector-0 ranges and the boot filesystem before and after
layout conversion. Parse the completed MBR and both EBRs independently rather
than accepting a partitioning tool's success status. Reject extra primary or
logical entries.

### First-boot growth boundary

The final media partition must grow to larger cards without moving boot,
system, state, journal, either EBR, or the media start. The initramfs grower
first proves the exact manifest geometry and physical parent, then applies only
the following monotonically increasing little-endian 32-bit sector counts:

1. Sector 0 bytes 506–509: extended partition 4 count becomes
   `device_sectors - 14,696,448`.
2. EBR 1 sector 14,696,448 bytes 474–477: its link-to-EBR-2 count becomes
   `device_sectors - 15,222,784`; the link start remains 526,336 sectors relative
   to the extended-partition base.
3. EBR 2 sector 15,222,784 bytes 458–461: media partition 6 count becomes
   `device_sectors - 15,224,832`; its data start remains 2,048 sectors relative
   to EBR 2.
4. After flushing and re-reading each table stage, grow the media ext4
   filesystem, flush it, and verify its UUID, start and final block count.

The grower derives progress from geometry and accepts only the five valid prefix
states: old counts; extended count updated; EBR link updated; media partition
count updated; filesystem grown. It never shrinks a count and never uses a
completion marker as evidence. A failure leaves recording disabled while core
and setup continue from protected root and intact state.

MBR and each EBR are single-copy 512-byte metadata sectors. Flush-and-verify
ordering makes completed stages retryable, but it cannot guarantee recovery if
power loss tears sector 0 or either EBR write. A saved copy elsewhere on the
card cannot help firmware find FAT partition 1 after a torn MBR. The release
must state this permanent format limit even after controlled cuts during each
growth stage pass on Pi 3, 4 and 5. Those tests can characterise the observed
failure and recovery behavior; they cannot make a torn single-copy sector
recoverable. A failed provisioning grow may require reflashing. This limitation
does not permit ordinary operation to rewrite partition tables.

## Rejected alternatives

| Layout | Result |
|---|---|
| Four primary partitions | Cannot represent boot, root, state, logs and media as five independent filesystems. Combining logs with media or state breaks capacity isolation. |
| Pure GPT | Reject for the shared image. It drops the locked Pi 3 MBR boundary and adds EEPROM/firmware-sensitive boot behavior demonstrated in the linked tracker reports. |
| Hybrid GPT | Reject. It adds overlapping MBR/GPT truth and interruption states without eliminating first-boot table updates. |
| Fixed-size state/log filesystem images inside media | Reject. Capacity can be bounded, but loss/corruption of the outer media filesystem removes state and logs together, and nested journals complicate durable ordering. Root cannot host writable images while remaining protected. |
| Raw offset loop devices outside the partition table | Reject. The space appears unallocated to normal tools, lacks a partition identity, and makes parent-disk validation and safe growth harder. |
| LVM inside one primary partition | Feasible in principle, but adds device-mapper/LVM tools and metadata recovery to the initramfs for no required feature. The native MBR/EBR parser is the smaller mechanism to qualify. |

## Evidence still required

Before this recommendation becomes `image/storage-layout.json` or production
builder code:

- approve the 6 GiB root and 16 GB minimum-card proposal after measuring
  maintenance growth, state/log pressure and the recording reserve;
- construct a disposable Linux MBR/EBR fixture and inject interruption after
  each of the three table-count writes and during ext4 growth;
- extract and execute the exact generated Pi initramfs tools, including MBR/EBR
  parsing, read-only FAT/root mounts, UUID routing and media fallback;
- cold-flash and boot the identical artifact on Pi 3, Pi 4 and Pi 5, recording
  model/revision, EEPROM/firmware where applicable, card and artifact hashes;
- test orderly restart, repeated electrical cuts at idle and under state/log/media
  writes, and controlled cuts during first-boot growth; and
- qualify explicit maintenance across Raspberry Pi kernel/firmware updates so
  both FAT boot and ext4 system return to observed read-only protection.

Until those gates pass, the current Raspberry Pi backend remains a writable,
private test image and must not be attached to a release as a protected or
power-loss-qualified artifact.
