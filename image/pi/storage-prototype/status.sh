#!/bin/sh
# Read-only prototype diagnostic; it never infers protection from a marker.
set -eu
printf '%s\n' 'Yonder Pi storage prototype; board boot and power-cut behavior remain unqualified.'
for path in / /boot/firmware /etc /etc/yonder /etc/ssh \
        /var/lib/yonder-state /var/lib/yonder /var/lib/yonder/console \
        /var/log/journal /var/lib/yonder/captures /tmp /var/tmp /var/cache /home; do
    findmnt -n -T "$path" -o TARGET,SOURCE,FSTYPE,OPTIONS
done
df -h / /boot/firmware /var/lib/yonder-state /var/log/journal \
    /var/lib/yonder/captures
