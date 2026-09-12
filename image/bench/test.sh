#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Disposable ARM64 userland test for the private Radxa bench-rootfs helper.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${YONDER_BENCH_TEST_IMAGE:-debian:trixie}
container="yonder-bench-rootfs-test-$$"

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' 'error: docker is required for the disposable bench-rootfs test' >&2
    exit 1
}

cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker create --name "$container" --network none "$IMAGE" sleep infinity >/dev/null
docker cp "$HERE/." "$container:/tmp/yonder-bench/"
docker start "$container" >/dev/null

docker exec -i "$container" sh -eu <<'SETUP'
mkdir -p /boot /etc/ssh /etc/systemd/system /lib/systemd/system \
    /etc/default /etc/profile.d /etc/cron.d /etc/cron.daily /etc/armbian \
    /etc/yonder /var/lib/yonder/console /var/lib/dbus \
    /var/lib/zerotier-one /root/.ssh /run/yonder-bench-input
chmod 0700 /run/yonder-bench-input

printf '%s\n' 'BOARD=rock-5c' >/etc/armbian-release
printf '%s\n' 'fdtfile=rockchip/rk3588s-rock-5c.dtb' >/boot/armbianEnv.txt
cat >/etc/yonder/config.yaml <<'EOF'
network:
  ap:
    enabled: true
    ssid: yonder
    address: 192.168.77.1/24
ui:
  port: 3000
EOF
printf '%s\n' 'flowFile: setup-flows.json' >/var/lib/yonder/console/settings.js
printf '%s\n' '# test sudoers' '#includedir /etc/sudoers.d' >/etc/sudoers
printf '%s\n' '# upstream sshd config' >/etc/ssh/sshd_config
printf '%s\n' '[Unit]' >/lib/systemd/system/ssh.service
printf '%s\n' '[Unit]' >/lib/systemd/system/armbian-firstrun.service
printf '%s\n' '[Unit]' >/lib/systemd/system/armbian-resize-filesystem.service
printf '%s\n' '[Unit]' >/lib/systemd/system/armbian-ramlog.service
printf '%s\n' '[Unit]' >/lib/systemd/system/rsyslog.service
printf '%s\n' 'must not run' >/etc/profile.d/armbian-check-first-login.sh
printf '%s\n' 'must not run' >/etc/cron.daily/armbian-ramlog
printf '%s\n' 'ENABLED=true' 'SIZE=50M' >/etc/default/armbian-ramlog
printf '%s\n' 'ENABLED=true' 'SWAP=true' >/etc/default/armbian-zram-config
cat >/etc/cron.d/armbian-truncate-logs <<'EOF'
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
*/15 * * * * root /usr/lib/armbian/armbian-truncate-logs
@reboot root /usr/lib/armbian/armbian-truncate-logs
EOF
printf '%s\n' 'old-machine-id' >/etc/machine-id
printf '%s\n' 'old-host-key' >/etc/ssh/ssh_host_ed25519_key
printf '%s\n' 'old-builder-key' >/root/.ssh/authorized_keys
printf '%s\n' 'old-zt-identity' >/var/lib/zerotier-one/identity.secret
printf '%s\n' 'admin_password: should-cause-refusal-if-retained' >/etc/yonder/secrets.yaml.test-only
groupadd --system systemd-journal 2>/dev/null || true
groupadd --system yonder 2>/dev/null || true

cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
set -eu
op=$1
unit=${2:-}
case "$op" in
    disable) exit 0 ;;
    mask)
        rm -f "/etc/systemd/system/$unit"
        ln -s /dev/null "/etc/systemd/system/$unit"
        ;;
    enable)
        mkdir -p /etc/systemd/system/multi-user.target.wants
        source=/etc/systemd/system/$unit
        [ -e "$source" ] || source=/lib/systemd/system/$unit
        ln -sfn "$source" "/etc/systemd/system/multi-user.target.wants/$unit"
        ;;
    *) exit 1 ;;
esac
EOF
chmod 0755 /usr/bin/systemctl

cat >/usr/sbin/visudo <<'EOF'
#!/bin/sh
[ "$1" = -cf ] && [ -s "$2" ]
EOF
chmod 0755 /usr/sbin/visudo

cat >/usr/bin/sudo <<'EOF'
#!/bin/sh
# This fixture has no inherited NOPASSWD entitlement, but accepts stdin auth.
case " $* " in
    *' -n '*) exit 1 ;;
    *' -S '*) IFS= read -r password; [ "$password" = bench-test-password ] ;;
    *' -K '*) exit 0 ;;
    *) exit 1 ;;
esac
EOF
chmod 0755 /usr/bin/sudo

cat >/usr/sbin/sshd <<'EOF'
#!/bin/sh
case " $* " in
    *' -T '*)
        printf '%s\n' \
            'permitrootlogin no' \
            'passwordauthentication yes' \
            'pubkeyauthentication yes' \
            'allowusers yonder-bench'
        ;;
    *' -t '*)
        config=
        while [ "$#" -gt 0 ]; do
            [ "$1" = -f ] && { shift; config=$1; }
            shift
        done
        grep -q '^AllowUsers yonder-bench$' "$config"
        grep -q '^PermitRootLogin no$' "$config"
        ;;
    *) exit 1 ;;
esac
EOF
chmod 0755 /usr/sbin/sshd

cat >/usr/bin/ssh-keygen <<'EOF'
#!/bin/sh
case "$1" in
    -l)
        grep -q '^ssh-ed25519 ' "$3"
        ;;
    -A)
        printf '%s\n' 'new-private-host-key' >/etc/ssh/ssh_host_ed25519_key
        printf '%s\n' 'ssh-ed25519 generated-host-key' >/etc/ssh/ssh_host_ed25519_key.pub
        ;;
    *) exit 1 ;;
esac
EOF
chmod 0755 /usr/bin/ssh-keygen

cat >/usr/bin/systemd-machine-id-setup <<'EOF'
#!/bin/sh
printf '%s\n' '0123456789abcdef0123456789abcdef' >/etc/machine-id
EOF
chmod 0755 /usr/bin/systemd-machine-id-setup
SETUP

# Without the explicit flag there must be no mutation, including no cleanup.
docker exec -i "$container" sh -eu <<'NO_FLAG'
printf '%s\n' 'leave-this-alone' >/run/yonder-bench-input/password
chmod 0600 /run/yonder-bench-input/password
if /tmp/yonder-bench/prepare-rootfs.sh >/tmp/no-flag.out 2>&1; then
    exit 1
fi
[ -f /run/yonder-bench-input/password ]
! getent passwd yonder-bench >/dev/null
NO_FLAG

# A private-key-shaped input is rejected and provision files are still erased.
docker exec -i "$container" sh -eu <<'BAD_KEY'
printf '%s\n' 'bench-test-password' >/run/yonder-bench-input/password
printf '%s\n' '-----BEGIN OPENSSH PRIVATE KEY-----' \
    >/run/yonder-bench-input/authorized_key
chmod 0600 /run/yonder-bench-input/password /run/yonder-bench-input/authorized_key
if /tmp/yonder-bench/prepare-rootfs.sh --bench >/tmp/bad-key.out 2>&1; then
    exit 1
fi
[ ! -e /run/yonder-bench-input/password ]
[ ! -e /run/yonder-bench-input/authorized_key ]
! getent passwd yonder-bench >/dev/null
BAD_KEY

# Explicit target selection must reject a rootfs whose board/DTB markers name
# another board, and still erase provision inputs after the bench opt-in.
docker exec -i "$container" sh -eu <<'WRONG_TARGET'
printf '%s\n' 'bench-test-password' >/run/yonder-bench-input/password
chmod 0600 /run/yonder-bench-input/password
if /tmp/yonder-bench/prepare-rootfs.sh --bench --target radxa-zero3w \
        >/tmp/wrong-target.out 2>&1; then
    exit 1
fi
grep -q 'exact ZERO 3W board and DTB markers' /tmp/wrong-target.out
[ ! -e /run/yonder-bench-input/password ]
! getent passwd yonder-bench >/dev/null

printf '%s\n' 'fdtfile=rockchip/rk3566-radxa-zero3.dtb' >/boot/armbianEnv.txt
printf '%s\n' 'bench-test-password' >/run/yonder-bench-input/password
chmod 0600 /run/yonder-bench-input/password
if /tmp/yonder-bench/prepare-rootfs.sh --bench --target radxa-rock5c \
        >/tmp/mixed-markers.out 2>&1; then
    exit 1
fi
grep -q 'exact ROCK 5C board and DTB markers' /tmp/mixed-markers.out
[ ! -e /run/yonder-bench-input/password ]
printf '%s\n' 'fdtfile=rockchip/rk3588s-rock-5c.dtb' >/boot/armbianEnv.txt
WRONG_TARGET

docker exec -i "$container" sh -eu <<'PREPARE'
printf '%s\n' 'bench-test-password' >/run/yonder-bench-input/password
printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly yonder-test' \
    >/run/yonder-bench-input/authorized_key
chmod 0600 /run/yonder-bench-input/password /run/yonder-bench-input/authorized_key
/tmp/yonder-bench/prepare-rootfs.sh --bench
PREPARE

docker exec -i "$container" sh -eu <<'ASSERT_PREPARED'
record=$(getent passwd yonder-bench)
[ "$(printf '%s\n' "$record" | cut -d: -f6)" = /home/yonder-bench ]
[ "$(printf '%s\n' "$record" | cut -d: -f7)" = /bin/bash ]
id -nG yonder-bench | tr ' ' '\n' | grep -qx sudo
shadow=$(getent shadow yonder-bench | cut -d: -f2)
[ -n "$shadow" ]
case "$shadow" in '!'*|'*'*) exit 1 ;; esac
! printf '%s\n' "$shadow" | grep -q 'bench-test-password'
case "$(getent shadow root | cut -d: -f2)" in '!'*) ;; *) exit 1 ;; esac

[ "$(stat -c %a /etc/sudoers.d/zz-yonder-bench)" = 440 ]
grep -qx 'yonder-bench ALL=(ALL:ALL) PASSWD: ALL' \
    /etc/sudoers.d/zz-yonder-bench
grep -qx 'AllowUsers yonder-bench' /etc/ssh/sshd_config
grep -qx 'PermitRootLogin no' /etc/ssh/sshd_config
grep -qx 'PasswordAuthentication yes' /etc/ssh/sshd_config
grep -qx 'PubkeyAuthentication yes' /etc/ssh/sshd_config
[ "$(stat -c %a /home/yonder-bench/.ssh/authorized_keys)" = 600 ]

grep -qx 'writable_root=true' /etc/yonder/bench-image
grep -qx 'target=radxa-rock5c' /etc/yonder/bench-image
grep -qx 'protected_storage=false' /etc/yonder/bench-image
grep -qx 'hardware_qualified=false' /etc/yonder/bench-image
grep -qx 'csi_adapter_installed=false' /etc/yonder/bench-image
grep -qx 'SystemMaxUse=64M' /etc/systemd/journald.conf.d/60-yonder-bench.conf
grep -qx 'SyncIntervalSec=10s' /etc/systemd/journald.conf.d/60-yonder-bench.conf

for unit in armbian-firstrun.service armbian-resize-filesystem.service \
        armbian-ramlog.service rsyslog.service; do
    [ "$(readlink "/etc/systemd/system/$unit")" = /dev/null ]
done
[ -f /etc/profile.d/armbian-check-first-login.sh.yonder-bench-disabled ]
[ -f /etc/cron.daily/armbian-ramlog.yonder-bench-disabled ]
grep -qx 'ENABLED=false' /etc/default/armbian-ramlog
grep -qx 'SIZE=50M' /etc/default/armbian-ramlog
grep -qx 'ENABLED=true' /etc/default/armbian-zram-config
grep -qx 'SWAP=true' /etc/default/armbian-zram-config
[ -f /etc/cron.d/armbian-truncate-logs.yonder-bench-disabled ]
[ ! -e /etc/cron.d/armbian-truncate-logs ]
[ ! -e /run/yonder-bench-input/password ]
[ ! -e /run/yonder-bench-input/authorized_key ]
[ ! -s /etc/machine-id ]
[ ! -e /etc/ssh/ssh_host_ed25519_key ]
[ ! -e /root/.ssh/authorized_keys ]
[ ! -e /var/lib/zerotier-one/identity.secret ]
[ -L /etc/systemd/system/multi-user.target.wants/yonder-bench-first-boot.service ]
[ -L /etc/systemd/system/multi-user.target.wants/ssh.service ]

grep -q 'ssid: yonder' /etc/yonder/config.yaml
grep -q 'address: 192.168.77.1/24' /etc/yonder/config.yaml
grep -q 'port: 3000' /etc/yonder/config.yaml
grep -qx 'fdtfile=rockchip/rk3588s-rock-5c.dtb' /boot/armbianEnv.txt
ASSERT_PREPARED

# The optional key may be omitted on a repeat run; the managed account remains
# singular and the old key is removed rather than silently retained.
docker exec -i "$container" sh -eu <<'REPEAT_WITHOUT_KEY'
printf '%s\n' 'bench-test-password' >/run/yonder-bench-input/password
chmod 0600 /run/yonder-bench-input/password
/tmp/yonder-bench/prepare-rootfs.sh --bench
[ ! -e /home/yonder-bench/.ssh/authorized_keys ]
[ "$(getent passwd yonder-bench | wc -l)" -eq 1 ]
[ ! -e /run/yonder-bench-input/password ]
REPEAT_WITHOUT_KEY

docker exec "$container" chown root:systemd-journal /var/lib/yonder
docker exec "$container" /usr/local/sbin/yonder-bench-first-boot
docker exec -i "$container" sh -eu <<'ASSERT_FIRST_BOOT'
grep -qx '0123456789abcdef0123456789abcdef' /etc/machine-id
[ -f /etc/ssh/ssh_host_ed25519_key ]
[ "$(stat -c %a /etc/ssh/ssh_host_ed25519_key)" = 600 ]
[ "$(stat -c %a /etc/ssh/ssh_host_ed25519_key.pub)" = 644 ]
[ -f /var/lib/yonder/bench-first-boot.done ]
[ "$(stat -c %U:%G /var/lib/yonder)" = root:yonder ]
before=$(sha256sum /etc/ssh/ssh_host_ed25519_key)
/usr/local/sbin/yonder-bench-first-boot
[ "$before" = "$(sha256sum /etc/ssh/ssh_host_ed25519_key)" ]
ASSERT_FIRST_BOOT

# The explicit ZERO 3W path accepts only its exact markers and records the
# selected target without enabling any camera overlay in the helper.
docker exec -i "$container" sh -eu <<'PREPARE_ZERO'
userdel -r yonder-bench
rm -f /etc/yonder/bench-image
printf '%s\n' 'BOARD=radxa-zero3' >/etc/armbian-release
printf '%s\n' 'fdtfile=rockchip/rk3566-radxa-zero3.dtb' >/boot/armbianEnv.txt
printf '%s\n' 'bench-test-password' >/run/yonder-bench-input/password
chmod 0600 /run/yonder-bench-input/password
/tmp/yonder-bench/prepare-rootfs.sh --bench --target radxa-zero3w
grep -qx 'target=radxa-zero3w' /etc/yonder/bench-image
grep -qx 'fdtfile=rockchip/rk3566-radxa-zero3.dtb' /boot/armbianEnv.txt
! grep -Eq '^(overlays|user_overlays)=' /boot/armbianEnv.txt
[ ! -e /run/yonder-bench-input/password ]
PREPARE_ZERO

printf '%s\n' 'bench-rootfs disposable container checks passed'
