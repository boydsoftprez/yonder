#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Online-only capture of the target package delta for one exact locked base.
set -euo pipefail
umask 077

RUNTIME='debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1'
CAPTURE_ROOT_BYTES=$((6 * 1024 * 1024 * 1024))

usage() {
    echo 'Usage: image/inputs/capture-apt.sh --target TARGET --base BASE.img.xz --payload PAYLOAD_COMPONENTS_DIRECTORY --output NEW_DIRECTORY'
}

if [[ ${1:-} == --inside ]]; then
    [[ $# == 1 && -f /.dockerenv && -n ${YONDER_TARGET:-} && -n ${BASE_SHA256:-} \
        && -n ${RAW_SHA256:-} && ${ROOT_START:-} =~ ^[0-9]+$ && ${ROOT_SIZE:-} =~ ^[0-9]+$ \
        && -f /base/base.img.xz && -d /output && -d /payload-zerotier ]]
    export DEBIAN_FRONTEND=noninteractive
    apt-get update >/dev/null
    apt-get install -y --no-install-recommends dpkg-dev e2fsprogs python3 util-linux xz-utils >/dev/null

    scratch=$(mktemp -d /tmp/yonder-apt-capture.XXXXXX)
    disk=$scratch/base.img
    target=$scratch/root
    loop=
    output_bind=
    mounted=()
    # shellcheck disable=SC2329 # invoked by EXIT/INT/TERM traps
    cleanup() {
        status=$?
        trap - EXIT
        set +e
        failed=0
        if [[ -n $output_bind ]] && mountpoint -q "$output_bind"; then
            umount "$output_bind" || failed=1
        fi
        for ((index=${#mounted[@]} - 1; index >= 0; index--)); do
            path=${mounted[index]}
            if mountpoint -q "$path"; then umount "$path" || failed=1; fi
        done
        if [[ -n $loop ]]; then
            backing=$(losetup -n -O BACK-FILE "$loop" 2>/dev/null || true)
            if [[ $backing == "$disk" ]]; then
                losetup -d "$loop" || failed=1
            elif [[ -n $backing ]]; then
                failed=1
            fi
        fi
        if findmnt -rn -o TARGET | grep -Eq "^${scratch}(/|$)"; then failed=1; fi
        if losetup --associated "$disk" 2>/dev/null | grep -q .; then failed=1; fi
        if [[ $failed != 0 ]]; then
            echo "error: cleanup failed; retaining $scratch and its container for inspection" >&2
            exit 125
        fi
        rm -rf "$scratch"
        exit "$status"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    printf '%s  %s\n' "$BASE_SHA256" /base/base.img.xz | sha256sum -c -
    xz -dc /base/base.img.xz >"$disk"
    printf '%s  %s\n' "$RAW_SHA256" "$disk" | sha256sum -c -
    minimum_disk_bytes=$((ROOT_START * 512 + CAPTURE_ROOT_BYTES))
    if (( $(stat -c %s "$disk") < minimum_disk_bytes )); then
        truncate -s "$minimum_disk_bytes" "$disk"
    fi
    loop=$(losetup --find --show --offset "$((ROOT_START * 512))" \
        --sizelimit "$CAPTURE_ROOT_BYTES" "$disk")
    [[ $(losetup -n -O BACK-FILE "$loop") == "$disk" ]]
    resize2fs "$loop"
    mkdir -p "$target"
    mount -o rw "$loop" "$target"
    mounted+=("$target")
    mount -t proc proc "$target/proc"
    mounted+=("$target/proc")
    mount -t tmpfs -o mode=755 tmpfs "$target/dev"
    mounted+=("$target/dev")
    for spec in 'null 1 3' 'zero 1 5' 'random 1 8' 'urandom 1 9' 'tty 5 0'; do
        read -r name major minor <<<"$spec"
        mknod -m 666 "$target/dev/$name" c "$major" "$minor"
    done
    mkdir "$target/dev/pts"
    mount -t devpts -o newinstance,ptmxmode=0666 devpts "$target/dev/pts"
    mounted+=("$target/dev/pts")
    ln -s pts/ptmx "$target/dev/ptmx"
    mount -t tmpfs -o mode=755 tmpfs "$target/run"
    mounted+=("$target/run")

    mkdir -p /output/{notices,repo,sources} /output/repo/partial
    mkdir -p "$target/opt/yonder-apt-capture"
    mount --bind /output "$target/opt/yonder-apt-capture"
    output_bind=$target/opt/yonder-apt-capture
    rm -f "$target/etc/resolv.conf"
    cp /etc/resolv.conf "$target/etc/resolv.conf"
    chmod 0644 "$target/etc/resolv.conf"
    printf '#!/bin/sh\nexit 101\n' >"$target/usr/sbin/policy-rc.d"
    chmod 0755 "$target/usr/sbin/policy-rc.d"

    resolved=0
    for _ in {1..10}; do
        if chroot "$target" /usr/sbin/runuser -u _apt -- test -r /etc/resolv.conf \
                && chroot "$target" /usr/sbin/runuser -u _apt -- \
                    getent ahostsv4 deb.debian.org >/dev/null; then
            resolved=1
            break
        fi
        sleep 1
    done
    [[ $resolved == 1 ]] || {
        echo 'error: copied target root cannot resolve package repositories' >&2
        exit 1
    }

    # Work on the disposable base copy. Source indexes are required so every
    # repository binary captured below has its exact source package retained.
    while IFS= read -r -d '' list; do
        awk '{ print; if ($1 == "deb") { sub(/^deb[[:space:]]+/, "deb-src "); print } }' \
            "$list" >"$list.new"
        mv "$list.new" "$list"
    done < <(find "$target/etc/apt" -type f -name '*.list' -print0)
    while IFS= read -r -d '' source; do
        sed -i -E 's/^Types:[[:space:]]*deb([[:space:]]*)$/Types: deb deb-src/' "$source"
    done < <(find "$target/etc/apt" -type f -name '*.sources' -print0)
    chroot "$target" apt-get -o APT::Update::Error-Mode=any update

    # shellcheck source=../package-sets.sh
    source /source/image/package-sets.sh
    mapfile -t packages < <(yonder_packages "$YONDER_TARGET")
    mapfile -t direct_packages < <(yonder_direct_packages "$YONDER_TARGET")
    mapfile -t role_packages < <(yonder_role_packages "$YONDER_TARGET")
    printf '%s\n' "${packages[@]}" >/output/requested-packages.txt
    install_packages=("${direct_packages[@]}")
    for package in "${role_packages[@]}"; do
        # shellcheck disable=SC2016 # dpkg-query expands its own format field
        if ! chroot "$target" dpkg-query -W -f='${Status}' "$package" 2>/dev/null \
                | grep -qx 'install ok installed'; then
            install_packages+=("$package")
        fi
    done
    mapfile -t install_packages < <(printf '%s\n' "${install_packages[@]}" | sort -u)
    printf '%s\n' "${install_packages[@]}" >/output/install-packages.txt
    apt_packages=()
    for package in "${install_packages[@]}"; do
        [[ $package == zerotier-one ]] || apt_packages+=("$package")
    done
    mapfile -t zerotier_debs < <(find /payload-zerotier -maxdepth 1 -type f -name 'zerotier-one_*_arm64.deb' -print)
    [[ ${#zerotier_debs[@]} == 1 ]]
    cp "${zerotier_debs[0]}" "$target/tmp/zerotier-one.deb"
    chroot "$target" env DEBIAN_FRONTEND=noninteractive apt-get install -y --download-only \
        --no-install-recommends -o Dir::Cache::archives=/opt/yonder-apt-capture/repo \
        "${apt_packages[@]}" /tmp/zerotier-one.deb
    cp "${zerotier_debs[0]}" /output/repo/
    rm "$target/tmp/zerotier-one.deb"
    rm -f /output/repo/lock
    rmdir /output/repo/partial

    : >/output/packages.tsv
    : >/output/notice-links.tsv
    : >/output/source-requests.tsv
    for deb in /output/repo/*.deb; do
        package=$(dpkg-deb -f "$deb" Package)
        version=$(dpkg-deb -f "$deb" Version)
        architecture=$(dpkg-deb -f "$deb" Architecture)
        source_field=$(dpkg-deb -f "$deb" Source 2>/dev/null || true)
        if [[ -n $source_field ]]; then
            source_package=${source_field%% *}
            case "$source_field" in
                *' ('*')') source_version=${source_field#* (}; source_version=${source_version%)} ;;
                *) source_version=$version ;;
            esac
        else
            source_package=$package
            source_version=$version
        fi
        digest=$(sha256sum "$deb" | cut -d' ' -f1)
        bytes=$(stat -c %s "$deb")
        printf 'repo/%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
            "${deb##*/}" "$package" "$version" "$architecture" \
            "$source_package" "$source_version" "$digest" "$bytes" >>/output/packages.tsv
        if [[ $package != zerotier-one ]]; then
            printf '%s\t%s\n' "$source_package" "$source_version" >>/output/source-requests.tsv
        fi
        extract=$scratch/notice-$package
        mkdir "$extract"
        dpkg-deb -x "$deb" "$extract"
        package_doc=$extract/usr/share/doc/$package
        if [[ -f $package_doc/copyright ]]; then
            cp "$package_doc/copyright" "/output/notices/${package}.copyright"
        else
            [[ -L $package_doc ]]
            notice_target=$(readlink "$package_doc")
            [[ $notice_target =~ ^[a-z0-9][a-z0-9+.-]+$ \
                && -f $target/usr/share/doc/$notice_target/copyright ]]
            cp "$target/usr/share/doc/$notice_target/copyright" \
                "/output/notices/${package}.copyright"
            printf '%s\t%s\n' "$package" "$notice_target" >>/output/notice-links.tsv
        fi
    done
    sort -u -o /output/source-requests.tsv /output/source-requests.tsv
    sort -t $'\t' -k2,2 -k3,3 -o /output/packages.tsv /output/packages.tsv

    (
        cd /output/repo
        dpkg-scanpackages --multiversion . /dev/null >Packages
        gzip -n -9 <Packages >Packages.gz
    )
    source_arguments=()
    while IFS=$'\t' read -r source_package source_version; do
        source_arguments+=("$source_package=$source_version")
    done </output/source-requests.tsv
    # One APT invocation avoids reparsing the same source indexes hundreds of
    # times and still fails the capture if any exact source version is absent.
    chroot "$target" /bin/sh -c \
        'cd /opt/yonder-apt-capture/sources && shift && exec apt-get source --download-only "$@"' \
        sh placeholder "${source_arguments[@]}"
    : >/output/source-packages.tsv
    while IFS=$'\t' read -r source_package source_version; do
        dsc_name=${source_package}_${source_version#*:}.dsc
        dsc=/output/sources/$dsc_name
        [[ -f $dsc && ! -L $dsc ]]
        printf 'sources/%s\t%s\t%s\t%s\t%s\n' "$dsc_name" "$source_package" \
            "$source_version" "$(sha256sum "$dsc" | cut -d' ' -f1)" \
            "$(stat -c %s "$dsc")" >>/output/source-packages.tsv
    done </output/source-requests.tsv

    python3 -I - "$YONDER_TARGET" "$BASE_SHA256" "$RAW_SHA256" <<'PY'
import hashlib
import json
import os
import sys

requested = open('/output/requested-packages.txt', 'rb').read()
install = open('/output/install-packages.txt', 'rb').read()
binary_count = sum(name.endswith('.deb') for name in os.listdir('/output/repo'))
source_count = sum(1 for line in open('/output/source-requests.tsv', encoding='utf-8') if line.strip())
repo_bytes = sum(os.path.getsize('/output/repo/' + name)
                 for name in os.listdir('/output/repo') if name.endswith('.deb'))
source_bytes = sum(os.path.getsize('/output/sources/' + name)
                   for name in os.listdir('/output/sources'))
manifest = {
    'schemaVersion': 1,
    'kind': 'yonder-target-apt-input',
    'target': sys.argv[1],
    'baseCompressedSha256': sys.argv[2],
    'baseRawSha256': sys.argv[3],
    'requestedPackagesSha256': hashlib.sha256(requested).hexdigest(),
    'installPackagesSha256': hashlib.sha256(install).hexdigest(),
    'binaryPackageCount': binary_count,
    'sourcePackageCount': source_count,
    'repositoryDebBytes': repo_bytes,
    'sourceArchiveBytes': source_bytes,
    'resolverPreflightUser': '_apt',
    'vendorSourceArchivesOutsideThisInput': ['zerotier-one'],
}
with open('/output/capture.json', 'w', encoding='utf-8') as stream:
    json.dump(manifest, stream, indent=2, sort_keys=True)
    stream.write('\n')
PY
    (
        cd /output
        find . -type l -o ! -type d ! -type f | grep -q . && exit 1
        find . -type f ! -name SHA256SUMS -print0 | sort -z \
            | xargs -0 sha256sum >"$scratch/SHA256SUMS"
        cp "$scratch/SHA256SUMS" SHA256SUMS
    )
    chown -R root:root /output
    chmod -R a+rX /output
    if find /output -xdev \( ! -uid 0 -o ! -gid 0 \) -print -quit | grep -q .; then
        echo 'error: captured APT output is not wholly root-owned' >&2
        exit 1
    fi
    echo "Captured $(find /output/repo -name '*.deb' | wc -l) binary packages for $YONDER_TARGET."
    exit 0
fi

target=
base=
payload=
output=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target) target=${2:-}; shift 2 ;;
        --base) base=${2:-}; shift 2 ;;
        --payload) payload=${2:-}; shift 2 ;;
        --output) output=${2:-}; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
[[ $target == rpi || $target == radxa-zero3w || $target == radxa-rock5c ]]
[[ -f $base && ! -L $base && -n $output && ! -e $output ]]
[[ -n $payload ]] || {
    echo 'error: --payload is required and must name the captured payload component directory' >&2
    exit 1
}
[[ -d $payload && ! -L $payload ]] || {
    echo 'error: --payload is not a real directory' >&2
    exit 1
}
base=$(CDPATH='' cd -- "$(dirname -- "$base")" && pwd)/$(basename -- "$base")
payload=$(CDPATH='' cd -- "$payload" && pwd)
payload_zerotier=$payload/zerotier
[[ -d $payload_zerotier && ! -L $payload_zerotier ]] || {
    echo 'error: payload has no real zerotier component directory' >&2
    exit 1
}
zerotier_debs=()
while IFS= read -r -d '' candidate; do zerotier_debs+=("$candidate"); done \
    < <(find "$payload_zerotier" -mindepth 1 -maxdepth 1 -type f \
        -name 'zerotier-one_*_arm64.deb' -print0)
if [[ ${#zerotier_debs[@]} != 1 ]] \
        || find "$payload_zerotier" -mindepth 1 -maxdepth 1 \
            \( -type l -o ! -type f \) -print -quit | grep -q .; then
    echo 'error: payload zerotier component must contain exactly one regular ARM64 deb' >&2
    exit 1
fi
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
read -r base_sha raw_sha root_start root_size < <(node - "$repo" "$target" <<'JS'
const fs = require('fs');
const path = require('path');
const [repo, target] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'image/bases.lock.json')));
const inspection = JSON.parse(fs.readFileSync(path.join(repo, `image/inspection/${target}.json`)));
const base = lock.targets[target];
const root = target === 'rpi' ? inspection.partitions[1] : inspection.partitions[0];
if (!base || inspection.compressedSha256 !== base.sha256 || root.filesystem?.type !== 'ext4') process.exit(1);
process.stdout.write(`${base.sha256} ${inspection.rawSha256} ${root.startSector} ${root.sectorCount}\n`);
JS
)
[[ $(sha256sum "$base" | cut -d' ' -f1) == "$base_sha" ]]
mkdir -m 0700 "$output"
output=$(CDPATH='' cd -- "$output" && pwd)
container="yonder-apt-capture-$$-$RANDOM"
retain_host=0
# shellcheck disable=SC2329 # invoked by EXIT/INT/TERM traps
cleanup_host() {
    if [[ $retain_host == 0 ]]; then
        [[ -z ${container:-} ]] || docker rm -f "$container" >/dev/null 2>&1 || true
    fi
}
# shellcheck disable=SC2329 # invoked by INT/TERM traps
interrupt_host() {
    retain_host=1
    echo "error: capture host interrupted; retained private container $container" >&2
    exit "$1"
}
trap cleanup_host EXIT
trap 'interrupt_host 130' INT
trap 'interrupt_host 143' TERM
docker run -d --name "$container" --privileged --platform linux/arm64 \
    -e "YONDER_TARGET=$target" -e "BASE_SHA256=$base_sha" -e "RAW_SHA256=$raw_sha" \
    -e "ROOT_START=$root_start" -e "ROOT_SIZE=$root_size" \
    -v "$repo:/source:ro" -v "$base:/base/base.img.xz:ro" \
    -v "$payload_zerotier:/payload-zerotier:ro" -v "$output:/output" \
    "$RUNTIME" sleep infinity >/dev/null
set +e
docker exec "$container" /bin/bash /source/image/inputs/capture-apt.sh --inside
capture_status=$?
set -e
if [[ $capture_status == 125 ]]; then
    retain_host=1
    echo "error: capture cleanup failed; retained private container $container" >&2
    exit 1
fi
docker rm -f "$container" >/dev/null
container=
exit "$capture_status"
