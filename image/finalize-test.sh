#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Disposable ARM64 Linux fixture for production image identity cleanup.
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
container=yonder-finalize-test-$$
image=debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

command -v docker >/dev/null
[[ $(docker info --format '{{.OSType}}') == linux ]]
docker run -d --name "$container" --platform linux/arm64 "$image" sleep infinity >/dev/null
docker exec "$container" sh -c \
    'apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server passwd systemd >/dev/null'
docker exec "$container" mkdir -p /opt/yonder-src/image /opt/yonder-src/config/defaults
docker cp "$here/finalize.sh" "$container:/opt/yonder-src/image/finalize.sh"
docker cp "$here/verify-finalized.sh" "$container:/opt/yonder-src/image/verify-finalized.sh"
docker cp "$here/../config/defaults/config.yaml" \
    "$container:/opt/yonder-src/config/defaults/config.yaml"

docker exec -i "$container" /bin/bash -s <<'FIXTURE'
set -euo pipefail
install -d -m 0750 /etc/yonder
cp /opt/yonder-src/config/defaults/config.yaml /etc/yonder/config.yaml
printf '%s\n' private >/etc/yonder/secrets.yaml
chmod 0600 /etc/yonder/secrets.yaml
printf '%s\n' 'Raspberry Pi fixture' >/etc/rpi-issue
install -d -m 0755 /boot/firmware /etc/NetworkManager/system-connections \
    /var/lib/NetworkManager /var/lib/zerotier-one/networks.d \
    /var/lib/yonder-state/transactions /var/lib/yonder/console/context \
    /var/lib/cloud /var/lib/dbus /root/.ssh /run/yonder-bench-input
printf '%s\n' 'console=tty1 root=PARTUUID=041bba91-02 rootwait resize' \
    >/boot/firmware/cmdline.txt
printf '%s\n' private >/etc/NetworkManager/system-connections/operator.nmconnection
printf '%s\n' private >/var/lib/NetworkManager/secret_key
printf '%s\n' private >/var/lib/zerotier-one/identity.secret
printf '%s\n' private >/var/lib/zerotier-one/networks.d/fixture.conf
printf '%s\n' private >/var/lib/yonder-state/transactions/state
printf '%s\n' private >/var/lib/yonder/console/context/state
printf '%s\n' private >/var/lib/cloud/instance
printf '%s\n' private >/root/.ssh/authorized_keys
printf '%s\n' private >/etc/yonder/bench-image
printf '%s\n' private >/run/yonder-bench-input/password
printf '%s\n' private >/var/log/build.log
printf '%s\n' private >/var/cache/build-cache
printf '%s\n' 0123456789abcdef0123456789abcdef >/etc/machine-id
printf '%s\n' private >/var/lib/dbus/machine-id
rm -f /etc/ssh/ssh_host_*
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
useradd --create-home --shell /bin/bash yonder-bench
printf '%s\n' yonder-bench:fixture | chpasswd
printf '%s\n' '#!/bin/sh' >/usr/local/sbin/yonder-bench-first-boot
chmod 0755 /usr/local/sbin/yonder-bench-first-boot

/opt/yonder-src/image/finalize.sh --target rpi
/opt/yonder-src/image/finalize.sh --target rpi
/opt/yonder-src/image/verify-finalized.sh --rootfs --target rpi

[[ ! -e /etc/yonder/bench-image && ! -e /run/yonder-bench-input ]]
[[ ! -e /root/.ssh/authorized_keys && ! -e /etc/ssh/ssh_host_ed25519_key ]]
[[ ! -e /var/lib/zerotier-one/identity.secret ]]
[[ ! -e /var/lib/yonder-state/transactions ]]
[[ ! -e /etc/NetworkManager/system-connections/operator.nmconnection ]]
[[ ! -e /var/lib/NetworkManager/secret_key ]]
[[ ! -e /var/lib/cloud/instance ]]
[[ ! -s /etc/machine-id ]]
[[ -f /etc/yonder/secrets.yaml && ! -s /etc/yonder/secrets.yaml ]]
[[ $(stat -c %a /etc/yonder/secrets.yaml) == 600 ]]
! getent passwd yonder-bench >/dev/null
! grep -Eq '(^|[[:space:]])resize([[:space:]]|$)' /boot/firmware/cmdline.txt

# The factory-config check happens before identity cleanup.
printf '%s\n' changed >>/etc/yonder/config.yaml
printf '%s\n' must-remain >/etc/machine-id
if /opt/yonder-src/image/finalize.sh --target rpi >/tmp/rejected.out 2>&1; then
    exit 1
fi
grep -q 'installed configuration is not the factory default' /tmp/rejected.out
grep -qx must-remain /etc/machine-id

# Exercise the separate Armbian first-use and root-growth retirement branch.
cp /opt/yonder-src/config/defaults/config.yaml /etc/yonder/config.yaml
: >/etc/machine-id
printf '%s\n' 'BOARD_NAME=fixture' >/etc/armbian-release
printf '%s\n' 'verbosity=1' >/boot/armbianEnv.txt
install -d -m 0755 /etc/armbian /etc/profile.d
printf '%s\n' '# fixture first login' >/etc/profile.d/armbian-check-first-login.sh
printf '%s\n' pending >/root/.not_logged_in_yet
printf '%s\n' pending >/etc/armbian/first_run.txt
/opt/yonder-src/image/finalize.sh --target radxa-zero3w
/opt/yonder-src/image/finalize.sh --target radxa-zero3w
/opt/yonder-src/image/verify-finalized.sh --rootfs --target radxa-zero3w
[[ $(readlink /etc/systemd/system/armbian-resize-filesystem.service) == /dev/null ]]
[[ -f /usr/lib/yonder/disabled-first-use/armbian-check-first-login.sh ]]
[[ ! -e /root/.not_logged_in_yet && ! -e /etc/armbian/first_run.txt ]]
FIXTURE

printf '%s\n' 'PASS: Pi and Radxa production finalization removed real account, identity, network, mesh, state, log and cache fixtures.'
