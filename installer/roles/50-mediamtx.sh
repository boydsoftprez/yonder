# SPDX-License-Identifier: GPL-3.0-or-later
# Install the media server from the offline payload, and leave it off.
# shellcheck shell=sh

# Every GStreamer package the composer relies on, on every board, and the
# tools package the probe asks the registry with. What is where: plugins-base
# carries capsfilter, videoconvert, videoscale, videorate, tee and queue;
# plugins-good v4l2src, jpegdec, videoflip, rtph264pay, rtph265pay, udpsink,
# jpegenc and matroskamux; plugins-bad h264parse and h265parse; plugins-ugly
# x264enc, the software fallback probeEncoder names — which no role installed
# until now, so a board without a hardware encoder had no encoder at all;
# rtsp carries rtspclientsink, the element every branch of every pipeline
# ends in. A board's own elements — v4l2convert and v4l2h264enc on a Pi, the
# MPP elements on Rockchip — come from the board's own plugin and are checked
# by the role that provides it (52-gst-rockchip.sh).
#
# From apt rather than the payload: all six are in Debian main, so an offline
# board imaged from a debootstrapped chroot has them the same way it has
# network-manager. make-payload.sh is for what Debian does not carry.
ensure_pkgs gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-rtsp

# And checked, because "the package installed" and "GStreamer resolves the
# element" are different questions and only the second matters: a pipeline
# description naming an element GStreamer cannot resolve does not parse, so
# one missing element is every camera on the device, not one output. The
# weaker branch this check used to take when gst-inspect-1.0 was absent is
# gone — the tools package is installed above, so its absence now is a fault.
if [ "$DRY_RUN" = "1" ]; then
    log "would check that GStreamer resolves every board-independent element the composer names"
else
    command -v gst-inspect-1.0 >/dev/null 2>&1 \
        || die "gstreamer1.0-tools is installed and there is still no gst-inspect-1.0; nothing here can ask the registry anything"
    for mtx_element in rtspclientsink v4l2src jpegdec videoflip tee queue capsfilter videorate videoconvert videoscale \
            h264parse h265parse rtph264pay rtph265pay udpsink x264enc jpegenc matroskamux filesink; do
        gst-inspect-1.0 --exists "$mtx_element" \
            || die "GStreamer cannot resolve $mtx_element even though its package is installed;
a pipeline naming an element GStreamer does not have fails to parse rather than failing to connect,
and every camera on this device composes it"
    done
    log "GStreamer resolves every board-independent element the composer names"
fi

mtx_src="$YONDER_SRC/vendor/mediamtx"
mtx_bin=/usr/local/bin/mediamtx
mtx_etc=/etc/mediamtx

# Not an error. A payload built without a media server is a valid payload -
# it is only needed by a device that will carry a camera - and R-CFG-08 says a
# freshly flashed device reaches a usable state regardless. So this role says
# what is missing and stops, rather than failing an install that is otherwise
# complete.
if [ ! -f "$mtx_src/mediamtx" ]; then
    log "no mediamtx in the payload; skipping"
    log "  build one with: installer/make-payload.sh --arch <linux-arm64|linux-x64>"
    return 0
fi

log "installing mediamtx to $mtx_bin"
ensure_dir "$(dirname "$mtx_bin")"
run install -m 0755 "$mtx_src/mediamtx" "$mtx_bin"

# Where yonder-core writes the generated configuration, and the two properties
# that make it safe to write a credential into.
#
# 2750 root:yonder-media. The 0750 is what keeps the RTSP password out of
# every account on the device but the one serving video - /etc/yonder is
# 0750 root:root because it holds secrets.yaml, so the media server cannot
# traverse it, and group `yonder` owns the daemon's control socket (K-01), so
# this account must not be in it.
#
# The setgid bit is the half that is easy to miss and does the work. The
# daemon writes the file as root with mode 0640 and never chowns anything -
# it has no numeric gid to chown to and no business resolving one - so the
# group has to be inherited from this directory. Without the bit the file
# lands root:root, the service cannot read its own configuration, and
# mediamtx exits on every start.
ensure_dir "$mtx_etc"
if [ "$DRY_RUN" = "1" ]; then
    log "would set $mtx_etc to 2750 root:yonder-media"
elif getent group yonder-media >/dev/null 2>&1; then
    run chgrp yonder-media "$mtx_etc"
    run chmod 2750 "$mtx_etc"
    # A post-condition, not a hope: the failure this prevents is a service
    # that starts, cannot open its configuration, and restarts for ever.
    if [ -g "$mtx_etc" ]; then
        log "$mtx_etc is setgid, so the daemon's writes inherit yonder-media"
    else
        die "$mtx_etc is not setgid; the configuration yonder-core writes would land root:root and mediamtx could not read it"
    fi
else
    die "the yonder-media account does not exist; installer/roles/10-base.sh creates it"
fi

if [ -f "$YONDER_SRC/systemd/mediamtx.service" ]; then
    run cp "$YONDER_SRC/systemd/mediamtx.service" /etc/systemd/system/mediamtx.service

    if [ "$DRY_RUN" = "1" ]; then
        mtx_unit="$YONDER_SRC/systemd/mediamtx.service"
    else
        mtx_unit=/etc/systemd/system/mediamtx.service
    fi

    # Two post-conditions before anything is enabled, each catching a way this
    # unit is a crash loop nobody sees until a board is in an aircraft: an
    # ExecStart naming a binary that is not there is 203/EXEC on every start,
    # and a User= naming an account that is not there is 217/USER.
    assert_unit_exec "$mtx_unit" "$mtx_bin"
    assert_unit_accounts "$mtx_unit"

    # And the third, one layer out: yonder-core is ProtectSystem=strict, so a
    # generated file outside its ReadWritePaths is EROFS from inside the
    # service and nowhere else. The install would still report success - the
    # installer runs outside the sandbox - and the first camera an operator
    # configured would fail to apply, on hardware, with a message about a
    # temporary file. See MEDIA_CONFIG_PATH in packages/yonder-core.
    assert_daemon_can_write "$YONDER_SRC/systemd/yonder-core.service" "$mtx_etc/mediamtx.yml"

    if command -v service_daemon_reload >/dev/null 2>&1; then
        service_daemon_reload
    elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
    else
        log "skipping systemctl daemon-reload (dry run or not a systemd host)"
    fi
fi

# Installed and off, for the reason 40-zerotier.sh is: a media server present
# on a device with no camera configured is a listener nobody decided to open,
# and R-SEC-13 says none is reachable without a stated posture. MediaRenderer
# starts it when, and only when, a camera is configured.
#
# The same ownership check 40-zerotier.sh learned the hard way. This installer
# is documented as idempotent and is re-run to upgrade; 20-yonder-core has
# already restarted the daemon by the time this role runs, and that daemon's
# start-up render brings the media server up for whatever cameras the
# configuration names. A role that then stopped it unconditionally would take
# the picture away from an operator upgrading a device while watching video
# over it, and nothing later re-renders.
#
# The generated configuration is that record - it is written when a camera is
# configured and removed with the last one - which is the same source of truth
# MediaRenderer itself uses.
if [ -f "$mtx_etc/mediamtx.yml" ]; then
    log "yonder-core owns mediamtx (a camera is configured); leaving it running"
else
    log "stopping and disabling mediamtx until a camera is configured"
    if command -v service_stop >/dev/null 2>&1; then
        service_stop mediamtx.service
        service_disable mediamtx.service
    else
        try systemctl stop mediamtx
        disable_unit_offline mediamtx.service
        assert_unit_disabled mediamtx.service
    fi
fi
