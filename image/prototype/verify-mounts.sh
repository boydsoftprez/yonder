#!/bin/bash
# Exercise the actual boot mount script against the assembled, disposable image.
set -Eeuo pipefail
report_error() {
    local exit_status=$?
    printf 'FAIL: Radxa mount verifier line %s exited %s\n' "$LINENO" "$exit_status" >&2
}
trap report_error ERR
[[ -f /.dockerenv && ( $# == 1 || ( $# == 2 && $2 == production ) ) \
    && $1 =~ ^/dev/loop[0-9]+$ ]]
offset_root_loop=$1
production=0
[[ ${2:-} == production ]] && production=1
[[ $(losetup -n -O BACK-FILE "$offset_root_loop") == /work/disk.img ]]
mkdir -p /prototype
disk_loop=$(losetup --find --show --partscan /work/disk.img)
loop_is_ours() {
    local candidate=$1 associated
    associated=$(losetup --associated /work/disk.img)
    while IFS=: read -r loop _; do
        [[ $loop != "$candidate" ]] || return 0
    done <<<"$associated"
    return 1
}
loop_is_ours "$disk_loop"
disk_name=${disk_loop##*/}
for partition in {1..4}; do
    device=${disk_loop}p$partition
    if [[ ! -b $device ]]; then
        IFS=: read -r major minor <"/sys/class/block/${disk_name}p${partition}/dev"
        mknod "$device" b "$major" "$minor"
    fi
done
root_loop=${disk_loop}p1

unmount_prototype() {
    if mountpoint -q /run/yonder-prototype-ram-source; then umount /run/yonder-prototype-ram-source; fi
    if mountpoint -q /prototype; then umount --recursive /prototype; fi
}
cleanup_state_smoke() {
    rm -rf /prototype/var/lib/yonder-state/.storage-smoke-transactions \
        /prototype/etc/yonder/.storage-smoke-config.yaml \
        /prototype/etc/yonder/.storage-smoke-secrets.yaml \
        /prototype/tmp/yonder-state-smoke.mjs 2>/dev/null || true
}
cleanup() {
    set +e
    cleanup_state_smoke
    unmount_prototype
    if loop_is_ours "$disk_loop"; then
        losetup -d "$disk_loop"
        for partition in {1..4}; do
            device=${disk_loop}p$partition
            [[ ! -b $device ]] || rm -f "$device"
        done
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
verify_installed_storage_observer() {
    local expected=$1 observed
    if mountpoint -q /prototype/proc; then umount /prototype/proc; fi
    observed=$(unshare --mount --pid --fork --mount-proc=/prototype/proc \
        chroot /prototype /usr/local/bin/yonder-node --input-type=module -e \
        'import { observeStorageMode } from "/opt/yonder/packages/yonder-core/dist/admin/storage-mode.js"; console.log(observeStorageMode());')
    [[ $observed == "$expected" ]]
}
boot_mount() {
    local expected_mode=${1:-protected} options
    mount -o rw "$root_loop" /prototype
    touch /prototype/usr/.yonder-write-precondition
    rm /prototype/usr/.yonder-write-precondition
    /bin/sh /prototype/usr/lib/yonder/storage-prototype/mount-storage.sh /prototype
    options=$(findmnt -n -T /prototype -o OPTIONS)
    case "$expected_mode:$options" in
        protected:*,ro,*) ;;
        maintenance:*,rw,*) ;;
        *) return 1 ;;
    esac
    [[ $(findmnt -n -T /prototype -o SOURCE) == "$root_loop" ]]
    [[ $(< /prototype/run/yonder-storage-mode) == "$expected_mode" ]]
    verify_installed_storage_observer "$expected_mode"
}
boot_mount
if [[ $production == 1 ]]; then
    storage_marker=/etc/yonder-storage-layout.conf
    # shellcheck disable=SC1091 # installed parser is trusted code; marker remains data
    source /prototype/usr/lib/yonder/storage/layout.sh
    yonder_read_layout "/prototype$storage_marker" radxa
else
    storage_marker=/etc/yonder-storage-prototype.conf
    # shellcheck source=/dev/null # generated trusted prototype UUIDs
    source "/prototype$storage_marker"
fi
[[ $STATE_UUID != "$LOG_UUID" && $STATE_UUID != "$MEDIA_UUID" && $LOG_UUID != "$MEDIA_UUID" ]]
uuid_at() {
    local device
    device=$(findmnt -n -T "$1" -o SOURCE)
    device=${device%%\[*}
    blkid -s UUID -o value "$device"
}
verify_state_coordinator() {
    local marker=$1 script=/prototype/tmp/yonder-state-smoke.mjs
    local config_before secrets_before secrets_mode
    chroot /prototype test -x /usr/local/bin/yonder-node
    [[ -f /prototype/opt/yonder/packages/yonder-core/dist/admin/main.js ]]
    [[ -f /prototype/etc/systemd/system/yonder-admin.service ]]
    [[ -f /prototype/etc/systemd/system/yonder-admin.socket ]]
    grep -Fqx 'ExecStart=/usr/local/bin/yonder-node /opt/yonder/packages/yonder-core/dist/admin/main.js' \
        /prototype/etc/systemd/system/yonder-admin.service
    mount -t proc -o nosuid,nodev,noexec proc /prototype/proc
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
    config_before=$(sha256sum /prototype/etc/yonder/config.yaml)
    secrets_before=$(sha256sum /prototype/etc/yonder/secrets.yaml)
    secrets_mode=$(stat -c %a /prototype/etc/yonder/secrets.yaml)
    chroot /prototype /usr/bin/env YONDER_STORAGE_MARKER="$marker" \
        /usr/local/bin/yonder-node /tmp/yonder-state-smoke.mjs
    [[ $(sha256sum /prototype/etc/yonder/config.yaml) == "$config_before" ]]
    [[ $(sha256sum /prototype/etc/yonder/secrets.yaml) == "$secrets_before" ]]
    [[ $(stat -c %a /prototype/etc/yonder/secrets.yaml) == "$secrets_mode" ]]
    [[ ! -e /prototype/var/lib/yonder-state/.storage-smoke-transactions ]]
    [[ ! -e /prototype/etc/yonder/.storage-smoke-config.yaml ]]
    [[ ! -e /prototype/etc/yonder/.storage-smoke-secrets.yaml ]]
    rm "$script"
}
run_maintenance_coordinator() {
    local action=$1 operation_id=${2:-} script=/prototype/tmp/yonder-maintenance-smoke.mjs
    if ! mountpoint -q /prototype/proc; then
        mount -t proc -o nosuid,nodev,noexec proc /prototype/proc
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
    chroot /prototype /usr/bin/env YONDER_STORAGE_MARKER="$storage_marker" \
        /usr/local/bin/yonder-node /tmp/yonder-maintenance-smoke.mjs "$action" "$operation_id"
    rm "$script"
}
install_maintenance_probe() {
    install -d /prototype/tmp/yonder-maintenance-probe/DEBIAN /prototype/tmp/yonder-maintenance-probe/usr/lib/yonder-maintenance-probe
    cat >/prototype/tmp/yonder-maintenance-probe/DEBIAN/control <<'EOF'
Package: yonder-maintenance-probe
Version: 1.0
Architecture: arm64
Maintainer: Yonder image verifier
Description: Disposable package proving apt writes the persistent system
EOF
    printf '%s\n' persistent >/prototype/tmp/yonder-maintenance-probe/usr/lib/yonder-maintenance-probe/installed
    chroot /prototype dpkg-deb --build /tmp/yonder-maintenance-probe /tmp/yonder-maintenance-probe.deb >/dev/null
    chroot /prototype apt-get install -y /tmp/yonder-maintenance-probe.deb >/dev/null
}
[[ $(uuid_at /prototype/var/lib/yonder-state) == "$STATE_UUID" ]]
[[ $(uuid_at /prototype/etc/yonder) == "$STATE_UUID" ]]
[[ $(uuid_at /prototype/etc/ssh) == "$STATE_UUID" ]]
[[ $(uuid_at /prototype/var/lib/yonder) == "$STATE_UUID" ]]
[[ $(uuid_at /prototype/var/log/journal) == "$LOG_UUID" ]]
[[ $(uuid_at /prototype/var/lib/yonder/captures) == "$MEDIA_UUID" ]]
for path in /usr /boot; do
    if touch "/prototype$path/.yonder-write-probe" 2>/dev/null; then
        echo "FAIL: $path accepted a normal system write" >&2
        exit 1
    fi
done
[[ $(findmnt -n -T /prototype/etc -o FSTYPE) == tmpfs ]]
[[ $(findmnt -n -T /prototype/var/lib/yonder/console -o FSTYPE) == tmpfs ]]
[[ $(findmnt -n -T /prototype/var/log/journal -o FSTYPE) == ext4 ]]
[[ $(findmnt -n -T /prototype/var/lib/yonder/captures -o FSTYPE) == ext4 ]]
[[ $(stat -c %d /prototype/etc/yonder) != "$(stat -c %d /prototype/var/log/journal)" ]]
[[ $(stat -c %d /prototype/etc/yonder) != "$(stat -c %d /prototype/var/lib/yonder/captures)" ]]
if [[ $production == 1 ]]; then
    if chroot /prototype getent passwd yonder-bench >/dev/null 2>&1; then
        printf 'FAIL: production image retained yonder-bench account\n' >&2
        exit 1
    fi
    set -- /prototype/etc/ssh/ssh_host_*_key
    [[ ! -e $1 ]]
else
    chroot /prototype getent passwd yonder-bench >/dev/null
fi
verify_state_coordinator "$storage_marker"
# Minimal namespace-local devices for real first-boot key generation and a
# real unprivileged console write; no host /dev or physical device is exposed.
mount -t tmpfs -o mode=755 tmpfs /prototype/dev
for spec in 'null 1 3' 'zero 1 5' 'random 1 8' 'urandom 1 9'; do
    read -r name major minor <<<"$spec"
    mknod -m 666 "/prototype/dev/$name" c "$major" "$minor"
done
if [[ $production == 0 ]]; then
    chroot /prototype /usr/local/sbin/yonder-bench-first-boot
    [[ -f /prototype/var/lib/yonder/bench-first-boot.done ]]
    host_key_hash=$(sha256sum /prototype/etc/ssh/ssh_host_ed25519_key | cut -d' ' -f1)
fi
chroot /prototype /usr/sbin/runuser -u yonder -- /bin/sh -c 'echo writable > /var/lib/yonder/console/.runtime-probe'
echo durable-probe >/prototype/etc/yonder/.mount-probe
echo media-probe >/prototype/var/lib/yonder/captures/.mount-probe
echo log-probe >/prototype/var/log/journal/.mount-probe
echo volatile-probe >/prototype/etc/.volatile-probe
machine_id=$(cat /prototype/etc/machine-id)
sync
unmount_prototype
boot_mount
[[ $(cat /prototype/etc/machine-id) == "$machine_id" ]]
if [[ $production == 0 ]]; then
    [[ $(sha256sum /prototype/etc/ssh/ssh_host_ed25519_key | cut -d' ' -f1) == "$host_key_hash" ]]
    [[ -f /prototype/var/lib/yonder/bench-first-boot.done ]]
else
    set -- /prototype/etc/ssh/ssh_host_*_key
    [[ ! -e $1 ]]
fi
[[ ! -e /prototype/var/lib/yonder/console/.runtime-probe ]]
[[ $(cat /prototype/etc/yonder/.mount-probe) == durable-probe ]]
[[ $(cat /prototype/var/lib/yonder/captures/.mount-probe) == media-probe ]]
[[ $(cat /prototype/var/log/journal/.mount-probe) == log-probe ]]
[[ ! -e /prototype/etc/.volatile-probe ]]
rm /prototype/etc/yonder/.mount-probe /prototype/var/lib/yonder/captures/.mount-probe /prototype/var/log/journal/.mount-probe

# Exercise the exact one-shot state-journal request used by production. The
# static initramfs helper consumes it before exposing the real root writable;
# the following protected boot closes the operation and cannot stay writable.
maintenance_one=12345678-1234-4123-8123-123456789abc
run_maintenance_coordinator request "$maintenance_one"
sync
unmount_prototype
boot_mount maintenance
run_maintenance_coordinator entered "$maintenance_one"
install_maintenance_probe
printf '%s\n' persistent >/prototype/etc/.yonder-maintenance-probe
printf '%s\n' persistent >/prototype/home/.yonder-maintenance-probe
sync
unmount_prototype
boot_mount protected
run_maintenance_coordinator complete "$maintenance_one"
# shellcheck disable=SC2016 # dpkg-query expands its own ${Status} placeholder
# shellcheck disable=SC2016 # dpkg-query expands its own field placeholder
# shellcheck disable=SC2016 # dpkg-query expands its own field placeholder
[[ $(chroot /prototype dpkg-query -W -f='${Status}' yonder-maintenance-probe) == \
    'install ok installed' ]]
[[ $(< /prototype/usr/lib/yonder-maintenance-probe/installed) == persistent ]]
[[ $(< /prototype/etc/.yonder-maintenance-probe) == persistent ]]
[[ $(< /prototype/home/.yonder-maintenance-probe) == persistent ]]

maintenance_two=87654321-4321-4321-8321-cba987654321
run_maintenance_coordinator request "$maintenance_two"
sync
unmount_prototype
boot_mount maintenance
run_maintenance_coordinator entered "$maintenance_two"
chroot /prototype apt-get purge -y yonder-maintenance-probe >/dev/null
rm /prototype/etc/.yonder-maintenance-probe /prototype/home/.yonder-maintenance-probe
sync
unmount_prototype
boot_mount protected
run_maintenance_coordinator complete "$maintenance_two"
[[ ! -e /prototype/usr/lib/yonder-maintenance-probe ]]
if chroot /prototype dpkg-query -W yonder-maintenance-probe >/dev/null 2>&1; then
    exit 1
fi
rm -rf /prototype/var/lib/yonder-state/transactions \
    /prototype/var/lib/yonder-state/maintenance
# None of the disposable probe's identity may ship in the card image.
rm /prototype/var/lib/yonder-state/machine-id
if [[ $production == 0 ]]; then
    rm /prototype/var/lib/yonder-state/ssh/ssh_host_* \
        /prototype/var/lib/yonder-state/app/bench-first-boot.done
fi
mv /prototype/var/lib/yonder-state/seed-complete /prototype/var/lib/yonder-state/seed-test-held
sync
unmount_prototype
mount -o ro "$root_loop" /prototype
if /bin/sh /prototype/usr/lib/yonder/storage-prototype/mount-storage.sh /prototype; then
    echo 'FAIL: incomplete state seed booted as a new installation' >&2
    exit 1
fi
mv /prototype/var/lib/yonder-state/seed-test-held /prototype/var/lib/yonder-state/seed-complete
[[ ! -e /prototype/var/lib/yonder-state/machine-id ]]
sync
unmount_prototype
printf '%s\n' 'PASS: actual protected mounts, one-shot maintenance, persistent apt install/removal, durable coordinator bootstrap/commit/restart, separate state/log/media, persistent identity/data, volatile reset, and incomplete-state refusal.'
printf '%s\n' 'LIMIT: namespace mount test, not a board boot or electrical power-cut test.'
