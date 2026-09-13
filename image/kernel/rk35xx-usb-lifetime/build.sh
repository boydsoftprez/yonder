#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -eE -o pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $# = 1 && $(uname -s) = Linux && $(uname -m) = aarch64 ]] || {
    echo 'Usage (Linux ARM64): build.sh NEW_WORK_DIRECTORY' >&2
    exit 2
}
work=$1
[[ ! -e $work && $work != *[[:space:]]* ]] || {
    echo 'Work directory must be new and contain no whitespace.' >&2
    exit 2
}
for tool in git sha256sum patch make aarch64-linux-gnu-gcc dpkg bison flex bc pahole depmod readelf tar gzip sort xargs; do
    command -v "$tool" >/dev/null
done
[[ $(aarch64-linux-gnu-gcc -dumpfullversion) = 14.2.0 ]]
printf '%s  %s\n' 8b5661999dbc4b7a1087f1d9c6b335ab6228360ee901da922e71de191f994f99 "$here/kernel.config" | sha256sum -c -
printf '%s  %s\n' 5e6468e883e5beebb565242bca18129afd085fffdecbabdb75b35b6e55a7b868 "$here/configfs-lifetime.patch" | sha256sum -c -
jobs=${YONDER_KERNEL_JOBS:-6}
[[ $jobs =~ ^[1-9][0-9]*$ && $jobs -le 32 ]] || exit 2
mkdir -p "$work"
work=$(cd -- "$work" && pwd)
SRC=$work/armbian
kerneldir=$work/linux
fetch_pinned() {
    local destination=$1 url=$2 commit=$3
    mkdir -p "$destination"
    git -C "$destination" init -q
    git -C "$destination" remote add origin "$url"
    git -C "$destination" fetch --quiet --depth=1 origin "$commit"
    git -C "$destination" checkout --quiet --detach FETCH_HEAD
    [[ $(git -C "$destination" rev-parse HEAD) = "$commit" ]]
}
fetch_pinned "$kerneldir" https://github.com/armbian/linux-rockchip 5280f9b4336199c4025c8eed894d2b4e2268dcc6
fetch_pinned "$SRC" https://github.com/armbian/build d28c4c8ec9aa8ba5f272a5c8cc8b98b683cdecd4
version=6.1
LINUXFAMILY=rk35xx
GITHUB_SOURCE=https://github.com
KERNEL_MAJOR_MINOR=6.1
export KERNEL_MAJOR_MINOR version LINUXFAMILY GITHUB_SOURCE
# Keep the pinned recipe's driver functions intact; provide only fetch/log/patch plumbing.
display_alert() { printf '%s %s\n' "$1" "${2:-}"; }
linux-version() { test "$1" = compare; dpkg --compare-versions "$2" "$3" "$4"; }
process_patch_file() { printf 'Applying %s\n' "$1"; patch --batch --forward --no-backup-if-mismatch -p1 < "$1"; }
fetch_from_repo() {
 local url=$1 name=$2 ref=$3 commit=${3#commit:} dest
 [[ $ref == commit:* && $commit =~ ^[0-9a-f]{40}$ ]] || return 2
 dest=$SRC/cache/sources/$name/$commit
 if [[ ! -d $dest/.git ]]; then
  mkdir -p "$dest"
  git -C "$dest" init -q
  git -C "$dest" remote add origin "$url"
  git -C "$dest" fetch --quiet --depth=1 origin "$commit"
  git -C "$dest" checkout --quiet --detach FETCH_HEAD
 fi
 [[ $(git -C "$dest" rev-parse HEAD) == "$commit" ]]
}
# shellcheck disable=SC1091 # exact upstream source fetched above
source "$SRC/lib/functions/compilation/patch/drivers_network.sh"
mapfile -t drivers < <(sed -n '/declare -a all_drivers=(/,/^[[:space:]]*)/p' "$SRC/lib/functions/compilation/patch/drivers-harness.sh" | sed -n 's/^[[:space:]]*\(driver_[a-zA-Z0-9_]*\)[[:space:]]*$/\1/p')
[[ ${#drivers[@]} = 21 ]]
for driver in "${drivers[@]}"; do
 cd "$kerneldir"
 printf 'Driver recipe: %s\n' "$driver"
 "$driver"
done
cd "$kerneldir"
for p in "$SRC"/patch/kernel/rk35xx-vendor-6.1/*.patch; do process_patch_file "$p"; done
# This exact patchset contains no DT source overlay directory.
[[ ! -d $SRC/patch/kernel/rk35xx-vendor-6.1/dt ]]
printf '%s  %s\n' abccff52b88be8ff62e73369d804f50545fecf52846b20e5b581aed3703cb2f8 drivers/usb/gadget/configfs.c | sha256sum -c -
patch --batch --forward -p1 < "$here/configfs-lifetime.patch"
cp "$here/kernel.config" .config
make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- LOCALVERSION=-vendor-rk35xx olddefconfig
# Refuse a toolchain or Kconfig change rather than silently changing the ABI.
cmp .config "$here/kernel.config"
make -j"$jobs" ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- LOCALVERSION=-vendor-rk35xx \
    KBUILD_BUILD_USER=yonder KBUILD_BUILD_HOST=mule-usb-lifetime-fix KBUILD_BUILD_VERSION=1 Image modules
mkdir "$work/output"
cp arch/arm64/boot/Image System.map Module.symvers "$work/output/"
cp .config "$work/output/kernel.config"
release=$(make -s ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- LOCALVERSION=-vendor-rk35xx kernelrelease)
[[ $release = 6.1.115-vendor-rk35xx ]]
module_stage=$work/modules-stage
make -s ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- LOCALVERSION=-vendor-rk35xx \
    INSTALL_MOD_PATH="$module_stage" INSTALL_MOD_STRIP=1 modules_install
module_root=$module_stage/lib/modules/$release
[[ -d $module_root ]]
# modules_install adds links for local module development.  They must never point
# from a deployment archive back at the builder's source tree.
rm -f "$module_root/build" "$module_root/source"
[[ -z $(find "$module_stage" -type l -print -quit) ]]
for module in \
    kernel/net/ipv6/ipv6.ko \
    kernel/net/bluetooth/hidp/hidp.ko \
    kernel/net/bluetooth/rfcomm/rfcomm.ko; do
    readelf -SW "$module_root/$module" | grep -q '[[:space:]][.]BTF[[:space:]]'
done
for metadata in modules.order modules.builtin modules.builtin.modinfo; do
    [[ -s $module_root/$metadata ]]
done
module_manifest=$module_stage/MODULES.SHA256
(cd "$module_stage" && find lib -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >"$module_manifest")
module_metadata=$module_stage/PAYLOAD-METADATA.txt
{
    printf 'release=%s\n' "$release"
    printf 'image_sha256=%s\n' "$(sha256sum arch/arm64/boot/Image | awk '{print $1}')"
    printf 'config_sha256=%s\n' "$(sha256sum .config | awk '{print $1}')"
    printf 'module_symvers_sha256=%s\n' "$(sha256sum Module.symvers | awk '{print $1}')"
    printf 'system_map_sha256=%s\n' "$(sha256sum System.map | awk '{print $1}')"
    printf 'modules_install=INSTALL_MOD_STRIP=1\n'
    printf 'in_tree_ko_count=%s\n' "$(find "$module_root/kernel" -type f -name '*.ko' | wc -l)"
    printf 'builder_path_symlinks=none\n'
    printf 'external_dkms=excluded\n'
    printf 'btf_verified=ipv6,hidp,rfcomm\n'
} >"$module_metadata"
module_archive=$work/output/kernel-modules-$release.tar.gz
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -C "$module_stage" -cf - lib MODULES.SHA256 PAYLOAD-METADATA.txt | gzip -n >"$module_archive"
tar -tzf "$module_archive" | grep -Fx "lib/modules/$release/modules.order" >/dev/null
tar -tzf "$module_archive" | grep -Fx "lib/modules/$release/modules.builtin" >/dev/null
tar -tzf "$module_archive" | grep -Fx "lib/modules/$release/modules.builtin.modinfo" >/dev/null
cp "$module_manifest" "$work/output/kernel-modules-$release.manifest.sha256"
cp "$module_metadata" "$work/output/kernel-modules-$release.metadata"
(cd "$work/output" && sha256sum Image System.map Module.symvers kernel.config \
    "kernel-modules-$release.tar.gz" "kernel-modules-$release.manifest.sha256" \
    "kernel-modules-$release.metadata" >SHA256SUMS)
printf 'Built %s/output; installation and hardware qualification are separate.\n' "$work"
