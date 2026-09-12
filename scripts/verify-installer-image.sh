#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Exercise the image-only installer boundary without touching the host.
set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/.." && pwd)

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$*"; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/yonder-image-installer.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
out="$tmp/out"

run_cli() {
    "$REPO/installer/install.sh" "$@" >"$out" 2>&1
}

printf '\n== image argument validation\n'

if run_cli --image --dry-run; then
    bad "--image without --target was accepted"
elif grep -q -- '--image requires --target' "$out"; then
    ok "--image requires an explicit target before preflight"
else
    bad "--image without a target failed for the wrong reason"
    sed 's/^/      /' "$out"
fi

if run_cli --target rpi --dry-run; then
    bad "--target without --image was accepted"
elif grep -q -- '--target is only valid with --image' "$out"; then
    ok "--target cannot silently change a live install"
else
    bad "--target without --image failed for the wrong reason"
    sed 's/^/      /' "$out"
fi

if run_cli --image --target not-a-board --dry-run; then
    bad "an unknown image target was accepted"
elif grep -q 'unknown target: not-a-board' "$out"; then
    ok "unknown image targets fail before installation"
else
    bad "an unknown image target failed for the wrong reason"
    sed 's/^/      /' "$out"
fi

if run_cli --hardware-test --dry-run; then
    bad "--hardware-test without the ROCK 5C image target was accepted"
elif grep -q -- '--hardware-test is only valid with --image --target radxa-rock5c' "$out"; then
    ok "--hardware-test cannot alter a live installation"
else
    bad "--hardware-test without image mode failed for the wrong reason"
    sed 's/^/      /' "$out"
fi

if run_cli --image --target rpi --hardware-test --dry-run; then
    bad "--hardware-test was accepted for a non-ROCK 5C image"
elif grep -q -- '--hardware-test is only valid with --image --target radxa-rock5c' "$out"; then
    ok "--hardware-test is restricted to the ROCK 5C image target"
else
    bad "--hardware-test with a different target failed for the wrong reason"
    sed 's/^/      /' "$out"
fi

incomplete_src="$tmp/incomplete-src"
mkdir -p "$incomplete_src"
cp -R "$REPO/installer" "$incomplete_src/installer"
if "$incomplete_src/installer/install.sh" --image --target rpi --dry-run >"$out" 2>&1; then
    bad "an incomplete source/payload was accepted for an image"
elif grep -q 'image payload is incomplete' "$out"; then
    ok "image mode rejects an incomplete payload instead of using a network fallback"
else
    bad "the incomplete image payload failed without the image preflight diagnostic"
    sed 's/^/      /' "$out"
fi

if "$incomplete_src/installer/install.sh" --image --target radxa-rock5c \
        --hardware-test --dry-run >"$out" 2>&1; then
    bad "an incomplete ROCK 5C hardware-test payload unexpectedly passed"
elif grep -q 'would validate the exact ROCK 5C Armbian environment' "$out" \
    && grep -q 'image payload is incomplete' "$out" \
    && ! grep -q -- '--hardware-test is only valid' "$out"; then
    ok "the exact ROCK 5C image combination crosses the hardware-test argument gate"
else
    bad "the valid ROCK 5C hardware-test combination did not reach image preflight"
    sed 's/^/      /' "$out"
fi

printf '\n== package service suppression\n'

policy="$tmp/policy-rc.d"
printf '#!/bin/sh\nexit 0\n' >"$policy"
chmod 0750 "$policy"
before=$(ls -l "$policy")
set +e
/bin/sh -c '
    set -eu
    IMAGE_MODE=1
    DRY_RUN=0
    YONDER_POLICY_RC_D=$1
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    begin_package_service_suppression
    set +e
    "$YONDER_POLICY_RC_D"
    rc=$?
    set -e
    [ "$rc" = 101 ]
    exit 7
' sh "$policy" "$REPO" >"$out" 2>&1
status=$?
set -e
after=$(ls -l "$policy")
if [ "$status" = 7 ] && [ "$before" = "$after" ] \
    && grep -q '^exit 0$' "$policy" \
    && ! find "$tmp" -name 'policy-rc.d.yonder.*' | grep -q .; then
    ok "policy-rc.d suppresses package starts and restores the prior file on shell exit"
else
    bad "policy-rc.d was not restored exactly after an early exit (exit $status)"
    sed 's/^/      /' "$out"
fi

mv_fail="$tmp/mv-fail-bin"
mkdir -p "$mv_fail"
cat >"$mv_fail/mv" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$mv_fail/mv"
printf '#!/bin/sh\nexit 0\n' >"$policy"
set +e
PATH="$mv_fail:$PATH" /bin/sh -c '
    set -eu
    IMAGE_MODE=1 DRY_RUN=0 YONDER_POLICY_RC_D=$1
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    begin_package_service_suppression
' sh "$policy" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q '^exit 0$' "$policy"; then
    ok "a failed policy backup leaves the existing policy-rc.d untouched"
else
    bad "a failed policy backup removed or changed the existing policy-rc.d (exit $status)"
    sed 's/^/      /' "$out"
fi

mv_signal="$tmp/mv-signal-bin"
mv_signal_marker="$tmp/mv-signal-fired"
mkdir -p "$mv_signal"
cat >"$mv_signal/mv" <<'EOF'
#!/bin/sh
/bin/mv "$@" || exit
if [ ! -e "$YONDER_MV_SIGNAL_MARKER" ]; then
    : >"$YONDER_MV_SIGNAL_MARKER"
    kill -TERM "$PPID"
fi
EOF
chmod +x "$mv_signal/mv"
printf '#!/bin/sh\nexit 42\n' >"$policy"
chmod 0740 "$policy"
before=$(ls -l "$policy")
set +e
PATH="$mv_signal:$PATH" YONDER_MV_SIGNAL_MARKER="$mv_signal_marker" /bin/sh -c '
    set -eu
    IMAGE_MODE=1 DRY_RUN=0 YONDER_POLICY_RC_D=$1
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    begin_package_service_suppression
' sh "$policy" "$REPO" >"$out" 2>&1
status=$?
set -e
after=$(ls -l "$policy" 2>/dev/null || true)
if [ "$status" != 0 ] && [ -e "$mv_signal_marker" ] \
    && [ "$before" = "$after" ] && grep -q '^exit 42$' "$policy" \
    && ! find "$tmp" -name 'policy-rc.d.yonder.*' | grep -q .; then
    ok "a handled signal immediately after the policy rename restores the prior file"
else
    bad "the policy rename left a handled-signal window without restoration (exit $status)"
    sed 's/^/      /' "$out"
fi

printf '\n== ARM64 image contract\n'

arch_src="$tmp/arch-src"
mkdir -p "$arch_src/vendor/node/bin" "$arch_src/vendor/mavlink-router" \
    "$arch_src/vendor/mediamtx" "$arch_src/vendor/console/node_modules/node-red" \
    "$arch_src/vendor/zerotier" "$arch_src/packages/yonder-core/dist/daemon" \
    "$arch_src/packages/yonder-core/dist/console" "$arch_src/packages/yonder-core/dist/admin" \
    "$arch_src/packages/yonder-core/dist/owner-access" \
    "$arch_src/packages/yonder-core/node_modules" "$arch_src/config/defaults" \
    "$arch_src/flows" "$arch_src/installer/payload" "$arch_src/systemd"
for package in node-red-contrib-yonder-system node-red-contrib-yonder-network \
        node-red-contrib-yonder-remote node-red-contrib-yonder-modem \
        node-red-contrib-yonder-video node-red-contrib-yonder-mavlink \
        node-red-dashboard-2-yonder; do
    mkdir -p "$arch_src/packages/$package/dist"
    touch "$arch_src/packages/$package/package.json"
done
mkdir -p "$arch_src/packages/node-red-dashboard-2-yonder/resources"
# Minimal x86-64 ELF headers. The declared image targets are ARM64, so a
# self-consistent x86 root and payload must still be rejected before node runs.
for elf in "$arch_src/vendor/node/bin/node" \
        "$arch_src/vendor/mavlink-router/mavlink-routerd" \
        "$arch_src/vendor/mediamtx/mediamtx" "$arch_src/root-sh"; do
    dd if=/dev/zero of="$elf" bs=64 count=1 >/dev/null 2>&1
    printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\076\000' \
        | dd of="$elf" conv=notrunc >/dev/null 2>&1
    chmod +x "$elf"
done
touch "$arch_src/vendor/console/package.json" \
    "$arch_src/vendor/console/node_modules/node-red/red.js" \
    "$arch_src/packages/yonder-core/dist/daemon/server.js" \
    "$arch_src/packages/yonder-core/dist/console/settings.js" \
    "$arch_src/packages/yonder-core/package.json" \
    "$arch_src/packages/yonder-core/package-lock.json" \
    "$arch_src/packages/yonder-core/tsconfig.json" \
    "$arch_src/config/defaults/config.yaml" "$arch_src/flows/flows.json" \
    "$arch_src/installer/payload/yonder-pipeline" \
    "$arch_src/vendor/zerotier/zerotier-one_1_amd64.deb" \
    "$arch_src/systemd/mavlink-router.service" \
    "$arch_src/packages/yonder-core/dist/admin/main.js" \
    "$arch_src/packages/yonder-core/dist/owner-access/cli.js" \
    "$arch_src/systemd/yonder-admin.service" \
    "$arch_src/systemd/yonder-admin.socket" \
    "$arch_src/systemd/yonder-admin.tmpfiles" \
    "$arch_src/systemd/yonder-owner-setup.service" \
    "$arch_src/systemd/yonder-owner-getty.conf" \
    "$arch_src/installer/payload/yonder-owner-setup" \
    "$arch_src/systemd/yonder-core.service" \
    "$arch_src/systemd/yonder-console.service" \
    "$arch_src/systemd/mediamtx.service"
chmod +x "$arch_src/installer/payload/yonder-pipeline"
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload rpi
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'image targets require ARM64' "$out"; then
    ok "a self-consistent non-ARM64 root and payload are rejected before execution"
else
    bad "image validation did not enforce ARM64 before executing payload code (exit $status)"
    sed 's/^/      /' "$out"
fi

# Turn the complete executable fixture into ARM64, then prove a Radxa image
# cannot get as far as dpkg or bundled Node execution with an incomplete or
# wrong-architecture MPP/RGA closure.
for elf in "$arch_src/vendor/node/bin/node" \
        "$arch_src/vendor/mavlink-router/mavlink-routerd" \
        "$arch_src/vendor/mediamtx/mediamtx" "$arch_src/root-sh"; do
    printf '\267\000' | dd of="$elf" bs=1 seek=18 conv=notrunc >/dev/null 2>&1
done
rock_contract="$arch_src/vendor/gst-rockchip"
mkdir -p "$rock_contract/gstreamer-1.0" "$rock_contract/lib"
dd if=/dev/zero of="$rock_contract/gstreamer-1.0/libgstrockchipmpp.so" bs=64 count=1 >/dev/null 2>&1
printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\267\000' \
    | dd of="$rock_contract/gstreamer-1.0/libgstrockchipmpp.so" conv=notrunc >/dev/null 2>&1

set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'missing a nonempty librockchip_mpp.so' "$out"; then
    ok "a Radxa payload missing its actual MPP library fails before payload execution"
else
    bad "a Radxa payload without an actual MPP library reached a later validation stage (exit $status)"
    sed 's/^/      /' "$out"
fi

for elf in "$rock_contract/lib/librockchip_mpp.so.1" "$rock_contract/lib/librga.so.2"; do
    dd if=/dev/zero of="$elf" bs=64 count=1 >/dev/null 2>&1
    printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\267\000' \
        | dd of="$elf" conv=notrunc >/dev/null 2>&1
done
# Make the real MPP library x86-64 while every executable and the RGA library
# remain ARM64. Family-name presence alone must not accept it.
printf '\076\000' | dd of="$rock_contract/lib/librockchip_mpp.so.1" bs=1 seek=18 conv=notrunc >/dev/null 2>&1
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'librockchip_mpp.so.1 is ELF machine 62' "$out"; then
    ok "a wrong-architecture MPP library fails before payload execution"
else
    bad "Radxa library architecture was not checked before payload execution (exit $status)"
    sed 's/^/      /' "$out"
fi

printf '\267\000' | dd of="$rock_contract/lib/librockchip_mpp.so.1" bs=1 seek=18 conv=notrunc >/dev/null 2>&1
ln -s missing-librga.so "$rock_contract/lib/librga.so"
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'dangling Rockchip library symlink' "$out"; then
    ok "a dangling RGA family symlink is rejected before payload execution"
else
    bad "a dangling Radxa library symlink was accepted or failed too late (exit $status)"
    sed 's/^/      /' "$out"
fi

rm -rf "${rock_contract:?}/lib"
mkdir -p "$rock_contract/lib"
for elf in "$rock_contract/lib/librockchip_mpp.so.bad" "$rock_contract/lib/librga.so.bad"; do
    dd if=/dev/zero of="$elf" bs=64 count=1 >/dev/null 2>&1
    printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\267\000' \
        | dd of="$elf" conv=notrunc >/dev/null 2>&1
done
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'required Rockchip soname.*librockchip_mpp.so.1' "$out"; then
    ok "lookalike MPP/RGA family names cannot replace the plugin's required MPP soname"
else
    bad "a .bad-only Rockchip family satisfied the exact MPP soname contract (exit $status)"
    sed 's/^/      /' "$out"
fi

cp "$rock_contract/lib/librockchip_mpp.so.bad" "$rock_contract/lib/librockchip_mpp.so.1"
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'required Rockchip soname.*librga.so' "$out"; then
    ok "the exact RGA soname required by the plugin cannot be omitted"
else
    bad "a Radxa payload missing the exact RGA soname reached a later stage (exit $status)"
    sed 's/^/      /' "$out"
fi

ln -s "$arch_src/root-sh" "$rock_contract/lib/librga.so"
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'points outside its staged library directory' "$out"; then
    ok "a resolved ARM64 soname symlink cannot escape the staged Rockchip library directory"
else
    bad "an external Rockchip soname target satisfied the self-contained payload contract (exit $status)"
    sed 's/^/      /' "$out"
fi

rm -f "$rock_contract/lib/librga.so"
ln -s "$arch_src/root-sh" "$rock_contract/lib/indirect-outside"
ln -s indirect-outside "$rock_contract/lib/librga.so"
set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_SRC=$1 YONDER_ELF_REFERENCE=$1/root-sh
    . "$2/installer/lib/common.sh"
    validate_image_payload radxa-zero3w
' sh "$arch_src" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'symlink.*family' "$out"; then
    ok "a library symlink chain cannot escape through an unrelated local alias"
else
    bad "an indirect library escape was accepted or failed too late (exit $status)"
fi

printf '\n== recursive application closure\n'

closure_src="$tmp/closure-src"
closure_bin="$tmp/closure-bin"
closure_role_marker="$tmp/closure-role-ran"
mkdir -p "$closure_src" "$closure_bin"
cp -R "$REPO/installer" "$closure_src/installer"
mkdir -p "$closure_src/vendor/node/bin" "$closure_src/vendor/mavlink-router" \
    "$closure_src/vendor/mediamtx" "$closure_src/vendor/console/node_modules/node-red" \
    "$closure_src/vendor/zerotier" "$closure_src/packages/yonder-core/dist/daemon" \
    "$closure_src/packages/yonder-core/dist/console" "$closure_src/packages/yonder-core/dist/admin" \
    "$closure_src/packages/yonder-core/dist/owner-access" \
    "$closure_src/packages/yonder-core/node_modules/parent" \
    "$closure_src/config/defaults" "$closure_src/flows" "$closure_src/systemd" \
    "$closure_src/boot"
ln -s "$(command -v node)" "$closure_src/vendor/node/bin/node"
touch "$closure_src/vendor/mavlink-router/mavlink-routerd" \
    "$closure_src/vendor/mediamtx/mediamtx" \
    "$closure_src/vendor/console/node_modules/node-red/red.js" \
    "$closure_src/vendor/zerotier/zerotier-one_1_arm64.deb" \
    "$closure_src/packages/yonder-core/dist/console/settings.js" \
    "$closure_src/packages/yonder-core/package-lock.json" \
    "$closure_src/packages/yonder-core/tsconfig.json" \
    "$closure_src/config/defaults/config.yaml" "$closure_src/flows/flows.json" \
    "$closure_src/systemd/mavlink-router.service" \
    "$closure_src/packages/yonder-core/dist/admin/main.js" \
    "$closure_src/packages/yonder-core/dist/owner-access/cli.js" \
    "$closure_src/systemd/yonder-admin.service" \
    "$closure_src/systemd/yonder-admin.socket" \
    "$closure_src/systemd/yonder-admin.tmpfiles" \
    "$closure_src/systemd/yonder-owner-setup.service" \
    "$closure_src/systemd/yonder-owner-getty.conf" \
    "$closure_src/installer/payload/yonder-owner-setup" \
    "$closure_src/systemd/yonder-core.service" \
    "$closure_src/systemd/yonder-console.service" \
    "$closure_src/systemd/mediamtx.service" \
    "$closure_src/boot/config.txt" "$closure_src/boot/cmdline.txt"
chmod +x "$closure_src/vendor/mavlink-router/mavlink-routerd" \
    "$closure_src/vendor/mediamtx/mediamtx"
printf '{"type":"module","dependencies":{"parent":"1.0.0"}}\n' \
    >"$closure_src/packages/yonder-core/package.json"
printf '{"name":"parent","dependencies":{"required-child":"1.0.0","optional-child":"1.0.0"},"optionalDependencies":{"optional-child":"1.0.0"}}\n' \
    >"$closure_src/packages/yonder-core/node_modules/parent/package.json"
printf 'export {};\n' >"$closure_src/packages/yonder-core/dist/daemon/server.js"
printf '{}\n' >"$closure_src/vendor/console/package.json"
for package in node-red-contrib-yonder-system node-red-contrib-yonder-network \
        node-red-contrib-yonder-remote node-red-contrib-yonder-modem \
        node-red-contrib-yonder-video node-red-contrib-yonder-mavlink \
        node-red-dashboard-2-yonder; do
    mkdir -p "$closure_src/packages/$package/dist"
    printf '{}\n' >"$closure_src/packages/$package/package.json"
done
mkdir -p "$closure_src/packages/node-red-dashboard-2-yonder/resources"
cat >"$closure_src/installer/roles/99-closure-marker.sh" <<'EOF'
: >"$YONDER_TEST_ROLE_MARKER"
EOF
cat >"$closure_bin/od" <<'EOF'
#!/bin/sh
printf '%s\n' '127 69 76 70 2 1 1 0 0 0 0 0 0 0 0 0 2 0 183 0'
EOF
cat >"$closure_bin/dpkg" <<'EOF'
#!/bin/sh
[ "$1" = "--print-architecture" ] && printf '%s\n' arm64
EOF
cat >"$closure_bin/dpkg-deb" <<'EOF'
#!/bin/sh
printf '%s\n' arm64
EOF
cat >"$closure_bin/id" <<'EOF'
#!/bin/sh
[ "$1" = "-u" ] && { printf '%s\n' 0; exit 0; }
exec /usr/bin/id "$@"
EOF
chmod +x "$closure_bin"/*
printf '#!/bin/sh\nexit 77\n' >"$closure_src/policy-rc.d"
chmod 0750 "$closure_src/policy-rc.d"
set +e
PATH="$closure_bin:$PATH" YONDER_BOOT_DIR="$closure_src/boot" \
    YONDER_POLICY_RC_D="$closure_src/policy-rc.d" \
    YONDER_TEST_ROLE_MARKER="$closure_role_marker" \
    "$closure_src/installer/install.sh" --image --target rpi --only 99-closure-marker \
    >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'required-child is not installed' "$out" \
    && ! grep -q 'optional-child is not installed' "$out" \
    && ! grep -q 'package service startup is suppressed' "$out" \
    && [ ! -e "$closure_role_marker" ]; then
    ok "a missing transitive required dependency fails before package policy or role writes while a missing optional dependency is allowed"
else
    bad "image preflight did not enforce the recursive required dependency closure before mutation (exit $status)"
    sed 's/^/      /' "$out"
fi

printf '\n== service lifecycle boundary\n'

stub="$tmp/bin"
root="$tmp/root"
calls="$tmp/calls"
mkdir -p "$stub" "$root/etc/systemd/system/multi-user.target.wants" "$root/usr/lib/systemd/system"
cat >"$stub/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >>"$YONDER_TEST_CALLS"
if [ "$1" = "--root=/" ] && [ "$2" = "enable" ]; then
    ln -sf "/usr/lib/systemd/system/$3" "$YONDER_TEST_ROOT/etc/systemd/system/multi-user.target.wants/$3"
fi
if [ "$1" = "--root=/" ] && [ "$2" = "disable" ]; then
    rm -f "$YONDER_TEST_ROOT/etc/systemd/system/multi-user.target.wants/$3"
fi
EOF
chmod +x "$stub/systemctl"
cat >"$stub/deb-systemd-helper" <<'EOF'
#!/bin/sh
# Armbian-created enable links need not be in Debian helper tracking state.
exit 0
EOF
chmod +x "$stub/deb-systemd-helper"
ln -sf /usr/lib/systemd/system/systemd-networkd.service "$root/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
: >"$calls"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" /bin/sh -c '
    set -eu
    IMAGE_MODE=1 DRY_RUN=0 YONDER_SYSTEMD_DIRS="$1/etc/systemd/system $1/usr/lib/systemd/system"
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    service_disable systemd-networkd.service
' sh "$root" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] && [ ! -L "$root/etc/systemd/system/multi-user.target.wants/systemd-networkd.service" ] \
    && grep -q '^systemctl --root=/ disable systemd-networkd.service$' "$calls"; then
    ok "image disable removes upstream enable links absent from Debian helper state"
else
    bad "upstream enablement survived the image disable boundary (exit $status)"
fi

: >"$calls"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" \
    /bin/sh -c '
        set -eu
        IMAGE_MODE=1 DRY_RUN=0
        YONDER_SYSTEMD_DIRS="$1/etc/systemd/system $1/usr/lib/systemd/system"
        . "$2/installer/lib/common.sh"
        . "$2/installer/lib/services.sh"
        service_enable yonder-core.service
        assert_unit_enabled yonder-core.service
        service_daemon_reload
        service_restart yonder-core.service
        service_stop yonder-core.service
    ' sh "$root" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && grep -q '^systemctl --root=/ enable yonder-core.service$' "$calls" \
    && ! grep -Eq 'daemon-reload|restart| stop ' "$calls"; then
    ok "image mode enables units on disk and emits no live service verbs"
else
    bad "image service helpers crossed the live service boundary (exit $status)"
    sed 's/^/      calls: /' "$calls"
    sed 's/^/      /' "$out"
fi

: >"$calls"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" \
    /bin/sh -c '
        set -eu
        IMAGE_MODE=0 DRY_RUN=0
        . "$1/installer/lib/common.sh"
        . "$1/installer/lib/services.sh"
        service_enable yonder-core.service
        service_daemon_reload
        service_restart yonder-core.service
        service_stop yonder-core.service
    ' sh "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && grep -q '^systemctl enable yonder-core.service$' "$calls" \
    && grep -q '^systemctl daemon-reload$' "$calls" \
    && grep -q '^systemctl restart yonder-core.service$' "$calls" \
    && grep -q '^systemctl stop yonder-core.service$' "$calls"; then
    ok "live mode retains enable, reload, restart and stop behavior"
else
    bad "live service behavior changed (exit $status)"
    sed 's/^/      calls: /' "$calls"
    sed 's/^/      /' "$out"
fi

empty_path="$tmp/empty-path"
mkdir -p "$empty_path"
set +e
PATH="$empty_path" /bin/sh -c '
    set -eu
    IMAGE_MODE=1 DRY_RUN=1
    . "$1/installer/lib/common.sh"
    . "$1/installer/lib/services.sh"
    service_enable yonder-core.service
' sh "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] && grep -q 'systemctl --root=/ enable yonder-core.service' "$out"; then
    ok "an image dry run describes offline enablement without requiring systemctl on the host"
else
    bad "image dry-run enablement depended on a host systemctl (exit $status)"
    sed 's/^/      /' "$out"
fi

printf '\n== hardware isolation\n'

for command in modprobe mount mountpoint udevadm gst-inspect-1.0; do
    cat >"$stub/$command" <<EOF
#!/bin/sh
printf '$command %s\\n' "\$*" >>"$calls"
exit 99
EOF
    chmod +x "$stub/$command"
done
: >"$calls"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" /bin/sh -c '
    set -eu
    IMAGE_MODE=1 DRY_RUN=0 YONDER_TARGET=rpi
    YONDER_MODULES_LOAD_DIR=$2
    YONDER_ACCESSORY_MODULES_CONF=$2/yonder-accessory.conf
    . "$1/installer/lib/common.sh"
    . "$1/installer/lib/services.sh"
    . "$1/installer/roles/18-accessory-usb.sh"
' sh "$REPO" "$tmp/modules-load.d" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] && [ ! -s "$calls" ] \
    && grep -q '^libcomposite$' "$tmp/modules-load.d/yonder-accessory.conf" \
    && grep -q '^usb_f_fs$' "$tmp/modules-load.d/yonder-accessory.conf"; then
    ok "image mode performs no configfs or module operations"
else
    bad "the accessory role operated host hardware in image mode (exit $status)"
    sed 's/^/      calls: /' "$calls"
    sed 's/^/      /' "$out"
fi

rock_payload="$tmp/vendor/gst-rockchip"
rock_lib="$tmp/gst-lib"
rock_plugins="$tmp/gst-plugins"
mkdir -p "$rock_payload/gstreamer-1.0" "$rock_payload/lib" "$rock_lib" "$rock_plugins"
rock_ref="$tmp/arm64-ref"
for elf in "$rock_ref" "$rock_payload/gstreamer-1.0/libgstrockchipmpp.so"; do
    dd if=/dev/zero of="$elf" bs=64 count=1 >/dev/null 2>&1
    printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\267\000' \
        | dd of="$elf" conv=notrunc >/dev/null 2>&1
done
printf 'library\n' >"$rock_payload/lib/librockchip-test.so"
: >"$calls"
cat >"$stub/dpkg-query" <<'EOF'
#!/bin/sh
printf 'Status: install ok installed\n'
EOF
chmod +x "$stub/dpkg-query"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" /bin/sh -c '
    set -eu
    IMAGE_MODE=1 DRY_RUN=0 YONDER_TARGET=radxa-zero3w
    YONDER_SRC=$1
    YONDER_ELF_REFERENCE=$6
    YONDER_GST_LIBDIR=$2
    YONDER_GST_PLUGIN_DIR=$3
    YONDER_GST_REGISTRY_DIRS=$4
    . "$5/installer/lib/common.sh"
    . "$5/installer/lib/services.sh"
    . "$5/installer/roles/52-gst-rockchip.sh"
' sh "$tmp" "$rock_lib" "$rock_plugins" "$tmp/registry" "$REPO" "$rock_ref" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && [ -f "$rock_plugins/libgstrockchipmpp.so" ] \
    && [ -f "$rock_lib/librockchip-test.so" ] \
    && ! grep -q '^gst-inspect-1.0 ' "$calls"; then
    ok "a declared Radxa image installs Rockchip files without probing an MPP device"
else
    bad "Rockchip image installation still depends on live encoder hardware (exit $status)"
    sed 's/^/      calls: /' "$calls"
    sed 's/^/      /' "$out"
fi

printf '\n== target preparation boundary\n'

set +e
/bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-rock5c
    . "$1/installer/lib/common.sh"
    . "$1/installer/lib/services.sh"
    . "$1/installer/targets/radxa-rock5c.sh"
    target_preflight
' sh "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] && grep -q 'ROCK 5C UART preparation is not qualified' "$out"; then
    ok "ROCK 5C fails before installation instead of receiving the ZERO 3W overlay"
else
    bad "ROCK 5C did not fail on its unqualified UART branch (exit $status)"
    sed 's/^/      /' "$out"
fi

rock5c_boot="$tmp/rock5c-boot"
mkdir -p "$rock5c_boot/dtb/rockchip/overlay"
printf 'fixture dtb\n' >"$rock5c_boot/dtb/rockchip/rk3588s-rock-5c.dtb"
cat >"$rock5c_boot/armbianEnv.txt" <<'EOF'
verbosity=1
console=both
overlay_prefix=rockchip-rk3588
fdtfile=rockchip/rk3588s-rock-5c.dtb
user_overlays=dwc3-host
overlays=spi1
EOF
cat >"$stub/fdtget" <<'EOF'
#!/bin/sh
case "$*" in
    *'/ compatible') printf '%s\n' 'radxa,rock-5c rockchip,rk3588s' ;;
    *'/serial@feb70000 status') printf '%s\n' okay ;;
    *'/serial@feb70000 pinctrl-0') printf '%s\n' 950 ;;
    *'/pinctrl/uart4/uart4m2-xfer phandle') printf '%s\n' 950 ;;
    *'/pinctrl/uart4/uart4m2-xfer rockchip,pins') \
        printf '%s\n' '1 10 10 383 1 11 10 383' ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$stub/fdtget"
set +e
PATH="$stub:$PATH" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 IMAGE_HARDWARE_TEST=1 YONDER_TARGET=radxa-rock5c
    YONDER_ARMBIAN_ENV=$1/armbianEnv.txt
    YONDER_DTB_OVERLAY_DIR=$1/dtb/rockchip/overlay
    YONDER_ROCK5C_DTB=$1/dtb/rockchip/rk3588s-rock-5c.dtb
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    . "$2/installer/targets/radxa-rock5c.sh"
    target_preflight
' sh "$rock5c_boot" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] && grep -q 'validated the exact ROCK 5C boot environment' "$out"; then
    ok "the ROCK 5C bench preflight accepts only its exact environment and compatible DTB"
else
    bad "the exact ROCK 5C bench fixture failed preflight (exit $status)"
    sed 's/^/      /' "$out"
fi

cp "$rock5c_boot/armbianEnv.txt" "$rock5c_boot/armbianEnv.good"
sed 's#fdtfile=rockchip/rk3588s-rock-5c.dtb#fdtfile=rockchip/rk3566-radxa-zero-3w.dtb#' \
    "$rock5c_boot/armbianEnv.good" >"$rock5c_boot/armbianEnv.txt"
set +e
PATH="$stub:$PATH" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 IMAGE_HARDWARE_TEST=1 YONDER_TARGET=radxa-rock5c
    YONDER_ARMBIAN_ENV=$1/armbianEnv.txt
    YONDER_ROCK5C_DTB=$1/dtb/rockchip/rk3588s-rock-5c.dtb
    . "$2/installer/lib/common.sh"
    . "$2/installer/targets/radxa-rock5c.sh"
    target_preflight
' sh "$rock5c_boot" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" != 0 ] \
    && grep -q 'must contain exactly fdtfile=rockchip/rk3588s-rock-5c.dtb' "$out"; then
    ok "the ROCK 5C bench preflight rejects a different board DTB before mutation"
else
    bad "the ROCK 5C bench preflight accepted the wrong DTB selection (exit $status)"
    sed 's/^/      /' "$out"
fi
mv "$rock5c_boot/armbianEnv.good" "$rock5c_boot/armbianEnv.txt"

printf 'fixture overlay\n' >"$rock5c_boot/dtb/rockchip/overlay/rk3588-uart4-m2.dtbo"
cat >"$stub/fdtoverlay" <<'EOF'
#!/bin/sh
out=
input=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -i) shift; input=$1 ;;
        -o) shift; out=$1 ;;
    esac
    shift
done
[ -n "$input" ] && [ -n "$out" ] || exit 2
cp "$input" "$out"
EOF
chmod +x "$stub/fdtoverlay"
set +e
PATH="$stub:$PATH" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 IMAGE_HARDWARE_TEST=1 YONDER_TARGET=radxa-rock5c
    YONDER_ARMBIAN_ENV=$1/armbianEnv.txt
    YONDER_DTB_OVERLAY_DIR=$1/dtb/rockchip/overlay
    YONDER_ROCK5C_DTB=$1/dtb/rockchip/rk3588s-rock-5c.dtb
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    . "$2/installer/targets/radxa-rock5c.sh"
    target_preflight
    target_prepare_uart
' sh "$rock5c_boot" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && grep -q '^console=both$' "$rock5c_boot/armbianEnv.txt" \
    && grep -q '^user_overlays=dwc3-host$' "$rock5c_boot/armbianEnv.txt" \
    && grep -q '^overlays=spi1 rk3588-uart4-m2$' "$rock5c_boot/armbianEnv.txt" \
    && ! grep -q 'uart2-m0' "$rock5c_boot/armbianEnv.txt"; then
    ok "ROCK 5C stages UART4_M2 only after offline DT application and preserves UART2"
else
    bad "ROCK 5C UART staging failed its DT or console boundary (exit $status)"
    sed 's/^/      /' "$out"
    sed 's/^/      env: /' "$rock5c_boot/armbianEnv.txt"
fi

sed 's/^overlays=.*/overlays=spi1/' "$rock5c_boot/armbianEnv.txt" \
    >"$rock5c_boot/armbianEnv.pending"
mv "$rock5c_boot/armbianEnv.pending" "$rock5c_boot/armbianEnv.txt"
cp "$rock5c_boot/armbianEnv.txt" "$rock5c_boot/armbianEnv.before"
cat >"$stub/fdtget" <<'EOF'
#!/bin/sh
case "$*" in
    *'/ compatible') printf '%s\n' 'radxa,rock-5c rockchip,rk3588s' ;;
    *'/serial@feb70000 status') printf '%s\n' okay ;;
    *'/serial@feb70000 pinctrl-0') printf '%s\n' 950 ;;
    *'/pinctrl/uart4/uart4m2-xfer phandle') printf '%s\n' 950 ;;
    *'/pinctrl/uart4/uart4m2-xfer rockchip,pins') \
        printf '%s\n' '1 10 9 383 1 11 9 383' ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$stub/fdtget"
set +e
PATH="$stub:$PATH" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 IMAGE_HARDWARE_TEST=1 YONDER_TARGET=radxa-rock5c
    YONDER_ARMBIAN_ENV=$1/armbianEnv.txt
    YONDER_DTB_OVERLAY_DIR=$1/dtb/rockchip/overlay
    YONDER_ROCK5C_DTB=$1/dtb/rockchip/rk3588s-rock-5c.dtb
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/services.sh"
    . "$2/installer/targets/radxa-rock5c.sh"
    target_preflight
    target_prepare_uart
' sh "$rock5c_boot" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && cmp -s "$rock5c_boot/armbianEnv.before" "$rock5c_boot/armbianEnv.txt" \
    && grep -q 'applied tree does not enable /serial@feb70000' "$out"; then
    ok "an applied ROCK 5C overlay with the wrong pin function remains explicitly pending"
else
    bad "a ROCK 5C overlay with the wrong pin function changed boot state (exit $status)"
    sed 's/^/      /' "$out"
fi

rpi_boot="$tmp/rpi-boot"
mkdir -p "$rpi_boot" "$tmp/no-systemd"
printf 'gpu_mem=16\n' >"$rpi_boot/config.txt"
printf 'console=tty1 console=serial0,115200 root=LABEL=rootfs quiet\n' >"$rpi_boot/cmdline.txt"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=rpi YONDER_BOOT_DIR=$1
    YONDER_SYSTEMD_DIRS=$2
    . "$3/installer/lib/common.sh"
    . "$3/installer/lib/services.sh"
    . "$3/installer/targets/rpi.sh"
    target_preflight
    target_prepare_uart
' sh "$rpi_boot" "$tmp/no-systemd" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && grep -q '^# yonder-uart$' "$rpi_boot/config.txt" \
    && ! grep -q 'console=serial0' "$rpi_boot/cmdline.txt"; then
    ok "the rpi candidate writes only its Pi-layout UART preparation"
else
    bad "the rpi target preparation failed its filesystem post-conditions (exit $status)"
    sed 's/^/      /' "$out"
fi

rock5c_netplan="$tmp/rock5c-netplan"
rock5c_netplan_disabled="$tmp/rock5c-netplan.disabled"
mkdir -p "$rock5c_netplan"
printf 'network:\n  version: 2\n' >"$rock5c_netplan/10-armbian.yaml"
: >"$calls"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 IMAGE_HARDWARE_TEST=1 YONDER_TARGET=radxa-rock5c
    YONDER_NETPLAN_DIR=$1 YONDER_NETPLAN_DISABLED_DIR=$2
    YONDER_SYSTEMD_DIRS="$3/etc/systemd/system $3/usr/lib/systemd/system"
    . "$4/installer/lib/common.sh"
    . "$4/installer/lib/services.sh"
    . "$4/installer/targets/radxa-rock5c.sh"
    target_prepare_network
' sh "$rock5c_netplan" "$rock5c_netplan_disabled" "$root" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && [ ! -e "$rock5c_netplan/10-armbian.yaml" ] \
    && [ -f "$rock5c_netplan_disabled/10-armbian.yaml" ] \
    && grep -q '^systemctl --root=/ enable NetworkManager.service$' "$calls" \
    && grep -q '^systemctl --root=/ disable systemd-networkd.service$' "$calls" \
    && grep -q "NetworkManager access point; Ethernet is not required" "$out" \
    && ! grep -Eq ' restart | stop |daemon-reload' "$calls"; then
    ok "the ROCK 5C bench image hands networking to the offline AP-first configuration"
else
    bad "the ROCK 5C network handoff was not AP-first and offline (exit $status)"
    sed 's/^/      calls: /' "$calls"
    sed 's/^/      /' "$out"
fi

zero_boot="$tmp/zero-boot"
mkdir -p "$zero_boot/dtb/rockchip/overlay" "$zero_boot/overlay-user"
printf 'dtbo\n' >"$zero_boot/dtb/rockchip/overlay/rk3568-uart2-m0.dtbo"
printf 'console=both\nuser_overlays=dwc3-host\n' >"$zero_boot/armbianEnv.txt"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_ARMBIAN_ENV=$1/armbianEnv.txt
    YONDER_DTB_OVERLAY_DIR=$1/dtb/rockchip/overlay
    YONDER_USER_OVERLAY_DIR=$1/overlay-user
    YONDER_SYSTEMD_DIRS=$2
    . "$3/installer/lib/common.sh"
    . "$3/installer/lib/services.sh"
    . "$3/installer/targets/radxa-zero3w.sh"
    target_preflight
    target_prepare_uart
' sh "$zero_boot" "$tmp/no-systemd" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && [ -f "$zero_boot/overlay-user/uart2-m0.dtbo" ] \
    && grep -q '^console=display$' "$zero_boot/armbianEnv.txt" \
    && grep -q '^user_overlays=dwc3-host uart2-m0$' "$zero_boot/armbianEnv.txt"; then
    ok "the ZERO 3W candidate applies the previously observed UART2 overlay and console handoff"
else
    bad "the ZERO 3W target preparation failed its filesystem post-conditions (exit $status)"
    sed 's/^/      /' "$out"
fi

netplan="$tmp/netplan"
netplan_disabled="$tmp/netplan.disabled"
mkdir -p "$netplan"
printf 'network:\n  version: 2\n' >"$netplan/10-armbian.yaml"
: >"$calls"
set +e
PATH="$stub:$PATH" YONDER_TEST_CALLS="$calls" YONDER_TEST_ROOT="$root" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_NETPLAN_DIR=$1 YONDER_NETPLAN_DISABLED_DIR=$2
    YONDER_SYSTEMD_DIRS="$3/etc/systemd/system $3/usr/lib/systemd/system"
    . "$4/installer/lib/common.sh"
    . "$4/installer/lib/services.sh"
    . "$4/installer/targets/radxa-zero3w.sh"
    target_prepare_network
' sh "$netplan" "$netplan_disabled" "$root" "$REPO" >"$out" 2>&1
status=$?
set -e
if [ "$status" = 0 ] \
    && [ ! -e "$netplan/10-armbian.yaml" ] \
    && [ -f "$netplan_disabled/10-armbian.yaml" ] \
    && grep -q '^systemctl --root=/ enable NetworkManager.service$' "$calls" \
    && ! grep -Eq ' restart | stop |daemon-reload' "$calls"; then
    ok "the ZERO 3W image retires netplan and enables NetworkManager entirely offline"
else
    bad "the ZERO 3W network handoff did not stay within the image filesystem (exit $status)"
    sed 's/^/      calls: /' "$calls"
    sed 's/^/      /' "$out"
fi

printf '\n== result\n'
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
