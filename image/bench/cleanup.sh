#!/bin/bash
# Only resources allocated to this builder's private copied disk may be released.
set -euo pipefail
if mountpoint -q /run/yonder-prototype-ram-source; then
    umount /run/yonder-prototype-ram-source
fi
if mountpoint -q /prototype; then
    umount --recursive /prototype
fi
for path in /target/var/lib/yonder/captures /target/var/log/journal /target/var/lib/yonder-state /target/dev/pts /target/dev /target/proc /target/run/yonder-apt /target/run /target; do
    if mountpoint -q "$path"; then umount "$path"; fi
done
# --associated matches the copied file identity, including an allocation made
# just before cancellation prevented writing root-loop. Never scan by path alone.
if [[ -f /work/disk.img && ! -L /work/disk.img ]]; then
    associated=$(losetup --associated /work/disk.img)
    while IFS=: read -r loop _; do
        [[ -n "$loop" ]] || continue
        [[ "$loop" =~ ^/dev/loop[0-9]+$ ]]
        losetup -d "$loop"
    done <<<"$associated"
    [[ -z $(losetup --associated /work/disk.img) ]]
fi
rm -f /work/root-loop
