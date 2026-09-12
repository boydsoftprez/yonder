#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Generate identities which must belong to the booted bench board, never the builder.
set +x
set -eu
umask 077

marker=/var/lib/yonder/bench-first-boot.done

[ "$(id -u)" = 0 ] || {
    printf '%s\n' 'error: yonder bench first boot must run as root' >&2
    exit 1
}

if [ -e "$marker" ]; then
    exit 0
fi

# PID 1 normally commits an empty /etc/machine-id before ordinary units run.
# Keep this fallback for images booted through a less usual systemd path.
if [ ! -s /etc/machine-id ]; then
    /usr/bin/systemd-machine-id-setup >/dev/null
fi
[ -s /etc/machine-id ] || {
    printf '%s\n' 'error: first boot did not create a machine identity' >&2
    exit 1
}

if [ -d /var/lib/dbus ]; then
    rm -f /var/lib/dbus/machine-id
    ln -s /etc/machine-id /var/lib/dbus/machine-id
fi

/usr/bin/ssh-keygen -A >/dev/null
set -- /etc/ssh/ssh_host_*_key
[ -f "$1" ] || {
    printf '%s\n' 'error: first boot did not create SSH host keys' >&2
    exit 1
}

for private_key in /etc/ssh/ssh_host_*_key; do
    [ -f "$private_key" ] || continue
    chmod 0600 "$private_key"
    [ -f "$private_key.pub" ] || {
        printf 'error: SSH public host key is missing for %s\n' "$private_key" >&2
        exit 1
    }
    chmod 0644 "$private_key.pub"
done

# installer/roles/10-base.sh deliberately makes this root:yonder so the
# unprivileged console can traverse its own state directory. Reassert that
# contract rather than letting first boot depend on inherited directory state.
mkdir -p /var/lib/yonder
chown root:yonder /var/lib/yonder
chmod 0750 /var/lib/yonder
tmp_marker="$marker.$$"
printf '%s\n' 'identities-created' >"$tmp_marker"
chmod 0600 "$tmp_marker"
mv "$tmp_marker" "$marker"
