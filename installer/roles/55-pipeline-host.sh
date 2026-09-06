# SPDX-License-Identifier: GPL-3.0-or-later
# Install the program that carries a video pipeline and can be told things
# while it is carrying it.
# shellcheck shell=sh

# The two Debian packages that program imports (R-VID-07).
#
# From apt, and not from installer/make-payload.sh, on the footing
# 50-mediamtx.sh states for gstreamer1.0-rtsp: both are in Debian main, so a
# board imaged from a debootstrapped chroot has them available the same way
# network-manager and avahi-daemon are. make-payload.sh is for artefacts that
# are *not* in Debian - a Node distribution, ZeroTier, mediamtx - each vendored
# against a pinned fingerprint and a hand-read trust anchor, and it has no apt
# mechanism at all.
#
# python3-gi is the binding and gir1.2-gstreamer-1.0 is the description of
# GStreamer it reads; either alone imports and then cannot find the other half.
ensure_pkgs python3-gi gir1.2-gstreamer-1.0

# And checked by asking Python, because "the package installed" and "the
# bindings import" are different questions and only the second one matters -
# the same distinction 50-mediamtx.sh draws by asking the GStreamer registry
# to resolve rtspclientsink rather than asking dpkg about a package.
if [ "$DRY_RUN" = "1" ]; then
    log "would check that Python can import gi and GStreamer"
elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import gi; gi.require_version("Gst", "1.0"); from gi.repository import Gst' \
        >/dev/null 2>&1 \
        || die "Python cannot import gi and GStreamer even though python3-gi and gir1.2-gstreamer-1.0
are installed; the pipeline host would not start, and this device would fall back to running
video under gst-launch-1.0, which carries the picture but takes no instruction once it is running"
    log "Python imports gi and GStreamer"
elif have_pkg python3-gi; then
    log "python3-gi is installed; no python3 here to import it with"
else
    die "python3-gi is not installed and there is no python3 on this device"
fi

# The host itself. Committed source rather than a downloaded artefact, so its
# absence is a broken tree and not a payload somebody chose not to build -
# which is why this stops, where 50-mediamtx.sh skips. 20-yonder-core.sh dies
# on a missing config/defaults/config.yaml for the same reason.
host_src="$YONDER_SRC/installer/payload/yonder-pipeline"
host_bin=/usr/local/bin/yonder-pipeline

[ -f "$host_src" ] || die "no pipeline host at $host_src; this checkout is incomplete"

log "installing the pipeline host to $host_bin"
ensure_dir "$(dirname "$host_bin")"
run install -m 0755 "$host_src" "$host_bin"

# A post-condition, and the strongest one available without starting a camera:
# run the thing that was just installed. With no pipeline to play it does its
# whole preflight - the shebang resolves a python3, gi imports, GStreamer's
# typelib loads, and the two calls the host is built out of are present - and
# then says it was given no pipeline. Anything else printed here is a device
# that would silently run its video under gst-launch-1.0 for ever.
if [ "$DRY_RUN" = "1" ]; then
    log "would run $host_bin with no pipeline, to check that it starts"
elif "$host_bin" 2>&1 | grep -q 'no pipeline given'; then
    log "the pipeline host starts, and finds its GStreamer"
else
    die "$host_bin does not start; a camera on this device would run under gst-launch-1.0,
which carries video and takes no instruction, so an applied bitrate would never reach the
running encoder (K-48). Its own reason is above this line."
fi

# Not enabled, started or wired to anything, because it is not a service.
# yonder-core spawns one of these per running camera and supervises it
# (video/supervisor.ts), and it is chosen per spawn rather than once at
# start-up - so a camera that is streaming right now keeps the runner it
# started under, and picks this one up the next time it is started.
