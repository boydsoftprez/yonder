#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Verify a production root before seeding, or initialize and verify protected state.
set -eu
umask 077

die() { printf 'image-finalize verification: %s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: verify-finalized.sh --rootfs|--protected --target rpi|radxa-zero3w|radxa-rock5c' >&2; exit 2; }

[ "$#" -eq 3 ] || usage
phase=$1
[ "$2" = --target ] || usage
target=$3
case "$phase" in --rootfs|--protected) ;; *) usage ;; esac
case "$target" in rpi|radxa-zero3w|radxa-rock5c) ;; *) usage ;; esac
[ "$(id -u)" = 0 ] || die 'root is required'

[ -f /etc/yonder/config.yaml ] && [ ! -L /etc/yonder/config.yaml ] \
    || die 'factory configuration is missing'
cmp /opt/yonder-src/config/defaults/config.yaml /etc/yonder/config.yaml \
    || die 'factory configuration differs from the shipped default'
[ -f /etc/yonder/secrets.yaml ] && [ ! -L /etc/yonder/secrets.yaml ] \
    && [ ! -s /etc/yonder/secrets.yaml ] \
    && [ "$(stat -c '%u:%g:%a' /etc/yonder/secrets.yaml)" = 0:0:600 ] \
    || die 'factory secret bag is not an empty root-private file'
[ ! -e /etc/yonder/bench-image ] || die 'private-test marker remains'
[ ! -e /usr/local/sbin/yonder-bench-first-boot ] || die 'private-test first-boot helper remains'
! getent passwd yonder-bench >/dev/null 2>&1 || die 'private-test account remains'
if awk -F: '$3 >= 1000 && $3 < 60000 { print $1 }' /etc/passwd | grep -q .; then
    die 'an owner account already exists'
fi
case "$(getent shadow root | cut -d: -f2)" in '!'*|'*'*) ;; *) die 'root login is not locked' ;; esac
[ ! -s /etc/machine-id ] || die 'machine identity remains'
set -- /etc/ssh/ssh_host_*_key
[ ! -e "$1" ] || die 'SSH host identity remains'
if find /root /home -type f -name authorized_keys -print -quit 2>/dev/null | grep -q .; then
    die 'authorized access key remains'
fi
for credential in /var/lib/zerotier-one/identity.secret \
        /var/lib/zerotier-one/authtoken.secret; do
    [ ! -e "$credential" ] || die 'mesh credential remains'
done
[ -z "$(find /etc/NetworkManager/system-connections -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] \
    || die 'NetworkManager connection remains'
[ -z "$(find /var/log -mindepth 1 ! -path /var/log/journal -print -quit 2>/dev/null)" ] \
    || die 'build log remains'

case "$target" in
    rpi)
        ! grep -Eq '(^|[[:space:]])resize([[:space:]]|$)' /boot/firmware/cmdline.txt \
            || die 'Raspberry Pi resize token remains'
        [ -e /etc/cloud/cloud-init.disabled ] || die 'cloud-init is not disabled'
        ;;
    radxa-zero3w|radxa-rock5c)
        [ "$(readlink /etc/systemd/system/armbian-resize-filesystem.service)" = /dev/null ] \
            || die 'Armbian root growth is not masked'
        ;;
esac

[ "$phase" = --protected ] || exit 0
[ -f /etc/yonder-storage-layout.conf ] && [ ! -L /etc/yonder-storage-layout.conf ] \
    && [ "$(stat -c '%u:%g:%a' /etc/yonder-storage-layout.conf)" = 0:0:644 ] \
    || die 'production storage marker is missing'
mountpoint -q /var/lib/yonder-state || die 'durable state is not a construction mount'
[ ! -e /var/lib/yonder-state/transactions ] || die 'durable state was initialized before final verification'
[ -x /usr/local/bin/yonder-node ] \
    && [ -f /opt/yonder/packages/yonder-core/dist/state/coordinator.js ] \
    || die 'installed state coordinator is missing'

script=/tmp/yonder-factory-state.$$.mjs
cleanup() { rm -f "$script"; }
trap cleanup EXIT HUP INT TERM
cat >"$script" <<'EOF'
import { readFileSync } from "node:fs";
import { DurableStateCoordinator } from "/opt/yonder/packages/yonder-core/dist/state/coordinator.js";
import { assertManagedStateMount, loadConventionalState } from "/opt/yonder/packages/yonder-core/dist/state/recover.js";

const expected = loadConventionalState({ configPath: "/etc/yonder/config.yaml", secretsPath: "/etc/yonder/secrets.yaml" });
const coordinator = new DurableStateCoordinator({
  root: "/var/lib/yonder-state/transactions",
  configPath: "/etc/yonder/config.yaml",
  secretsPath: "/etc/yonder/secrets.yaml",
  bootstrap: async () => structuredClone(expected),
  projectors: [],
  assertStorage: () => assertManagedStateMount({
    stateRoot: "/var/lib/yonder-state",
    markerPath: "/etc/yonder-storage-layout.conf",
    mountInfoPath: "/proc/self/mountinfo",
  }),
});
const recovered = await coordinator.recover();
if (recovered.action !== "none") throw new Error("factory state required recovery");
const active = await coordinator.readActiveState();
if (JSON.stringify(active.state) !== JSON.stringify(expected)) throw new Error("factory generation differs from factory files");
if (active.state.linuxOwner !== null || active.state.zeroTier !== null
    || Object.keys(active.state.secrets).length !== 0) throw new Error("factory generation contains identity state");
if ((await coordinator.status()).operation !== null) throw new Error("factory generation has an operation");
const onDisk = readFileSync(`/var/lib/yonder-state/transactions/generations/${active.generation}/state.json`, "utf8");
for (const forbidden of ["passwordHash", "identitySecret", "authorizedKeys"]) {
  if (onDisk.includes(forbidden)) throw new Error("factory generation contains credential fields");
}
EOF
/usr/local/bin/yonder-node "$script"
cleanup
trap - EXIT HUP INT TERM
[ ! -e /var/lib/yonder-state/machine-id ] || die 'machine identity was seeded'
set -- /var/lib/yonder-state/ssh/ssh_host_*_key
[ ! -e "$1" ] || die 'SSH host identity was seeded'
[ -f /var/lib/yonder-state/seed-complete ] || die 'protected state seed is incomplete'
[ -f /var/lib/yonder-state/transactions/active.json ] \
    && [ ! -e /var/lib/yonder-state/transactions/operation.json ] \
    || die 'factory generation is not clean'
printf 'image-finalize verification: %s protected factory state passed\n' "$target"
