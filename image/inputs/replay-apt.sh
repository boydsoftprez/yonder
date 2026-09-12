#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Prove a captured package set installs on a fresh copy of its exact base with
# the container network disabled and no configured repository fallback.
set -euo pipefail
umask 077

RUNTIME='debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1'
REPLAY_ROOT_BYTES=$((6 * 1024 * 1024 * 1024))

usage() {
    echo 'Usage: image/inputs/replay-apt.sh --target TARGET --base BASE.img.xz --input CAPTURE_DIRECTORY --output NEW_DIRECTORY'
}

if [[ ${1:-} == --inside ]]; then
    [[ $# == 1 && -f /.dockerenv && -n ${YONDER_TARGET:-} && -n ${BASE_SHA256:-} \
        && -n ${RAW_SHA256:-} && ${ROOT_START:-} =~ ^[0-9]+$ && ${ROOT_SIZE:-} =~ ^[0-9]+$ \
        && -f /base/base.img && -d /input && -d /output ]]
    scratch=$(mktemp -d /tmp/yonder-apt-replay.XXXXXX)
    disk=$scratch/base.img
    target=$scratch/root
    loop=
    input_bind=
    mounted=()
    # shellcheck disable=SC2329 # invoked by EXIT/INT/TERM traps
    cleanup() {
        status=$?
        trap - EXIT
        set +e
        local path backing
        failed=0
        if [[ -n $input_bind ]] && mountpoint -q "$input_bind"; then
            umount "$input_bind" || failed=1
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

    # Validate the complete input before mounting or changing the base copy.
    [[ -f /input/SHA256SUMS && -f /input/capture.json && -f /input/packages.tsv \
        && -f /input/source-packages.tsv && -f /input/source-requests.tsv \
        && -f /input/notice-links.tsv && -d /input/notices \
        && -f /input/requested-packages.txt && -f /input/install-packages.txt \
        && -f /input/repo/Packages && -f /input/repo/Packages.gz ]]
    if find /input -type l -o ! -type d ! -type f | grep -q .; then
        echo 'error: APT input contains a symlink or special file' >&2
        exit 1
    fi
    (
        cd /input
        sha256sum -c SHA256SUMS
        sed -n 's/^[a-f0-9]\{64\}  //p' SHA256SUMS | sort >"$scratch/listed"
        find . -type f ! -name SHA256SUMS -print | sort >"$scratch/actual"
        cmp "$scratch/listed" "$scratch/actual"
    )
    # Bind replay to the package set in this checkout as well as the immutable
    # capture. A package-set change requires a new capture rather than silently
    # replaying an older request.
    /source/image/package-sets.sh "$YONDER_TARGET" >"$scratch/current-requested"
    cmp "$scratch/current-requested" /input/requested-packages.txt
    : >"$scratch/deb-paths"
    : >"$scratch/expected-source-requests"
    : >"$scratch/package-names"
    while IFS=$'\t' read -r relative package version architecture source_package source_version digest bytes extra; do
        [[ -z ${extra:-} && $relative == repo/*.deb && $package =~ ^[a-z0-9][a-z0-9+.-]+$ \
            && -n $version && ( $architecture == arm64 || $architecture == all ) \
            && -n $source_package && -n $source_version \
            && $digest =~ ^[a-f0-9]{64}$ && $bytes =~ ^[0-9]+$ ]]
        deb=/input/$relative
        [[ -f $deb && $(stat -c %s "$deb") == "$bytes" ]]
        [[ $(sha256sum "$deb" | cut -d' ' -f1) == "$digest" ]]
        [[ $(dpkg-deb -f "$deb" Package) == "$package" ]]
        [[ $(dpkg-deb -f "$deb" Version) == "$version" ]]
        [[ $(dpkg-deb -f "$deb" Architecture) == "$architecture" ]]
        printf './%s\n' "${relative#repo/}" >>"$scratch/deb-paths"
        printf '%s\n' "$package" >>"$scratch/package-names"
        if [[ $package != zerotier-one ]]; then
            printf '%s\t%s\n' "$source_package" "$source_version" \
                >>"$scratch/expected-source-requests"
        fi
    done </input/packages.tsv
    sort -u -o "$scratch/deb-paths" "$scratch/deb-paths"
    sort -u -o "$scratch/package-names" "$scratch/package-names"
    sort -u -o "$scratch/expected-source-requests" "$scratch/expected-source-requests"
    cmp "$scratch/expected-source-requests" /input/source-requests.tsv
    find /input/repo -maxdepth 1 -type f -name '*.deb' -printf './%f\n' | sort >"$scratch/repo-debs"
    cmp "$scratch/deb-paths" "$scratch/repo-debs"
    find /input/notices -maxdepth 1 -type f -name '*.copyright' -printf '%f\n' \
        | sed 's/\.copyright$//' >"$scratch/notice-packages"
    sort -u -o "$scratch/notice-packages" "$scratch/notice-packages"
    cmp "$scratch/package-names" "$scratch/notice-packages"
    : >"$scratch/notice-link-packages"
    while IFS=$'\t' read -r package notice_target extra; do
        [[ -z ${extra:-} && $package =~ ^[a-z0-9][a-z0-9+.-]+$ \
            && $notice_target =~ ^[a-z0-9][a-z0-9+.-]+$ ]]
        grep -qxF "$package" "$scratch/package-names"
        printf '%s\n' "$package" >>"$scratch/notice-link-packages"
    done </input/notice-links.tsv
    [[ $(sort -u "$scratch/notice-link-packages" | wc -l) \
        == $(wc -l <"$scratch/notice-link-packages") ]]
    : >"$scratch/source-requests"
    : >"$scratch/dsc-paths"
    while IFS=$'\t' read -r relative source_package source_version digest bytes extra; do
        [[ -z ${extra:-} && $relative == sources/*.dsc \
            && $source_package =~ ^[a-z0-9][a-z0-9+.-]+$ && -n $source_version \
            && $digest =~ ^[a-f0-9]{64}$ && $bytes =~ ^[0-9]+$ ]]
        dsc=/input/$relative
        [[ -f $dsc && $(stat -c %s "$dsc") == "$bytes" ]]
        [[ $(sha256sum "$dsc" | cut -d' ' -f1) == "$digest" ]]
        printf '%s\t%s\n' "$source_package" "$source_version" >>"$scratch/source-requests"
        printf './%s\n' "${relative#sources/}" >>"$scratch/dsc-paths"
    done </input/source-packages.tsv
    cmp "$scratch/source-requests" /input/source-requests.tsv
    find /input/sources -maxdepth 1 -type f -name '*.dsc' -printf './%f\n' \
        | sort >"$scratch/source-dscs"
    sort -u -o "$scratch/dsc-paths" "$scratch/dsc-paths"
    cmp "$scratch/dsc-paths" "$scratch/source-dscs"

    cp --sparse=always /base/base.img "$disk"
    printf '%s  %s\n' "$RAW_SHA256" "$disk" | sha256sum -c -
    # Image assembly grows this same filesystem to 6 GiB before installing the
    # target package delta. Extend only the disposable file and offset loop;
    # replay does not rewrite or rely on the base image's partition table.
    minimum_disk_bytes=$((ROOT_START * 512 + REPLAY_ROOT_BYTES))
    if (( $(stat -c %s "$disk") < minimum_disk_bytes )); then
        truncate -s "$minimum_disk_bytes" "$disk"
    fi
    loop=$(losetup --find --show --offset "$((ROOT_START * 512))" \
        --sizelimit "$REPLAY_ROOT_BYTES" "$disk")
    [[ $(losetup -n -O BACK-FILE "$loop") == "$disk" ]]
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
    [[ -x $target/usr/sbin/resize2fs ]]
    read -r loop_major_hex loop_minor_hex < <(stat -c '%t %T' "$loop")
    mknod "$target/dev/yonder-replay-root" b \
        "$((16#$loop_major_hex))" "$((16#$loop_minor_hex))"
    chroot "$target" /usr/sbin/resize2fs /dev/yonder-replay-root
    mount -t tmpfs -o mode=755 tmpfs "$target/run"
    mounted+=("$target/run")

    mkdir -p "$target/run/yonder-apt" "$target/opt/yonder-src"
    mount --bind /input "$target/run/yonder-apt"
    mount -o remount,bind,ro "$target/run/yonder-apt"
    input_bind=$target/run/yonder-apt
    mount --bind /source "$target/opt/yonder-src"
    mount -o remount,bind,ro "$target/opt/yonder-src"
    mounted+=("$target/opt/yonder-src")
    find "$target/etc/apt" -type f -print0 | sort -z | xargs -0 sha256sum >"$scratch/apt-before"
    chroot "$target" /opt/yonder-src/image/inputs/install-captured-apt.sh \
        --input /run/yonder-apt --target "$YONDER_TARGET" -- /bin/true
    mapfile -t required_packages </input/requested-packages.txt
    for package in "${required_packages[@]}"; do
        # shellcheck disable=SC2016 # dpkg-query expands its own format fields
        chroot "$target" dpkg-query -W -f='${Status}\n' "$package" | grep -qx 'install ok installed'
    done
    while IFS=$'\t' read -r _ package version architecture _; do
        # shellcheck disable=SC2016 # dpkg-query expands its own format fields
        installed=$(chroot "$target" dpkg-query -W -f='${Version}\t${Architecture}\n' "$package")
        [[ $installed == "$version"$'\t'"$architecture" ]]
    done </input/packages.tsv
    while IFS=$'\t' read -r package notice_target; do
        cmp "/input/notices/${package}.copyright" \
            "$target/usr/share/doc/$notice_target/copyright"
    done </input/notice-links.tsv
    find "$target/etc/apt" -type f -print0 | sort -z | xargs -0 sha256sum >"$scratch/apt-after"
    cmp "$scratch/apt-before" "$scratch/apt-after"
    # shellcheck disable=SC2016 # dpkg-query expands its own format fields
    chroot "$target" dpkg-query -W '-f=${Package}\t${Version}\t${Architecture}\n' \
        | sort >/output/installed-packages.tsv
    sync
    printf '%s\n' \
        "target=$YONDER_TARGET" \
        "base_compressed_sha256=$BASE_SHA256" \
        "base_raw_sha256=$RAW_SHA256" \
        'docker_network=none' \
        'apt_sources=local-file-only' \
        'apt_downloads=disabled' \
        'production_adapter=passed' \
        "scratch_root_bytes=$REPLAY_ROOT_BYTES" \
        'base_apt_source_files=unchanged' >/output/replay-proof.txt
    chmod -R a+rX /output
    echo "Replayed captured APT inputs on a fresh $YONDER_TARGET base with networking disabled."
    exit 0
fi

target=
base=
input=
output=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target) target=${2:-}; shift 2 ;;
        --base) base=${2:-}; shift 2 ;;
        --input) input=${2:-}; shift 2 ;;
        --output) output=${2:-}; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
[[ $target == rpi || $target == radxa-zero3w || $target == radxa-rock5c ]]
[[ -f $base && ! -L $base && -d $input && ! -L $input && -n $output && ! -e $output ]]
base=$(CDPATH='' cd -- "$(dirname -- "$base")" && pwd)/$(basename -- "$base")
input=$(CDPATH='' cd -- "$input" && pwd)
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
validation_output=$(mktemp "${TMPDIR:-/tmp}/yonder-apt-validation.XXXXXX")
trap 'rm -f "$validation_output"' EXIT
trap 'rm -f "$validation_output"; exit 130' INT
trap 'rm -f "$validation_output"; exit 143' TERM
node - "$repo" "$target" "$input" >"$validation_output" <<'JS'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [repo, target, input] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'image/bases.lock.json')));
const inspection = JSON.parse(fs.readFileSync(path.join(repo, `image/inspection/${target}.json`)));
const capture = JSON.parse(fs.readFileSync(path.join(input, 'capture.json')));
const requested = fs.readFileSync(path.join(input, 'requested-packages.txt'));
const install = fs.readFileSync(path.join(input, 'install-packages.txt'));
const binaryCount = fs.readFileSync(path.join(input, 'packages.tsv'), 'utf8').trim().split('\n').filter(Boolean).length;
const sourceRequests = fs.readFileSync(path.join(input, 'source-requests.tsv'), 'utf8').trim().split('\n').filter(Boolean);
const sourceCount = sourceRequests.length;
const repoBytes = fs.readdirSync(path.join(input, 'repo')).filter(name => name.endsWith('.deb'))
    .reduce((sum, name) => sum + fs.statSync(path.join(input, 'repo', name)).size, 0);
const sourceBytes = fs.readdirSync(path.join(input, 'sources'))
    .reduce((sum, name) => sum + fs.statSync(path.join(input, 'sources', name)).size, 0);
const coveredSourceFiles = new Set();
const sourceRows = fs.readFileSync(path.join(input, 'source-packages.tsv'), 'utf8').trim().split('\n').filter(Boolean);
for (const row of sourceRows) {
    const fields = row.split('\t');
    if (fields.length !== 5) process.exit(1);
    const [relative, sourceName, version, digest, bytesText] = fields;
    const expectedDsc = `${sourceName}_${version.replace(/^[^:]+:/, '')}.dsc`;
    if (relative !== `sources/${expectedDsc}` || !/^[a-z0-9][a-z0-9+.-]+$/.test(sourceName)
        || !/^[a-f0-9]{64}$/.test(digest) || !/^[0-9]+$/.test(bytesText)) process.exit(1);
    const dscPath = path.join(input, relative);
    const dsc = fs.readFileSync(dscPath);
    if (fs.statSync(dscPath).size !== Number(bytesText)
        || crypto.createHash('sha256').update(dsc).digest('hex') !== digest) process.exit(1);
    const fieldsByName = {};
    let current = null;
    for (const line of dsc.toString('utf8').split('\n')) {
        if (line === '-----BEGIN PGP SIGNATURE-----') break;
        const match = /^([A-Za-z0-9-]+):[ ]?(.*)$/.exec(line);
        if (match) {
            current = match[1];
            fieldsByName[current] = match[2];
        } else if (current && line.startsWith(' ')) {
            fieldsByName[current] += `\n${line.slice(1)}`;
        }
    }
    if (fieldsByName.Source !== sourceName || fieldsByName.Version !== version
        || !fieldsByName['Checksums-Sha256']) process.exit(1);
    coveredSourceFiles.add(expectedDsc);
    for (const checksumLine of fieldsByName['Checksums-Sha256'].trim().split('\n')) {
        const parts = checksumLine.trim().split(/\s+/);
        if (parts.length !== 3 || !/^[a-f0-9]{64}$/.test(parts[0]) || !/^[0-9]+$/.test(parts[1])
            || !/^[A-Za-z0-9][A-Za-z0-9+._~%-]*$/.test(parts[2])) process.exit(1);
        const archivePath = path.join(input, 'sources', parts[2]);
        const archive = fs.readFileSync(archivePath);
        if (fs.statSync(archivePath).size !== Number(parts[1])
            || crypto.createHash('sha256').update(archive).digest('hex') !== parts[0]) process.exit(1);
        coveredSourceFiles.add(parts[2]);
    }
}
const actualSourceFiles = fs.readdirSync(path.join(input, 'sources')).sort();
if (sourceRows.length !== sourceRequests.length
    || JSON.stringify([...coveredSourceFiles].sort()) !== JSON.stringify(actualSourceFiles)) process.exit(1);
const base = lock.targets[target];
const root = target === 'rpi' ? inspection.partitions[1] : inspection.partitions[0];
if (!base || inspection.compressedSha256 !== base.sha256 || root.filesystem?.type !== 'ext4'
    || capture.schemaVersion !== 1 || capture.kind !== 'yonder-target-apt-input'
    || capture.target !== target || capture.baseCompressedSha256 !== base.sha256
    || capture.baseRawSha256 !== inspection.rawSha256
    || capture.resolverPreflightUser !== '_apt'
    || capture.requestedPackagesSha256 !== crypto.createHash('sha256').update(requested).digest('hex')
    || capture.installPackagesSha256 !== crypto.createHash('sha256').update(install).digest('hex')
    || capture.binaryPackageCount !== binaryCount || capture.sourcePackageCount !== sourceCount
    || capture.repositoryDebBytes !== repoBytes || capture.sourceArchiveBytes !== sourceBytes
    || JSON.stringify(capture.vendorSourceArchivesOutsideThisInput) !== '["zerotier-one"]') process.exit(1);
process.stdout.write(`${base.sha256} ${inspection.rawSha256} ${root.startSector} ${root.sectorCount}\n`);
JS
read -r base_sha raw_sha root_start root_size <"$validation_output"
rm -f "$validation_output"
trap - EXIT INT TERM
[[ $(sha256sum "$base" | cut -d' ' -f1) == "$base_sha" ]]
[[ $(docker image inspect --format '{{.Id}}' "$RUNTIME") =~ ^sha256: ]]
scratch_raw=$(mktemp "${TMPDIR:-/tmp}/yonder-apt-replay.XXXXXX")
container=
retain_host=0
# shellcheck disable=SC2329 # invoked by EXIT/INT/TERM traps
cleanup_host() {
    if [[ $retain_host == 0 ]]; then
        [[ -z $container ]] || docker rm -f "$container" >/dev/null 2>&1 || true
        rm -f "$scratch_raw"
    fi
}
# shellcheck disable=SC2329 # invoked by INT/TERM traps
interrupt_host() {
    retain_host=1
    echo "error: replay host interrupted; retained private container $container and $scratch_raw" >&2
    exit "$1"
}
trap cleanup_host EXIT
trap 'interrupt_host 130' INT
trap 'interrupt_host 143' TERM
xz -dc "$base" >"$scratch_raw"
[[ $(sha256sum "$scratch_raw" | cut -d' ' -f1) == "$raw_sha" ]]
mkdir -m 0700 "$output"
output=$(CDPATH='' cd -- "$output" && pwd)
container="yonder-apt-replay-$$-$RANDOM"
docker run -d --name "$container" --network none --privileged --platform linux/arm64 \
    -e "YONDER_TARGET=$target" -e "BASE_SHA256=$base_sha" -e "RAW_SHA256=$raw_sha" \
    -e "ROOT_START=$root_start" -e "ROOT_SIZE=$root_size" \
    -v "$repo:/source:ro" -v "$scratch_raw:/base/base.img:ro" \
    -v "$input:/input:ro" -v "$output:/output" \
    "$RUNTIME" sleep infinity >/dev/null
set +e
docker exec "$container" /bin/bash /source/image/inputs/replay-apt.sh --inside
replay_status=$?
set -e
if [[ $replay_status == 125 ]]; then
    retain_host=1
    echo "error: replay cleanup failed; retained private container $container and $scratch_raw" >&2
    exit 1
fi
docker rm -f "$container" >/dev/null
container=
exit "$replay_status"
