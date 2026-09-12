#!/bin/bash
# Exercise Pi protected mounts on the actual assembled image in a private namespace.
set -Eeuo pipefail
report_error() {
    local exit_status=$?
    printf 'FAIL: Pi mount verifier line %s exited %s\n' "$LINENO" "$exit_status" >&2
}
trap report_error ERR
[[ -f /.dockerenv && ( $# == 1 || ( $# == 2 && $2 == production ) ) \
    && -x $1 && ! -L $1 \
    && -f /work/disk.img && ! -L /work/disk.img ]]
helper_source=$1
production=0
[[ ${2:-} == production ]] && production=1

prototype=/prototype
disk_loop=
created_nodes=()
incomplete_error=/tmp/yonder-pi-incomplete-state-error
runtime_helper=/usr/lib/yonder/initramfs-bin/yonder-pi-mbr-layout
mkdir -p "$prototype"

loop_is_ours() {
    local candidate=$1 associated
    associated=$(losetup --associated /work/disk.img 2>/dev/null || true)
    while IFS=: read -r loop _; do
        [[ $loop != "$candidate" ]] || return 0
    done <<<"$associated"
    return 1
}

unmount_prototype() {
    if mountpoint -q /run/yonder-pi-prototype-ram-source; then
        umount /run/yonder-pi-prototype-ram-source
    fi
    if mountpoint -q "$prototype"; then
        umount --recursive "$prototype"
    fi
}
cleanup_state_smoke() {
    rm -rf "$prototype/var/lib/yonder-state/.storage-smoke-transactions" \
        "$prototype/etc/yonder/.storage-smoke-config.yaml" \
        "$prototype/etc/yonder/.storage-smoke-secrets.yaml" \
        "$prototype/tmp/yonder-state-smoke.mjs" 2>/dev/null || true
}

cleanup() {
    set +e
    cleanup_state_smoke
    unmount_prototype
    if [[ -n $disk_loop ]] && loop_is_ours "$disk_loop"; then
        losetup -d "$disk_loop"
    fi
    for node in "${created_nodes[@]}"; do
        rm -f "$node"
    done
    rm -f "$incomplete_error"
    rm -f "$runtime_helper"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

disk_loop=$(losetup --find --show --partscan /work/disk.img)
loop_is_ours "$disk_loop"
disk_name=${disk_loop##*/}
for partition in {1..6}; do
    sysfs=/sys/class/block/${disk_name}p$partition
    [[ -r $sysfs/dev ]]
    device=/dev/${disk_name}p$partition
    if [[ ! -b $device ]]; then
        IFS=: read -r major minor <"$sysfs/dev"
        mknod "$device" b "$major" "$minor"
        created_nodes+=("$device")
    fi
done
boot_device=${disk_loop}p1
root_device=${disk_loop}p2
state_device=${disk_loop}p3
log_device=${disk_loop}p5
media_device=${disk_loop}p6
[[ ! -e $runtime_helper ]]
install -d -m 0755 "${runtime_helper%/*}"
install -m 0755 "$helper_source" "$runtime_helper"

verify_installed_storage_observer() {
    local expected=$1 observed
    if mountpoint -q "$prototype/proc"; then umount "$prototype/proc"; fi
    observed=$(unshare --mount --pid --fork --mount-proc="$prototype/proc" \
        chroot "$prototype" /usr/local/bin/yonder-node --input-type=module -e \
        'import { observeStorageMode } from "/opt/yonder/packages/yonder-core/dist/admin/storage-mode.js"; console.log(observeStorageMode());')
    [[ $observed == "$expected" ]]
}

boot_mount() {
    local expected_mode=${1:-protected} root_options boot_options
    mount -o rw "$root_device" "$prototype"
    touch "$prototype/usr/.yonder-write-precondition"
    rm "$prototype/usr/.yonder-write-precondition"
    /bin/sh "$prototype/usr/lib/yonder/storage-prototype/mount-storage.sh" "$prototype"
    root_options=$(findmnt -n -T "$prototype" -o OPTIONS)
    boot_options=$(findmnt -n -T "$prototype/boot/firmware" -o OPTIONS)
    case "$expected_mode:,$root_options,:$boot_options," in
        protected:*,ro,*:*,ro,*) ;;
        maintenance:*,rw,*:*,rw,*) ;;
        *) return 1 ;;
    esac
    [[ $(findmnt -n -T "$prototype" -o SOURCE) == "$root_device" ]]
    [[ $(findmnt -n -T "$prototype/boot/firmware" -o SOURCE) == "$boot_device" ]]
    [[ $(< "$prototype/run/yonder-storage-mode") == "$expected_mode" ]]
    verify_installed_storage_observer "$expected_mode"
}

uuid_at() {
    local device
    device=$(findmnt -n -T "$1" -o SOURCE)
    device=${device%%\[*}
    blkid -s UUID -o value "$device"
}

verify_state_coordinator() {
    local marker=$1 script=$prototype/tmp/yonder-state-smoke.mjs
    local config_before secrets_before secrets_mode
    chroot "$prototype" test -x /usr/local/bin/yonder-node
    [[ -f $prototype/opt/yonder/packages/yonder-core/dist/admin/main.js ]]
    [[ -f $prototype/etc/systemd/system/yonder-admin.service ]]
    [[ -f $prototype/etc/systemd/system/yonder-admin.socket ]]
    grep -Fqx 'ExecStart=/usr/local/bin/yonder-node /opt/yonder/packages/yonder-core/dist/admin/main.js' \
        "$prototype/etc/systemd/system/yonder-admin.service"
    mount -t proc -o nosuid,nodev,noexec proc "$prototype/proc"
    cat >"$script" <<'EOF'
import { chmodSync, copyFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DurableStateCoordinator } from "/opt/yonder/packages/yonder-core/dist/state/coordinator.js";
import { assertManagedStateMount, loadConventionalState } from "/opt/yonder/packages/yonder-core/dist/state/recover.js";

const stateRoot = "/var/lib/yonder-state";
const transactionsRoot = `${stateRoot}/.storage-smoke-transactions`;
const configPath = "/etc/yonder/.storage-smoke-config.yaml";
const secretsPath = "/etc/yonder/.storage-smoke-secrets.yaml";
const markerPath = process.env.YONDER_STORAGE_MARKER;
if (!markerPath) throw new Error("storage marker was not supplied");
const check = (condition, message) => { if (!condition) throw new Error(message); };
const assertStorage = () => assertManagedStateMount({
  stateRoot,
  markerPath,
  mountInfoPath: "/proc/self/mountinfo",
});
const conventional = () => loadConventionalState({ configPath, secretsPath });

try {
  const factory = loadConventionalState({
    configPath: "/etc/yonder/config.yaml",
    secretsPath: "/etc/yonder/secrets.yaml",
  });
  copyFileSync("/etc/yonder/config.yaml", configPath);
  copyFileSync("/etc/yonder/secrets.yaml", secretsPath);
  chmodSync(configPath, 0o644);
  chmodSync(secretsPath, 0o600);

  let coordinator = new DurableStateCoordinator({
    root: transactionsRoot,
    configPath,
    secretsPath,
    bootstrap: async () => conventional(),
    projectors: [],
    assertStorage,
  });
  const initialized = await coordinator.recover();
  check(initialized.action === "none", "fresh state did not initialize cleanly");
  const before = await coordinator.beginSnapshot({ id: randomUUID() });
  check(JSON.stringify(before.snapshot.state) === JSON.stringify(factory), "factory config/secrets bootstrap drifted");
  await before.release();

  const transaction = await coordinator.begin({
    id: randomUUID(),
    kind: "config-apply",
    expectedActiveGeneration: before.snapshot.generation,
  });
  const next = structuredClone(transaction.previous.state);
  next.config.system.hostname = "yonder-storage-smoke";
  next.secrets.storage_smoke = "fixture";
  await transaction.stage(next);
  await transaction.activate();
  const committed = await transaction.commit();
  check((await coordinator.status()).operation === null, "committed operation remained active");

  coordinator = new DurableStateCoordinator({
    root: transactionsRoot,
    configPath,
    secretsPath,
    bootstrap: async () => { throw new Error("restart attempted to bootstrap instead of recovering durable state"); },
    projectors: [],
    assertStorage,
  });
  const restarted = await coordinator.recover();
  check(restarted.action === "none", "clean restart required recovery action");
  check(restarted.selectedGeneration === committed.generation, "restart selected the wrong durable generation");
  const projected = conventional();
  check(projected.config.system.hostname === "yonder-storage-smoke", "committed config did not survive restart");
  check(projected.secrets.storage_smoke === "fixture", "committed secret did not survive restart");
  check((await coordinator.status()).operation === null, "restart left a pending transaction");
} finally {
  rmSync(transactionsRoot, { recursive: true, force: true });
  rmSync(configPath, { force: true });
  rmSync(secretsPath, { force: true });
}
EOF
    config_before=$(sha256sum "$prototype/etc/yonder/config.yaml")
    secrets_before=$(sha256sum "$prototype/etc/yonder/secrets.yaml")
    secrets_mode=$(stat -c %a "$prototype/etc/yonder/secrets.yaml")
    chroot "$prototype" /usr/bin/env YONDER_STORAGE_MARKER="$marker" \
        /usr/local/bin/yonder-node /tmp/yonder-state-smoke.mjs
    [[ $(sha256sum "$prototype/etc/yonder/config.yaml") == "$config_before" ]]
    [[ $(sha256sum "$prototype/etc/yonder/secrets.yaml") == "$secrets_before" ]]
    [[ $(stat -c %a "$prototype/etc/yonder/secrets.yaml") == "$secrets_mode" ]]
    [[ ! -e $prototype/var/lib/yonder-state/.storage-smoke-transactions ]]
    [[ ! -e $prototype/etc/yonder/.storage-smoke-config.yaml ]]
    [[ ! -e $prototype/etc/yonder/.storage-smoke-secrets.yaml ]]
    rm "$script"
}
run_maintenance_coordinator() {
    local action=$1 operation_id=${2:-} script=$prototype/tmp/yonder-maintenance-smoke.mjs
    if ! mountpoint -q "$prototype/proc"; then
        mount -t proc -o nosuid,nodev,noexec proc "$prototype/proc"
    fi
    cat >"$script" <<'EOF'
import { readFileSync } from "node:fs";
import { DurableStateCoordinator } from "/opt/yonder/packages/yonder-core/dist/state/coordinator.js";
import { assertManagedStateMount, loadConventionalState } from "/opt/yonder/packages/yonder-core/dist/state/recover.js";

const action = process.argv[2];
const operationId = process.argv[3];
const assertStorage = () => assertManagedStateMount({
  stateRoot: "/var/lib/yonder-state",
  markerPath: process.env.YONDER_STORAGE_MARKER,
  mountInfoPath: "/proc/self/mountinfo",
});
const observeStorageMode = () => {
  const value = readFileSync("/run/yonder-storage-mode", "utf8");
  if (value === "protected\n") return "protected";
  if (value === "maintenance\n") return "maintenance";
  throw new Error("storage mode marker is invalid");
};
const coordinator = new DurableStateCoordinator({
  root: "/var/lib/yonder-state/transactions",
  configPath: "/etc/yonder/config.yaml",
  secretsPath: "/etc/yonder/secrets.yaml",
  bootstrap: async () => loadConventionalState({ configPath: "/etc/yonder/config.yaml", secretsPath: "/etc/yonder/secrets.yaml" }),
  projectors: [], assertStorage, observeStorageMode,
});
await coordinator.recover();
if (action === "request") {
  await coordinator.requestMaintenance({ id: operationId });
  if ((await coordinator.status()).operation?.phase !== "awaiting-maintenance-reboot") throw new Error("maintenance was not armed");
} else if (action === "entered") {
  const status = await coordinator.status();
  if (status.operation?.id !== operationId || status.operation.phase !== "entered-maintenance") throw new Error("maintenance entry was not recovered");
} else if (action === "complete") {
  if ((await coordinator.status()).operation !== null) throw new Error("maintenance operation did not complete");
} else throw new Error("unknown maintenance smoke action");
EOF
    chroot "$prototype" /usr/bin/env YONDER_STORAGE_MARKER="$storage_marker" \
        /usr/local/bin/yonder-node /tmp/yonder-maintenance-smoke.mjs "$action" "$operation_id"
    rm "$script"
}
install_maintenance_probe() {
    install -d "$prototype/tmp/yonder-maintenance-probe/DEBIAN" "$prototype/tmp/yonder-maintenance-probe/usr/lib/yonder-maintenance-probe"
    cat >"$prototype/tmp/yonder-maintenance-probe/DEBIAN/control" <<'EOF'
Package: yonder-maintenance-probe
Version: 1.0
Architecture: arm64
Maintainer: Yonder image verifier
Description: Disposable package proving apt writes the persistent system
EOF
    printf '%s\n' persistent >"$prototype/tmp/yonder-maintenance-probe/usr/lib/yonder-maintenance-probe/installed"
    chroot "$prototype" dpkg-deb --build /tmp/yonder-maintenance-probe /tmp/yonder-maintenance-probe.deb >/dev/null
    chroot "$prototype" apt-get install -y /tmp/yonder-maintenance-probe.deb >/dev/null
}

boot_mount
if [[ $production == 1 ]]; then
    storage_marker=/etc/yonder-storage-layout.conf
    # shellcheck disable=SC1091 # installed parser is trusted code; marker remains data
    source "$prototype/usr/lib/yonder/storage/layout.sh"
    yonder_read_layout "$prototype$storage_marker" rpi
else
    storage_marker=/etc/yonder-pi-storage-prototype.conf
    # shellcheck source=/dev/null # generated trusted prototype configuration
    source "$prototype$storage_marker"
fi
[[ $STATE_UUID != "$LOG_UUID" && $STATE_UUID != "$MEDIA_UUID" && $LOG_UUID != "$MEDIA_UUID" ]]
[[ $(uuid_at "$prototype/var/lib/yonder-state") == "$STATE_UUID" ]]
[[ $(uuid_at "$prototype/etc/yonder") == "$STATE_UUID" ]]
[[ $(uuid_at "$prototype/etc/ssh") == "$STATE_UUID" ]]
[[ $(uuid_at "$prototype/var/lib/yonder") == "$STATE_UUID" ]]
[[ $(uuid_at "$prototype/var/log/journal") == "$LOG_UUID" ]]
[[ $(uuid_at "$prototype/var/lib/yonder/captures") == "$MEDIA_UUID" ]]
for path in /usr /boot/firmware; do
    if touch "$prototype$path/.yonder-write-probe" 2>/dev/null; then
        printf 'FAIL: %s accepted a normal system write\n' "$path" >&2
        exit 1
    fi
done
[[ $(findmnt -n -T "$prototype/etc" -o FSTYPE) == tmpfs ]]
[[ $(findmnt -n -T "$prototype/var/lib/yonder/console" -o FSTYPE) == tmpfs ]]
[[ $(findmnt -n -T "$prototype/var/log/journal" -o FSTYPE) == ext4 ]]
[[ $(findmnt -n -T "$prototype/var/lib/yonder/captures" -o FSTYPE) == ext4 ]]
[[ $(stat -c %d "$prototype/etc/yonder") != "$(stat -c %d "$prototype/var/log/journal")" ]]
[[ $(stat -c %d "$prototype/etc/yonder") != "$(stat -c %d "$prototype/var/lib/yonder/captures")" ]]
if [[ $production == 1 ]]; then
    if chroot "$prototype" getent passwd yonder-bench >/dev/null 2>&1; then
        printf 'FAIL: production image retained yonder-bench account\n' >&2
        exit 1
    fi
    set -- "$prototype"/etc/ssh/ssh_host_*_key
    [[ ! -e $1 ]]
else
    chroot "$prototype" getent passwd yonder-bench >/dev/null
fi
verify_state_coordinator "$storage_marker"

# Minimal namespace-local devices support the real first-boot identity helper.
mount -t tmpfs -o mode=755 tmpfs "$prototype/dev"
for spec in 'null 1 3' 'zero 1 5' 'random 1 8' 'urandom 1 9'; do
    read -r name major minor <<<"$spec"
    mknod -m 666 "$prototype/dev/$name" c "$major" "$minor"
done
if [[ $production == 0 ]]; then
    chroot "$prototype" /usr/local/sbin/yonder-bench-first-boot
    [[ -f $prototype/var/lib/yonder/bench-first-boot.done ]]
    host_key_hash=$(sha256sum "$prototype/etc/ssh/ssh_host_ed25519_key" | cut -d' ' -f1)
fi
chroot "$prototype" /usr/sbin/runuser -u yonder -- /bin/sh -c \
    'echo writable > /var/lib/yonder/console/.runtime-probe'
echo durable-probe >"$prototype/etc/yonder/.mount-probe"
echo media-probe >"$prototype/var/lib/yonder/captures/.mount-probe"
echo log-probe >"$prototype/var/log/journal/.mount-probe"
echo volatile-probe >"$prototype/etc/.volatile-probe"
machine_id=$(cat "$prototype/etc/machine-id")
sync
unmount_prototype

boot_mount
[[ $(cat "$prototype/etc/machine-id") == "$machine_id" ]]
if [[ $production == 0 ]]; then
    [[ $(sha256sum "$prototype/etc/ssh/ssh_host_ed25519_key" | cut -d' ' -f1) == "$host_key_hash" ]]
    [[ -f $prototype/var/lib/yonder/bench-first-boot.done ]]
else
    set -- "$prototype"/etc/ssh/ssh_host_*_key
    [[ ! -e $1 ]]
fi
[[ ! -e $prototype/var/lib/yonder/console/.runtime-probe ]]
[[ $(cat "$prototype/etc/yonder/.mount-probe") == durable-probe ]]
[[ $(cat "$prototype/var/lib/yonder/captures/.mount-probe") == media-probe ]]
[[ $(cat "$prototype/var/log/journal/.mount-probe") == log-probe ]]
[[ ! -e $prototype/etc/.volatile-probe ]]
rm "$prototype/etc/yonder/.mount-probe" \
    "$prototype/var/lib/yonder/captures/.mount-probe" \
    "$prototype/var/log/journal/.mount-probe"

maintenance_one=12345678-1234-4123-8123-123456789abc
run_maintenance_coordinator request "$maintenance_one"
sync
unmount_prototype
boot_mount maintenance
run_maintenance_coordinator entered "$maintenance_one"
install_maintenance_probe
printf '%s\n' persistent >"$prototype/etc/.yonder-maintenance-probe"
printf '%s\n' persistent >"$prototype/home/.yonder-maintenance-probe"
printf '%s\n' persistent >"$prototype/boot/firmware/.yonder-maintenance-probe"
sync
unmount_prototype
boot_mount protected
run_maintenance_coordinator complete "$maintenance_one"
# shellcheck disable=SC2016 # dpkg-query expands its own ${Status} placeholder
# shellcheck disable=SC2016 # dpkg-query expands its own field placeholder
[[ $(chroot "$prototype" dpkg-query -W -f='${Status}' yonder-maintenance-probe) == \
    'install ok installed' ]]
[[ $(< "$prototype/usr/lib/yonder-maintenance-probe/installed") == persistent ]]
[[ $(< "$prototype/etc/.yonder-maintenance-probe") == persistent ]]
[[ $(< "$prototype/home/.yonder-maintenance-probe") == persistent ]]
[[ $(< "$prototype/boot/firmware/.yonder-maintenance-probe") == persistent ]]

maintenance_two=87654321-4321-4321-8321-cba987654321
run_maintenance_coordinator request "$maintenance_two"
sync
unmount_prototype
boot_mount maintenance
run_maintenance_coordinator entered "$maintenance_two"
chroot "$prototype" apt-get purge -y yonder-maintenance-probe >/dev/null
rm "$prototype/etc/.yonder-maintenance-probe" \
    "$prototype/home/.yonder-maintenance-probe" \
    "$prototype/boot/firmware/.yonder-maintenance-probe"
sync
unmount_prototype
boot_mount protected
run_maintenance_coordinator complete "$maintenance_two"
[[ ! -e $prototype/usr/lib/yonder-maintenance-probe ]]
if chroot "$prototype" dpkg-query -W yonder-maintenance-probe >/dev/null 2>&1; then
    exit 1
fi
rm -rf "$prototype/var/lib/yonder-state/transactions" \
    "$prototype/var/lib/yonder-state/maintenance"
# Remove all identity created only by this disposable proof.
rm "$prototype/var/lib/yonder-state/machine-id"
if [[ $production == 0 ]]; then
    rm "$prototype/var/lib/yonder-state/ssh/"ssh_host_* \
        "$prototype/var/lib/yonder-state/app/bench-first-boot.done"
fi
mv "$prototype/var/lib/yonder-state/seed-complete" \
    "$prototype/var/lib/yonder-state/seed-test-held"
sync
unmount_prototype

mount -o ro "$root_device" "$prototype"
if /bin/sh "$prototype/usr/lib/yonder/storage-prototype/mount-storage.sh" "$prototype" \
        2>"$incomplete_error"; then
    echo 'FAIL: incomplete state seed booted as a new installation' >&2
    exit 1
fi
grep -Fxq 'Yonder Pi storage prototype: incomplete state seed; refusing fresh setup' \
    "$incomplete_error"
rm "$incomplete_error"
mv "$prototype/var/lib/yonder-state/seed-test-held" \
    "$prototype/var/lib/yonder-state/seed-complete"
[[ ! -e $prototype/var/lib/yonder-state/machine-id ]]
sync
unmount_prototype

# A bad media identity keeps core state available and exposes a read-only empty
# recording directory. Restore the prototype UUID before shipping the image.
tune2fs -U random "$media_device" >/dev/null
boot_mount
[[ $(uuid_at "$prototype/etc/yonder") == "$STATE_UUID" ]]
[[ $(findmnt -n -T "$prototype/var/lib/yonder/captures" -o FSTYPE) == tmpfs ]]
case ",$(findmnt -n -T "$prototype/var/lib/yonder/captures" -o OPTIONS)," in
    *,ro,*) ;; *) exit 1 ;;
esac
unmount_prototype
tune2fs -U "$MEDIA_UUID" "$media_device" >/dev/null

# A bad journal identity falls back to bounded RAM logs and disables media so
# no recording can consume state storage. Restore and check both filesystems.
tune2fs -U random "$log_device" >/dev/null
boot_mount
[[ $(uuid_at "$prototype/etc/yonder") == "$STATE_UUID" ]]
[[ $(findmnt -n -T "$prototype/var/log/journal" -o FSTYPE) == tmpfs ]]
[[ $(findmnt -n -T "$prototype/var/lib/yonder/captures" -o FSTYPE) == tmpfs ]]
unmount_prototype
tune2fs -U "$LOG_UUID" "$log_device" >/dev/null
# Simulated maintenance and fallback boots create identity in persistent root
# and state. Remove it after the proof so the released card remains factory
# fresh and generates identity on its physical first boot.
mount -o rw "$root_device" "$prototype"
: >"$prototype/etc/machine-id"
chmod 0444 "$prototype/etc/machine-id"
sync -f "$prototype/etc/machine-id"
umount "$prototype"
mount -o rw "$state_device" "$prototype"
rm -f "$prototype/machine-id"
sync -f "$prototype"
umount "$prototype"
e2fsck -fn "$state_device" >/dev/null
e2fsck -fn "$log_device" >/dev/null
e2fsck -fn "$media_device" >/dev/null

cleanup
trap - EXIT INT TERM
printf '%s\n' 'PASS: actual Pi FAT/root protection, one-shot maintenance, persistent apt install/removal, durable coordinator bootstrap/commit/restart, separate state/log/media, persistent identity/data, volatile reset, bounded fallbacks and incomplete-state refusal.'
printf '%s\n' 'LIMIT: namespace mount proof, not a Pi 3/4/5 boot or electrical power-cut test.'
