#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Private, writable Radxa bench-image preparation. Run inside the target chroot.
set +x
set -eu
umask 077

BENCH_USER=yonder-bench
INPUT_DIR=/run/yonder-bench-input
PASSWORD_FILE=$INPUT_DIR/password
AUTHORIZED_KEY_FILE=$INPUT_DIR/authorized_key
MARKER=/etc/yonder/bench-image
TARGET=radxa-rock5c

usage() {
    printf '%s\n' 'Usage: prepare-rootfs.sh --bench [--target radxa-zero3w|radxa-rock5c]' >&2
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

log() {
    printf 'bench-rootfs: %s\n' "$*"
}

case "$#:${1:-}:${2:-}:${3:-}" in
    1:--bench::) ;;
    3:--bench:--target:radxa-zero3w) TARGET=radxa-zero3w ;;
    3:--bench:--target:radxa-rock5c) ;;
    *) usage; exit 2 ;;
esac

# From this point onward the invocation is explicitly authorized as a bench
# build. Destroy both possible provision inputs on success or failure.
cleanup_inputs() {
    rm -f -- "$PASSWORD_FILE" "$AUTHORIZED_KEY_FILE"
}
trap cleanup_inputs EXIT
trap 'exit 1' HUP INT TERM

[ "$(id -u)" = 0 ] || die 'must run as root inside the target chroot'
[ "$(dpkg --print-architecture)" = arm64 ] \
    || die 'target rootfs is not Debian ARM64'
[ -f /etc/armbian-release ] || die 'target rootfs is not Armbian'
[ -f /boot/armbianEnv.txt ] || die 'target rootfs has no Armbian boot environment'
board=$(awk -F= '$1 == "BOARD" { print substr($0, length($1) + 2) }' \
    /etc/armbian-release)
fdtfile=$(awk -F= '$1 == "fdtfile" { print substr($0, length($1) + 2) }' \
    /boot/armbianEnv.txt)
case "$TARGET" in
    radxa-zero3w)
        [ "$board" = radxa-zero3 ] \
            && [ "$fdtfile" = rockchip/rk3566-radxa-zero3.dtb ] \
            || die 'target rootfs does not carry the exact ZERO 3W board and DTB markers'
        target_label='Radxa ZERO 3W'
        ssh_host=zero3w
        ;;
    radxa-rock5c)
        [ "$board" = rock-5c ] \
            && [ "$fdtfile" = rockchip/rk3588s-rock-5c.dtb ] \
            || die 'target rootfs does not carry the exact ROCK 5C board and DTB markers'
        target_label='ROCK 5C'
        ssh_host=rock5c
        ;;
esac

for required in \
        /usr/sbin/useradd /usr/sbin/usermod /usr/sbin/chpasswd \
        /usr/sbin/visudo /usr/bin/sudo /bin/su \
        /usr/sbin/sshd /usr/bin/ssh-keygen /usr/bin/systemctl \
        /usr/bin/systemd-machine-id-setup; do
    [ -x "$required" ] || die "required target tool is missing: $required"
done
for required_path in /etc/passwd /etc/group /etc/sudoers \
        /etc/ssh/sshd_config /etc/systemd/system; do
    [ -e "$required_path" ] || die "required target path is missing: $required_path"
done

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ -f "$script_dir/first-boot.sh" ] \
    || die 'first-boot.sh must be beside prepare-rootfs.sh'

check_private_input() {
    input=$1
    [ -f "$input" ] && [ ! -L "$input" ] \
        || die "$input must be a regular file, not a link"
    [ "$(stat -c %u "$input")" = 0 ] || die "$input must be owned by root"
    input_mode=$(stat -c %a "$input")
    [ $((0$input_mode & 077)) -eq 0 ] \
        || die "$input must not be accessible by group or other users"
}

[ -d "$INPUT_DIR" ] && [ ! -L "$INPUT_DIR" ] \
    || die "$INPUT_DIR must be a directory, not a link"
[ "$(stat -c %u "$INPUT_DIR")" = 0 ] || die "$INPUT_DIR must be owned by root"
input_dir_mode=$(stat -c %a "$INPUT_DIR")
[ $((0$input_dir_mode & 077)) -eq 0 ] \
    || die "$INPUT_DIR must not be accessible by group or other users"
check_private_input "$PASSWORD_FILE"
password_bytes=$(wc -c <"$PASSWORD_FILE")
[ "$password_bytes" -gt 0 ] && [ "$password_bytes" -le 1024 ] \
    || die 'bench password must contain 1 to 1024 bytes'
[ "$(awk 'END { print NR }' "$PASSWORD_FILE")" -eq 1 ] \
    || die 'bench password must be exactly one line'
password=$(sed -n '1p' "$PASSWORD_FILE")
[ -n "$password" ] || die 'bench password must not be empty'
case "$password" in
    *:*) die 'bench password must not contain a colon' ;;
esac

have_authorized_key=0
if [ -e "$AUTHORIZED_KEY_FILE" ]; then
    check_private_input "$AUTHORIZED_KEY_FILE"
    [ "$(awk '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' \
        "$AUTHORIZED_KEY_FILE")" -eq 1 ] \
        || die 'authorized_key must contain exactly one public key'
    ! grep -q 'PRIVATE KEY' "$AUTHORIZED_KEY_FILE" \
        || die 'authorized_key contains private-key material'
    /usr/bin/ssh-keygen -l -f "$AUTHORIZED_KEY_FILE" >/dev/null 2>&1 \
        || die 'authorized_key is not accepted by ssh-keygen'
    have_authorized_key=1
fi

# Preserve the application-owned first-use path. The helper does not create a
# NetworkManager profile or change Yonder's declarative network configuration.
[ -f /etc/yonder/config.yaml ] || die 'the main installer did not seed Yonder config'
grep -q '^[[:space:]]*ssid: yonder$' /etc/yonder/config.yaml \
    || die 'Yonder default AP SSID is not present'
grep -q '^[[:space:]]*address: 192\.168\.77\.1/24$' /etc/yonder/config.yaml \
    || die 'Yonder default AP address is not present'
grep -q '^[[:space:]]*port: 3000$' /etc/yonder/config.yaml \
    || die 'Yonder console port 3000 is not present'
if [ -f /etc/yonder/secrets.yaml ] \
        && grep -q '^admin_password:' /etc/yonder/secrets.yaml; then
    die 'target contains an administrator password; refusing to image it'
fi
grep -q 'setup-flows\.json' /var/lib/yonder/console/settings.js \
    || die 'the installed console is not at the first-administrator-password gate'

if getent passwd "$BENCH_USER" >/dev/null 2>&1; then
    [ -f "$MARKER" ] || die "unexpected pre-existing account: $BENCH_USER"
    grep -qx "target=$TARGET" "$MARKER" \
        || die "existing bench account belongs to a different target"
    account_record=$(getent passwd "$BENCH_USER")
    account_home=$(printf '%s\n' "$account_record" | cut -d: -f6)
    account_shell=$(printf '%s\n' "$account_record" | cut -d: -f7)
    [ "$account_home" = "/home/$BENCH_USER" ] \
        || die "$BENCH_USER has an unexpected home directory"
    [ "$account_shell" = /bin/bash ] \
        || die "$BENCH_USER has an unexpected login shell"
    log "updating the existing managed $BENCH_USER account"
else
    log "creating the private bench account"
    /usr/sbin/useradd --create-home --shell /bin/bash \
        --comment "Yonder $target_label bench" "$BENCH_USER"
fi

/usr/sbin/usermod --append --groups sudo "$BENCH_USER"
printf '%s:%s\n' "$BENCH_USER" "$password" | /usr/sbin/chpasswd
/usr/sbin/usermod --lock root

bench_home=/home/$BENCH_USER
install -d -m 0700 -o "$BENCH_USER" -g "$BENCH_USER" "$bench_home/.ssh"
if [ "$have_authorized_key" = 1 ]; then
    key_tmp="$bench_home/.ssh/authorized_keys.new"
    install -m 0600 -o "$BENCH_USER" -g "$BENCH_USER" \
        "$AUTHORIZED_KEY_FILE" "$key_tmp"
    mv "$key_tmp" "$bench_home/.ssh/authorized_keys"
else
    rm -f "$bench_home/.ssh/authorized_keys"
fi

# A user-specific PASSWD tag, in the final included file, overrides any
# Armbian image-wide NOPASSWD grant inherited through the sudo group. Validate
# the complete policy and then test the actual account without a credential.
sudoers_file=/etc/sudoers.d/zz-yonder-bench
install -d -m 0750 /etc/sudoers.d
sudoers_tmp="$sudoers_file.new"
printf '%s ALL=(ALL:ALL) PASSWD: ALL\n' "$BENCH_USER" >"$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
/usr/sbin/visudo -cf /etc/sudoers >/dev/null
mv "$sudoers_tmp" "$sudoers_file"
/usr/sbin/visudo -cf /etc/sudoers >/dev/null \
    || die 'the installed sudo policy is invalid'

nopasswd_sources=$(
    grep -El '^[[:space:]]*(%sudo|yonder-bench)[[:space:]].*NOPASSWD' \
        /etc/sudoers /etc/sudoers.d/* 2>/dev/null || true
)
if [ -n "$nopasswd_sources" ]; then
    log 'an inherited NOPASSWD rule exists; checking that the later account rule wins'
fi
if /bin/su -s /bin/sh -c \
        'SUDO_ASKPASS=/bin/false /usr/bin/sudo -n -u root true >/dev/null 2>&1' \
        "$BENCH_USER"; then
    die "$BENCH_USER can use sudo without its password"
fi
if ! printf '%s\n' "$password" | /bin/su -s /bin/sh -c \
        '/usr/bin/sudo -S -p "" -u root true >/dev/null 2>&1' "$BENCH_USER"; then
    die "$BENCH_USER cannot use sudo with its password"
fi
/bin/su -s /bin/sh -c '/usr/bin/sudo -K' "$BENCH_USER" >/dev/null 2>&1 || true
password=''

# Use a complete, narrow bench sshd configuration so vendor drop-ins cannot
# widen access after this script has inspected the effective settings.
sshd_config=/etc/ssh/sshd_config
sshd_tmp=$sshd_config.new
cat >"$sshd_tmp" <<'EOF'
# Yonder private Radxa bench SSH policy.
Port 22
UsePAM yes
PermitRootLogin no
PermitEmptyPasswords no
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers yonder-bench
X11Forwarding no
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp internal-sftp
EOF
chmod 0600 "$sshd_tmp"
/usr/sbin/sshd -t -f "$sshd_tmp"
mv "$sshd_tmp" "$sshd_config"

effective_ssh=$(/usr/sbin/sshd -T -f "$sshd_config" \
    -C "user=$BENCH_USER,host=$ssh_host,addr=127.0.0.1")
ssh_value() {
    printf '%s\n' "$effective_ssh" | awk -v key="$1" '$1 == key { print $2; exit }'
}
[ "$(ssh_value permitrootlogin)" = no ] || die 'effective SSH policy permits root login'
[ "$(ssh_value passwordauthentication)" = yes ] \
    || die 'effective SSH policy does not permit the bench password'
[ "$(ssh_value pubkeyauthentication)" = yes ] \
    || die 'effective SSH policy does not permit public keys'
[ "$(ssh_value allowusers)" = "$BENCH_USER" ] \
    || die 'effective SSH policy permits an account other than yonder-bench'

# Retire only the known competing Armbian first-use and log-copy mechanisms.
# Masking is persistent and avoids starting/stopping anything in this chroot.
for unit in armbian-firstrun.service armbian-firstrun-config.service \
        armbian-resize-filesystem.service armbian-ramlog.service rsyslog.service; do
    /usr/bin/systemctl disable "$unit" >/dev/null 2>&1 || true
    /usr/bin/systemctl mask "$unit" >/dev/null
done

for profile in /etc/profile.d/armbian-check-first-login*.sh \
        /etc/profile.d/armbian-firstlogin*.sh; do
    [ -f "$profile" ] || continue
    mv "$profile" "$profile.yonder-bench-disabled"
done
for cron_job in /etc/cron.d/armbian-ramlog /etc/cron.daily/armbian-ramlog \
        /etc/cron.d/armbian-truncate-logs \
        /etc/cron.daily/armbian-truncate-logs \
        /etc/cron.hourly/armbian-truncate-logs \
        /etc/cron.weekly/armbian-truncate-logs \
        /etc/cron.monthly/armbian-truncate-logs; do
    [ -e "$cron_job" ] || continue
    mv "$cron_job" "$cron_job.yonder-bench-disabled"
done
rm -f /root/.not_logged_in_yet /etc/armbian/first_run.txt

# A single bounded persistent journal is the bench diagnostic record. The
# writable root means this is not isolated from OS capacity and is not a
# protected-storage implementation.
ramlog_config=/etc/default/armbian-ramlog
if [ -f "$ramlog_config" ]; then
    if grep -q '^ENABLED=' "$ramlog_config"; then
        sed -i 's/^ENABLED=.*/ENABLED=false/' "$ramlog_config"
    else
        printf '%s\n' 'ENABLED=false' >>"$ramlog_config"
    fi
fi
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/60-yonder-bench.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=64M
SystemKeepFree=128M
SystemMaxFileSize=8M
RuntimeMaxUse=16M
SyncIntervalSec=10s
MaxLevelStore=debug
EOF
chmod 0644 /etc/systemd/journald.conf.d/60-yonder-bench.conf
install -d -m 2755 -o root -g systemd-journal /var/log/journal

# Remove builder/upstream identities. The first-boot unit recreates only the
# machine and SSH identities; Yonder and ZeroTier create their own state when
# their existing configuration paths call for it.
rm -f /etc/ssh/ssh_host_* /var/lib/systemd/random-seed
rm -f /var/lib/dbus/machine-id
rm -f /var/lib/yonder/bench-first-boot.done
: >/etc/machine-id
chmod 0444 /etc/machine-id
rm -f /root/.ssh/authorized_keys /etc/yonder/secrets.yaml
# No credential values ship; the helper imports this explicit empty factory bag.
install -m 0600 /dev/null /etc/yonder/secrets.yaml
rm -f /var/lib/zerotier-one/identity.public \
    /var/lib/zerotier-one/identity.secret \
    /var/lib/zerotier-one/authtoken.secret

install -m 0755 "$script_dir/first-boot.sh" \
    /usr/local/sbin/yonder-bench-first-boot
cat >/etc/systemd/system/yonder-bench-first-boot.service <<'EOF'
[Unit]
Description=Create unique identities for the Yonder private bench image
After=systemd-machine-id-commit.service systemd-random-seed.service
Before=ssh.service
ConditionPathExists=!/var/lib/yonder/bench-first-boot.done

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/yonder-bench-first-boot
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/yonder-bench-first-boot.service
install -d -m 0755 /etc/systemd/system/ssh.service.d
cat >/etc/systemd/system/ssh.service.d/yonder-bench-first-boot.conf <<'EOF'
[Unit]
Requires=yonder-bench-first-boot.service
After=yonder-bench-first-boot.service
EOF
chmod 0644 /etc/systemd/system/ssh.service.d/yonder-bench-first-boot.conf

/usr/bin/systemctl enable yonder-bench-first-boot.service >/dev/null
/usr/bin/systemctl enable ssh.service >/dev/null

install -d -m 0750 /etc/yonder
marker_tmp=$MARKER.new
cat >"$marker_tmp" <<EOF
kind=private-radxa-bench
target=$TARGET
writable_root=true
protected_storage=false
hardware_qualified=false
csi_adapter_installed=false
EOF
chmod 0644 "$marker_tmp"
mv "$marker_tmp" "$MARKER"

[ ! -e /etc/systemd/system/armbian-firstrun.service ] \
    || [ "$(readlink /etc/systemd/system/armbian-firstrun.service)" = /dev/null ] \
    || die 'Armbian first-run service is not masked'
[ ! -s /etc/machine-id ] || die 'builder machine identity remains in the image'
set -- /etc/ssh/ssh_host_*_key
[ ! -e "$1" ] || die 'builder SSH host keys remain in the image'
[ -f /etc/yonder/secrets.yaml ] && [ ! -s /etc/yonder/secrets.yaml ] \
    || die 'builder Yonder secrets remain in the image'
grep -q '^hardware_qualified=false$' "$MARKER" \
    || die 'bench qualification marker is missing'
[ ! -f "$ramlog_config" ] || grep -qx 'ENABLED=false' "$ramlog_config" \
    || die 'Armbian ramlog is still enabled'
for cron_job in /etc/crontab /etc/cron.d/* /etc/cron.daily/* \
        /etc/cron.hourly/* /etc/cron.weekly/* /etc/cron.monthly/*; do
    [ -f "$cron_job" ] || continue
    case "$cron_job" in *.yonder-bench-disabled) continue ;; esac
    ! grep -Fq -- '/usr/lib/armbian/armbian-truncate-logs' "$cron_job" \
        || die 'an active cron job can still relinquish the persistent journal'
done

cleanup_inputs
[ ! -e "$PASSWORD_FILE" ] && [ ! -e "$AUTHORIZED_KEY_FILE" ] \
    || die 'could not remove the bench provision inputs'
log "prepared private writable $target_label bench rootfs; hardware remains unqualified"
