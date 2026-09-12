#!/bin/sh
set -eu
if ! test -f /.dockerenv; then
  echo "Use run.sh: this fixture requires a disposable Docker container." >&2
  exit 2
fi
umask 077
mkdir -p /lab/base /lab/normal /lab/state
chmod 755 /lab /lab/base /lab/normal
for p in bin sbin lib usr etc var root tmp run opt srv home boot; do
  if test -e "/$p"; then cp -a "/$p" /lab/base/; fi
done
mkdir -p /lab/base/dev /lab/base/proc /lab/base/sys
cp /etc/resolv.conf /lab/base/etc/resolv.conf
# Prevent package service startup in this disposable chroot.
printf '#!/bin/sh\nexit 101\n' > /lab/base/usr/sbin/policy-rc.d
chmod 755 /lab/base/usr/sbin/policy-rc.d
mount --bind /dev /lab/base/dev
mount -t proc proc /lab/base/proc
normal_mount() {
  mount --bind /lab/base /lab/normal
  mount -o remount,bind,ro /lab/normal
  mount -t tmpfs -o size=32m,mode=755 tmpfs /lab/normal/etc
  cp -a /lab/base/etc/. /lab/normal/etc/
}
normal_unmount() { umount /lab/normal/etc; umount /lab/normal; }
chroot /lab/base apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 update > /lab/apt-update.log 2>&1
normal_mount
if touch /lab/normal/usr/protected-check 2>/lab/protected-error; then exit 21; fi
printf 'PASS: ordinary system writes refused\n'
chroot /lab/normal useradd -l -M -u 1700 -G sudo -s /bin/bash ownerprobe
printf 'ownerprobe:disposable-probe-password\n' | chroot /lab/normal chpasswd
chroot /lab/normal getent passwd ownerprobe > /lab/state/passwd-entry
chroot /lab/normal getent shadow ownerprobe > /lab/state/shadow-entry
printf 'PASS: standard useradd/chpasswd work with whole-directory volatile /etc\n'
cp /lab/normal/etc/shadow /lab/bound-shadow
mount --bind /lab/bound-shadow /lab/normal/etc/shadow
if printf 'ownerprobe:replacement-probe-password\n' | chroot /lab/normal chpasswd >/lab/file-bind-result 2>&1; then
  printf 'UNEXPECTED: individual shadow bind accepted; inspect semantics\n'; exit 22
fi
umount /lab/normal/etc/shadow
printf 'PASS: individual shadow-file bind rejected by password update (negative control)\n'
if chroot /lab/normal apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 install -y hello > /lab/normal-apt-result 2>&1; then exit 23; fi
grep -qi 'read.only' /lab/normal-apt-result
printf 'PASS: apt cannot alter protected ordinary-mode package database\n'
normal_unmount
chroot /lab/base apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 install -y --no-install-recommends hello > /lab/apt-install.log 2>&1
chroot /lab/base useradd -l -r -M serviceprobe
printf 'PASS: real apt installed hello into persistent backing root\n'
normal_mount
# Re-project only the managed owner, preserving backing-root service accounts.
chroot /lab/normal useradd -l -M -u 1700 -G sudo -s /bin/bash ownerprobe
cut -d: -f1,2 /lab/state/shadow-entry | chroot /lab/normal chpasswd -e
chroot /lab/normal getent shadow ownerprobe > /lab/after-shadow
cmp /lab/state/shadow-entry /lab/after-shadow
chroot /lab/normal getent passwd serviceprobe > /dev/null
# dpkg-query, not the shell, expands its format fields.
# shellcheck disable=SC2016
chroot /lab/normal dpkg-query -W -f='${Status}\n' hello | grep -q 'install ok installed'
chroot /lab/normal /usr/bin/hello > /lab/hello-output
if touch /lab/normal/usr/protected-check 2>/dev/null; then exit 24; fi
printf 'PASS: after mount teardown/recreation, owner hash, service user, package database and executable survive; system remains protected\n'
normal_unmount
umount /lab/base/proc
umount /lab/base/dev
printf 'LIMIT: this is a container mount/chroot prototype, not board boot, ext4 durability, PAM login or power-loss qualification\n'
