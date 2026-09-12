#!/bin/sh
# Read-only diagnostic: report observed mounts, never just a configured flag.
set -eu
printf '%s\n' 'Yonder storage prototype; not power-cut qualified. Owner recovery remains pending.'
for path in / /boot /etc /etc/yonder /etc/ssh /var/lib/yonder-state \
        /var/lib/yonder /var/lib/yonder/console /var/log/journal \
        /var/lib/yonder/captures /tmp /var/tmp /var/cache /home; do
    findmnt -n -T "$path" -o TARGET,SOURCE,FSTYPE,OPTIONS
done
df -h / /var/lib/yonder-state /var/log/journal /var/lib/yonder/captures
