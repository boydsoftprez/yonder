# ZERO 3W protected-storage boot experiment

Requirements: R-STO-01/02/03/04/05/07, R-CFG-08. This is the physical boot
checkpoint in Task 2 of the [image plan](../../docs/superpowers/plans/2026-09-10-board-images-and-recovery.md).
It is not a finished owner/recovery image or a power-loss qualification result.

The explicit `--storage-prototype` bench build retains the complete application,
ZERO 3W CSI provisioning, hardware H.264 decode selection and stable adaptive
message layout. Existing private bench SSH remains available with a generated
per-build password/key and password-required sudo. The AP and console password
setup remain the normal entry point.

The 8 GiB image reserves a 6 GiB system partition, 512 MiB state partition,
256 MiB log partition and the remaining image space for recordings. On first
boot from a larger card, the final media partition and its ext4 filesystem grow
to the physical disk's last usable GPT sector. The fixed system, state and log
partitions do not move or grow. These are candidate allocations for the observed
2 GiB ZERO 3W, not validated minimum budgets for Raspberry Pi or every ZERO 3W
memory variant.

At initramfs time, before systemd/services run:

- The system partition, including Armbian's `/boot`, becomes read-only.
- `/etc` is a 32 MiB RAM copy, preserving standard account-tool rename semantics.
- Durable partitions are selected from the mounted root's own disk and checked
  against their generated filesystem UUIDs. A second cloned card with matching
  UUIDs is not selected. Existing
  `/etc/yonder`, `/etc/ssh`, Yonder state, NetworkManager state, ZeroTier state,
  and systemd state are projected onto the state filesystem.
- Machine identity is generated and synchronized on state before PID 1 starts.
  First-boot SSH keys are written into the persistent SSH directory.
- Yonder-owned Node-RED runtime is a 64 MiB RAM copy; home/root are bounded RAM
  copies (16/8 MiB). Temporary/cache/log directories have separate 32/16/32/16
  MiB limits. `/run` retains the initramfs/systemd RAM filesystem's existing limit.
- Journal files occupy their own disk, capped at 128 MiB with 32 MiB headroom
  and the agreed 10-second normal synchronization interval. Other logs remain
  in bounded RAM; duplicate Armbian/rsyslog copies are disabled.
- Recording storage is independent of configuration and logs. Missing media is
  replaced by a read-only empty mount, preventing accidental state-disk writes.
- Before mounting media, the initramfs grower proves that root, state, logs and
  media are partitions 1–4 of the same root-backed disk. It checks their generated
  filesystem UUIDs, partition GUIDs/types, fixed geometry, media start/name and
  disk GUID. It refuses unexpected/additional partitions rather than scanning or
  mutating another physical disk.
- GPT repair/relocation, partition growth and ext4 growth are separately flushed
  and verified. A later boot derives the remaining work from GPT/filesystem
  geometry, so interruption after any completed phase is retryable without a
  completion marker. Media failure disables recording through the read-only empty
  mount while the AP and core services can continue.
- A missing/incomplete state seed stops boot with an explicit diagnostic;
  it never silently initializes a new owner or identity. This prototype has no
  web recovery surface for a failed state mount. Missing journal storage falls
  back to bounded RAM and reports the failure.

Automatic apt jobs and Armbian zram/log management are masked. Swap is disabled
for this first 2 GiB board experiment. Debian's package-database backup remains
available but is skipped whenever `/var/backups` is read-only; its condition is
stored on the persistent system partition so it survives the RAM `/etc` reset.
Run `sudo yonder-storage-prototype-status`
to inspect actual mounts, flags and free space after boot.

## Tests and outstanding work

Assembly extracts the generated initramfs and executes its packaged tools in
an isolated mount namespace. Full tools live at private paths because the
initramfs's lightweight default `mount` does not support `--bind`, and its copy
helper does not overwrite existing binaries. This gate covers the tool mismatch
that stopped prototype 03 before identity creation and persistent logging.

Assembly also exercises the actual mount script on the copied image in a private
Linux container. It checks rejected system/boot writes, independent filesystem
devices, configuration/log/media persistence across teardown/recreation,
machine-ID persistence, discarded RAM changes and incomplete-state refusal.
Probe identity/files are removed before compression. Every filesystem receives
an offline check, and the upstream bootloader bytes remain hash-checked.

`grow-media-test.sh` runs only in a privileged disposable Linux Docker container.
It mounts a generated root read-only and proves larger-disk growth, an exact
second-run no-op, retries after injected GPT/partition/filesystem checkpoints,
repair of one damaged GPT copy, and unchanged refusal for wrong geometry or a
media UUID on another disk. This establishes the bounded software ordering. GPT
writes are not atomic: recovery requires at least one readable copy describing
the exact expected layout. The test cannot prove survival if both GPT copies,
ext4 metadata, or the physical medium are damaged during a write.

The next card test must establish first boot, AP setup, home-network join,
console/SSH access, CSI/USB camera behavior, memory use, and persistence after
an orderly restart before power-cut tests. Installed hooks and mount simulation
cannot prove U-Boot/initramfs execution on this board.

Production owner account projection, transactional config/secret coordination,
backup/restore, observed Settings controls, guarded apt maintenance, recording
growth, retained package inputs and GitHub release automation remain unfinished.
Do not change a Linux account password in this prototype expecting it to persist:
the managed owner projector is not implemented. The private bench account is
seeded into the base `/etc` and reappears on each boot. Yonder's console password
and configuration already use the persistent state mounts, but cross-file
transaction and electrical power-loss qualification are separate requirements.

Do not treat this card as power-cut-safe merely because the system is read-only.
Durable state and recording interruption still require their planned tests.
