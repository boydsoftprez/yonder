#!/bin/bash
# Clean only mounts and loop devices owned by the disposable Pi image build.
set -euo pipefail

for path in /target/var/lib/yonder/captures /target/var/log/journal \
        /target/var/lib/yonder-state /target/dev/pts /target/dev /target/proc \
        /target/run/yonder-apt /target/run /target/boot/firmware /target; do
    if mountpoint -q "$path"; then
        umount "$path"
    fi
done

# Match the copied file's identity. This finds an allocation made just before
# cancellation prevented writing pi-loops, and it cannot detach a stale marker
# number that has since been reused for another backing file.
if [[ -f /work/disk.img && ! -L /work/disk.img ]]; then
    associated=$(losetup --associated /work/disk.img)
    while IFS=: read -r loop _; do
        [[ -n "$loop" ]] || continue
        [[ $loop =~ ^/dev/loop[0-9]+$ ]]
        losetup -d "$loop"
    done <<<"$associated"
    [[ -z $(losetup --associated /work/disk.img) ]]
fi
rm -f /work/pi-loops
