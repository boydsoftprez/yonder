# SPDX-License-Identifier: GPL-3.0-or-later
# Install the GStreamer plugin that reaches a Rockchip board's hardware
# encoders, and the two libraries it links, from the offline payload — on a
# board that has the hardware, and nowhere else. R-HW-03, R-CAM-07, R-CAM-13.
# shellcheck shell=sh

# An RK35xx reaches its encoders through Rockchip's MPP, not through V4L2:
# there is no memory-to-memory node for v4l2h264enc to bind to, and no
# repository this board has — Debian or Armbian — packages MPP, librga or the
# plugin. make-payload.sh builds all three from pinned commits; this role puts
# them where GStreamer looks and proves the registry then resolves
# mpph264enc, mpph265enc and mppjpegdec, which is exactly what probeEncoder
# asks it (packages/yonder-core/src/video/probe/encoder.ts).
#
# Two skips, neither a failure (R-CFG-08): a payload built without the
# component, and a board that is not a Rockchip board. The second is decided
# by the device node MPP opens, never by a board name (R-CAM-13, R-HW-04): a
# Raspberry Pi has no /dev/mpp_service, and a plugin installed there would
# register three decoders that fail the moment anything uses them.
gr_src="$YONDER_SRC/vendor/gst-rockchip"
if [ ! -d "$gr_src" ]; then
    log "no gst-rockchip in the payload; skipping"
    log "  build one with: installer/make-payload.sh --arch linux-arm64 --only gst-rockchip"
    return 0
fi
if [ ! -c "$YONDER_MPP_DEVICE" ]; then
    log "no $YONDER_MPP_DEVICE on this device; not a Rockchip board, leaving the MPP plugin in the payload"
    return 0
fi
gr_plugin="$gr_src/gstreamer-1.0/libgstrockchipmpp.so"
[ -f "$gr_plugin" ] || die "$gr_src exists but carries no gstreamer-1.0/libgstrockchipmpp.so"
[ -d "$gr_src/lib" ] || die "$gr_src exists but carries no lib/ with MPP and librga in it"

# The plugin links libdrm; the tools package is what the probe, and this
# role's own post-condition, ask the registry with. Both from Debian, on the
# footing 50-mediamtx.sh states.
ensure_pkgs libdrm2 gstreamer1.0-tools

# Built for this machine, checked as 15-mavlink-router.sh checks the router.
# A plugin for another architecture fails to load with a line about the file
# format, and GStreamer then answers "no such element" — the exact shape of
# "this board has no encoder" that spec §8 exists to stop.
gr_have=$(elf_machine "$gr_plugin")
[ -n "$gr_have" ] || die "$gr_plugin is not a little-endian ELF object; the payload is not a payload"
gr_want=$(elf_machine "$YONDER_ELF_REFERENCE")
if [ -z "$gr_want" ]; then
    log "no ELF reference at $YONDER_ELF_REFERENCE to compare against; installing the plugin (ELF machine $gr_have) unchecked"
elif [ "$gr_have" != "$gr_want" ]; then
    die "$gr_plugin is built for ELF machine $gr_have and this system runs $gr_want ($YONDER_ELF_REFERENCE);
the payload was staged for a different architecture.
Rebuild it with: installer/make-payload.sh --arch linux-arm64 --only gst-rockchip"
else
    log "libgstrockchipmpp.so is built for ELF machine $gr_have, the same as $YONDER_ELF_REFERENCE"
fi

log "installing MPP and librga into $YONDER_GST_LIBDIR"
ensure_dir "$YONDER_GST_LIBDIR" 0755
# -a keeps the soname symlinks the loader resolves through.
run cp -a "$gr_src/lib/." "$YONDER_GST_LIBDIR/"
log "installing the plugin into $YONDER_GST_PLUGIN_DIR"
ensure_dir "$YONDER_GST_PLUGIN_DIR" 0755
run cp "$gr_plugin" "$YONDER_GST_PLUGIN_DIR/libgstrockchipmpp.so"
run chmod 0644 "$YONDER_GST_PLUGIN_DIR/libgstrockchipmpp.so"
if command -v ldconfig >/dev/null 2>&1; then
    run ldconfig
else
    log "no ldconfig here; the loader's cache is not refreshed"
fi

# GStreamer caches what it found last time. It rescans a plugin whose file
# changed, but a stale cache reads exactly as "the board has no encoder", so
# the caches are removed rather than trusted.
for gr_dir in $YONDER_GST_REGISTRY_DIRS; do
    for gr_reg in "$gr_dir"/registry.*.bin; do
        [ -f "$gr_reg" ] && run rm -f "$gr_reg"
    done
done

# Post-condition: the registry, asked as this role runs. It runs as root,
# and that matters: the node is 0600 root:root, and a process that cannot
# open it sees the plugin register its decoders and none of its encoders,
# silently — the failure below names that so it is not mistaken for a
# missing plugin.
if [ "$DRY_RUN" = "1" ]; then
    log "would check that GStreamer resolves mpph264enc, mpph265enc and mppjpegdec"
else
    for gr_element in mpph264enc mpph265enc mppjpegdec; do
        gst-inspect-1.0 --exists "$gr_element" \
            || die "GStreamer does not resolve $gr_element after installing the plugin.
If 'gst-inspect-1.0 rockchipmpp' lists decoders and no encoders, this process could not open $YONDER_MPP_DEVICE;
this role runs as root, so that means the node is not the MPP service. If it lists nothing, the plugin did not
load: run GST_DEBUG=2 gst-inspect-1.0 rockchipmpp and read what it says about $YONDER_GST_PLUGIN_DIR/libgstrockchipmpp.so"
    done
    log "GStreamer resolves mpph264enc, mpph265enc and mppjpegdec; probeEncoder will find them"
fi
