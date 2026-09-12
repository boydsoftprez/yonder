#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Explicit private-test access and first-boot preparation for Raspberry Pi OS.
set +x
set -eu
umask 077

bench_user=yonder-bench
input_dir=/run/yonder-bench-input
password_file=$input_dir/password
authorized_key_file=$input_dir/authorized_key
marker=/etc/yonder/bench-image
test_host_key=/run/yonder-sshd-config-test-key

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

cleanup_inputs() {
    rm -f -- "$password_file" "$authorized_key_file" \
        "$test_host_key" "$test_host_key.pub"
}

[ "$#" -eq 1 ] && [ "$1" = --private-test ] || {
    printf '%s\n' 'Usage: prepare-rootfs.sh --private-test' >&2
    exit 2
}
trap cleanup_inputs EXIT
trap 'exit 1' HUP INT TERM

[ "$(id -u)" = 0 ] || die 'must run as root inside the target chroot'
[ "$(dpkg --print-architecture)" = arm64 ] || die 'target rootfs is not Debian ARM64'
[ -f /etc/rpi-issue ] || die 'target rootfs is not Raspberry Pi OS'
[ -f /boot/firmware/config.txt ] && [ -f /boot/firmware/cmdline.txt ] \
    || die 'target rootfs has no Raspberry Pi boot files'
for boot_file in bcm2710-rpi-3-b.dtb bcm2711-rpi-4-b.dtb \
        bcm2712-rpi-5-b.dtb kernel8.img kernel_2712.img; do
    [ -f "/boot/firmware/$boot_file" ] \
        || die "target boot filesystem lacks $boot_file"
done

for required in /usr/sbin/useradd /usr/sbin/usermod /usr/sbin/chpasswd \
        /usr/sbin/visudo /usr/bin/sudo /bin/su /usr/sbin/sshd \
        /usr/bin/ssh-keygen /usr/bin/systemctl /usr/bin/systemd-machine-id-setup; do
    [ -x "$required" ] || die "required target tool is missing: $required"
done
for required_path in /etc/passwd /etc/group /etc/sudoers /etc/ssh/sshd_config \
        /etc/systemd/system /etc/yonder/config.yaml \
        /var/lib/yonder/console/settings.js; do
    [ -e "$required_path" ] || die "required target path is missing: $required_path"
done

check_private_input() {
    input=$1
    [ -f "$input" ] && [ ! -L "$input" ] \
        || die "$input must be a regular file, not a link"
    [ "$(stat -c %u "$input")" = 0 ] || die "$input must be owned by root"
    input_mode=$(stat -c %a "$input")
    [ $((0$input_mode & 077)) -eq 0 ] \
        || die "$input must not be accessible by group or other users"
}

[ -d "$input_dir" ] && [ ! -L "$input_dir" ] \
    || die "$input_dir must be a directory, not a link"
[ "$(stat -c %u "$input_dir")" = 0 ] || die "$input_dir must be owned by root"
input_dir_mode=$(stat -c %a "$input_dir")
[ $((0$input_dir_mode & 077)) -eq 0 ] \
    || die "$input_dir must not be accessible by group or other users"
check_private_input "$password_file"
password_bytes=$(wc -c <"$password_file")
[ "$password_bytes" -gt 0 ] && [ "$password_bytes" -le 1024 ] \
    || die 'private-test password must contain 1 to 1024 bytes'
[ "$(awk 'END { print NR }' "$password_file")" -eq 1 ] \
    || die 'private-test password must be exactly one line'
password=$(sed -n '1p' "$password_file")
[ -n "$password" ] || die 'private-test password must not be empty'
case "$password" in *:*) die 'private-test password must not contain a colon' ;; esac

have_authorized_key=0
if [ -e "$authorized_key_file" ]; then
    check_private_input "$authorized_key_file"
    [ "$(awk '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' \
            "$authorized_key_file")" -eq 1 ] \
        || die 'authorized_key must contain exactly one public key'
    ! grep -q 'PRIVATE KEY' "$authorized_key_file" \
        || die 'authorized_key contains private-key material'
    /usr/bin/ssh-keygen -l -f "$authorized_key_file" >/dev/null 2>&1 \
        || die 'authorized_key is not accepted by ssh-keygen'
    have_authorized_key=1
fi

grep -q '^[[:space:]]*ssid: yonder$' /etc/yonder/config.yaml \
    || die 'Yonder default AP SSID is not present'
grep -q '^[[:space:]]*address: 192\.168\.77\.1/24$' /etc/yonder/config.yaml \
    || die 'Yonder default AP address is not present'
grep -q '^[[:space:]]*port: 3000$' /etc/yonder/config.yaml \
    || die 'Yonder console port 3000 is not present'
grep -q 'setup-flows\.json' /var/lib/yonder/console/settings.js \
    || die 'installed console is not at the administrator-password gate'
if [ -f /etc/yonder/secrets.yaml ] \
        && grep -q '^admin_password:' /etc/yonder/secrets.yaml; then
    die 'target contains an administrator password; refusing to image it'
fi

if getent passwd "$bench_user" >/dev/null 2>&1; then
    if [ ! -f "$marker" ] || ! grep -qx 'kind=private-rpi-test' "$marker"; then
        die "unexpected pre-existing account: $bench_user"
    fi
else
    /usr/sbin/useradd --create-home --shell /bin/bash \
        --comment 'Yonder Raspberry Pi private test' "$bench_user"
fi
/usr/sbin/usermod --append --groups sudo "$bench_user"
printf '%s:%s\n' "$bench_user" "$password" | /usr/sbin/chpasswd
/usr/sbin/usermod --lock root

bench_home=/home/$bench_user
install -d -m 0700 -o "$bench_user" -g "$bench_user" "$bench_home/.ssh"
if [ "$have_authorized_key" = 1 ]; then
    install -m 0600 -o "$bench_user" -g "$bench_user" \
        "$authorized_key_file" "$bench_home/.ssh/authorized_keys.new"
    mv "$bench_home/.ssh/authorized_keys.new" "$bench_home/.ssh/authorized_keys"
else
    rm -f "$bench_home/.ssh/authorized_keys"
fi

install -d -m 0750 /etc/sudoers.d
printf '%s ALL=(ALL:ALL) PASSWD: ALL\n' "$bench_user" \
    >/etc/sudoers.d/zz-yonder-bench.new
chmod 0440 /etc/sudoers.d/zz-yonder-bench.new
/usr/sbin/visudo -cf /etc/sudoers >/dev/null
mv /etc/sudoers.d/zz-yonder-bench.new /etc/sudoers.d/zz-yonder-bench
/usr/sbin/visudo -cf /etc/sudoers >/dev/null \
    || die 'installed sudo policy is invalid'
if /bin/su -s /bin/sh -c \
        'SUDO_ASKPASS=/bin/false /usr/bin/sudo -n -u root true >/dev/null 2>&1' \
        "$bench_user"; then
    die "$bench_user can use sudo without its password"
fi
if ! printf '%s\n' "$password" | /bin/su -s /bin/sh -c \
        '/usr/bin/sudo -S -p "" -u root true >/dev/null 2>&1' "$bench_user"; then
    die "$bench_user cannot use sudo with its password"
fi
/bin/su -s /bin/sh -c '/usr/bin/sudo -K' "$bench_user" >/dev/null 2>&1 || true
password=''

cat >/etc/ssh/sshd_config.new <<'EOF'
# Yonder private Raspberry Pi test access; absent from final release images.
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
chmod 0600 /etc/ssh/sshd_config.new
rm -f -- "$test_host_key" "$test_host_key.pub"
/usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$test_host_key"
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.new -h "$test_host_key"
mv /etc/ssh/sshd_config.new /etc/ssh/sshd_config
effective_ssh=$(/usr/sbin/sshd -T -f /etc/ssh/sshd_config -h "$test_host_key" \
    -C "user=$bench_user,host=rpi,addr=127.0.0.1")
ssh_value() {
    printf '%s\n' "$effective_ssh" | awk -v key="$1" '$1 == key { print $2; exit }'
}
[ "$(ssh_value permitrootlogin)" = no ] || die 'effective SSH policy permits root login'
[ "$(ssh_value passwordauthentication)" = yes ] \
    || die 'effective SSH policy does not permit the private-test password'
[ "$(ssh_value pubkeyauthentication)" = yes ] \
    || die 'effective SSH policy does not permit public keys'
[ "$(ssh_value allowusers)" = "$bench_user" ] \
    || die 'effective SSH policy permits another account'
rm -f -- "$test_host_key" "$test_host_key.pub"

# The assembled image owns first use. The base's generic user wizard, grow,
# SSH switch and key generator would race or override that explicit policy.
for unit in userconfig.service rpi-resize.service sshswitch.service \
        regenerate_ssh_host_keys.service; do
    /usr/bin/systemctl disable "$unit" >/dev/null 2>&1 || true
    /usr/bin/systemctl mask "$unit" >/dev/null
done
install -d -m 0755 /etc/cloud
: >/etc/cloud/cloud-init.disabled

awk '{
    out = ""
    for (i = 1; i <= NF; i++) {
        if ($i == "resize" || $i ~ /^console=serial0(,[^ ]*)?$/) continue
        out = out (out == "" ? "" : " ") $i
    }
    print out
}' /boot/firmware/cmdline.txt >/boot/firmware/cmdline.txt.new
[ "$(awk 'END { print NR }' /boot/firmware/cmdline.txt.new)" -eq 1 ] \
    || die 'Raspberry Pi command line is not exactly one line'
grep -Eq '(^|[[:space:]])root=PARTUUID=[0-9a-f]{8}-02([[:space:]]|$)' \
    /boot/firmware/cmdline.txt.new || die 'Raspberry Pi root PARTUUID is missing'
mv /boot/firmware/cmdline.txt.new /boot/firmware/cmdline.txt

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

rm -f /etc/ssh/ssh_host_* /var/lib/systemd/random-seed \
    /var/lib/dbus/machine-id /var/lib/yonder/bench-first-boot.done \
    /root/.ssh/authorized_keys /etc/yonder/secrets.yaml \
    /var/lib/zerotier-one/identity.public \
    /var/lib/zerotier-one/identity.secret \
    /var/lib/zerotier-one/authtoken.secret
: >/etc/machine-id
chmod 0444 /etc/machine-id
install -m 0600 /dev/null /etc/yonder/secrets.yaml

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
first_boot=$script_dir/../bench/first-boot.sh
[ -f "$first_boot" ] || die 'shared bench first-boot helper is missing'
install -m 0755 "$first_boot" /usr/local/sbin/yonder-bench-first-boot
cat >/etc/systemd/system/yonder-bench-first-boot.service <<'EOF'
[Unit]
Description=Create unique identities for the Yonder private Raspberry Pi test image
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
cat >"$marker.new" <<'EOF'
kind=private-rpi-test
target=rpi
writable_root=true
protected_storage=false
hardware_qualified=false
EOF
chmod 0644 "$marker.new"
mv "$marker.new" "$marker"

for unit in userconfig.service rpi-resize.service sshswitch.service \
        regenerate_ssh_host_keys.service; do
    [ "$(readlink "/etc/systemd/system/$unit")" = /dev/null ] \
        || die "$unit is not masked"
done
[ -e /etc/cloud/cloud-init.disabled ] || die 'cloud-init is not disabled'
[ ! -s /etc/machine-id ] || die 'builder machine identity remains in the image'
set -- /etc/ssh/ssh_host_*_key
[ ! -e "$1" ] || die 'builder SSH host keys remain in the image'
[ -f /etc/yonder/secrets.yaml ] && [ ! -s /etc/yonder/secrets.yaml ] \
    || die 'builder Yonder secrets remain in the image'
! grep -Eq '(^|[[:space:]])resize([[:space:]]|$)|console=serial0' \
    /boot/firmware/cmdline.txt || die 'upstream first-boot command-line action remains'

cleanup_inputs
[ ! -e "$password_file" ] && [ ! -e "$authorized_key_file" ] \
    || die 'could not remove private-test inputs'
printf '%s\n' 'pi-rootfs: prepared private writable Raspberry Pi test image; hardware remains unqualified'
