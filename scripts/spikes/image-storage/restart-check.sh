#!/bin/sh
set -eu
if ! test -f /.dockerenv; then
  echo "Use run.sh: this fixture requires a disposable Docker container." >&2
  exit 2
fi
mount --bind /lab/base /lab/normal
mount -o remount,bind,ro /lab/normal
mount -t tmpfs -o size=32m,mode=755 tmpfs /lab/normal/etc
cp -a /lab/base/etc/. /lab/normal/etc/
chroot /lab/normal useradd -l -M -u 1700 -G sudo -s /bin/bash ownerprobe
cut -d: -f1,2 /lab/state/shadow-entry | chroot /lab/normal chpasswd -e
chroot /lab/normal getent shadow ownerprobe > /lab/restarted-shadow
cmp /lab/state/shadow-entry /lab/restarted-shadow
chroot /lab/normal getent passwd serviceprobe > /dev/null
chroot /lab/normal /usr/bin/hello
if touch /lab/normal/usr/protected-check 2>/dev/null; then exit 24; fi
umount /lab/normal/etc
umount /lab/normal
printf 'PASS: container restart preserved backing package, service account and saved owner hash; protected projection recreated\n'
