#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Validate and install a frozen target APT capture, then run the installer with
# its APT calls confined to that capture for the lifetime of the child command.
set -euo pipefail
umask 077

usage() {
    echo 'Usage: install-captured-apt.sh --input /run/yonder-apt --target TARGET -- COMMAND [ARG ...]'
}

input=
target_name=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --input) input=${2:-}; shift 2 ;;
        --target) target_name=${2:-}; shift 2 ;;
        --) shift; break ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
[[ $input == /run/yonder-apt && ( $target_name == rpi || $target_name == radxa-zero3w \
    || $target_name == radxa-rock5c ) && $# -gt 0 && $(id -u) == 0 ]]
[[ -d $input && ! -L $input && -d /opt/yonder-src/image/inspection ]]
mount_target=$(findmnt -rn -T "$input" -o TARGET)
[[ $mount_target == "$input" ]] || {
    echo 'error: captured APT input is not a separate mount' >&2
    exit 1
}
mount_options=$(findmnt -rn -T "$input" -o OPTIONS)
case ",$mount_options," in *,ro,*) ;; *) echo 'error: captured APT input is not a read-only mount' >&2; exit 1 ;; esac
if find "$input" -xdev \( -type l -o ! -type d ! -type f \) -print -quit | grep -q .; then
    echo 'error: captured APT input contains a symlink or special file' >&2
    exit 1
fi
if find "$input" -xdev \( ! -uid 0 -o ! -gid 0 \) -print -quit | grep -q .; then
    echo 'error: captured APT input is not wholly root-owned' >&2
    exit 1
fi

runtime=/run/yonder-frozen-apt
[[ ! -e $runtime ]]
mkdir -m 0755 "$runtime"
policy_created=0
# shellcheck disable=SC2329 # invoked by EXIT/INT/TERM traps
cleanup() {
    status=$?
    trap - EXIT
    set +e
    if [[ $policy_created == 1 ]]; then rm -f /usr/sbin/policy-rc.d; fi
    rm -rf "$runtime"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for required in SHA256SUMS capture.json packages.tsv source-packages.tsv \
        source-requests.tsv requested-packages.txt install-packages.txt \
        repo/Packages repo/Packages.gz; do
    [[ -f $input/$required && ! -L $input/$required ]]
done
(
    cd "$input"
    sha256sum -c SHA256SUMS
    sed -n 's/^[a-f0-9]\{64\}  //p' SHA256SUMS | LC_ALL=C sort >"$runtime/listed"
    find . -xdev -type f ! -name SHA256SUMS -print | LC_ALL=C sort >"$runtime/actual"
    cmp "$runtime/listed" "$runtime/actual"
)

python3 -I - "$input" "$target_name" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import sys

input_dir = pathlib.Path(sys.argv[1])
target = sys.argv[2]
source = pathlib.Path('/opt/yonder-src')
lock = json.loads((source / 'image/bases.lock.json').read_text())
inspection = json.loads((source / f'image/inspection/{target}.json').read_text())
capture = json.loads((input_dir / 'capture.json').read_text())
base = lock['targets'][target]
requested = (input_dir / 'requested-packages.txt').read_bytes()
install = (input_dir / 'install-packages.txt').read_bytes()
packages = [line for line in (input_dir / 'packages.tsv').read_text().splitlines() if line]
sources = [line for line in (input_dir / 'source-requests.tsv').read_text().splitlines() if line]
repo_files = list((input_dir / 'repo').iterdir())
source_files = list((input_dir / 'sources').iterdir())
repo_bytes = sum(item.stat().st_size for item in repo_files if item.name.endswith('.deb'))
source_bytes = sum(item.stat().st_size for item in source_files)
valid = (
    capture.get('schemaVersion') == 1
    and capture.get('kind') == 'yonder-target-apt-input'
    and capture.get('target') == target
    and capture.get('baseCompressedSha256') == base['sha256'] == inspection['compressedSha256']
    and capture.get('baseRawSha256') == inspection['rawSha256']
    and capture.get('requestedPackagesSha256') == hashlib.sha256(requested).hexdigest()
    and capture.get('installPackagesSha256') == hashlib.sha256(install).hexdigest()
    and capture.get('binaryPackageCount') == len(packages)
    and capture.get('sourcePackageCount') == len(sources)
    and capture.get('repositoryDebBytes') == repo_bytes
    and capture.get('sourceArchiveBytes') == source_bytes
    and capture.get('resolverPreflightUser') == '_apt'
    and capture.get('vendorSourceArchivesOutsideThisInput') == ['zerotier-one']
)
package_name = re.compile(r'^[a-z0-9][a-z0-9+.-]+$')
for name in ('requested-packages.txt', 'install-packages.txt'):
    values = (input_dir / name).read_text().splitlines()
    valid = valid and values == sorted(set(values)) and all(package_name.fullmatch(value) for value in values)
requested_set = set((input_dir / 'requested-packages.txt').read_text().splitlines())
install_set = set((input_dir / 'install-packages.txt').read_text().splitlines())
valid = valid and install_set <= requested_set
if not valid:
    raise SystemExit('captured APT metadata does not match this target and locked base')
PY

/opt/yonder-src/image/package-sets.sh "$target_name" >"$runtime/current-requested"
cmp "$runtime/current-requested" "$input/requested-packages.txt"

: >"$runtime/deb-paths"
while IFS=$'\t' read -r relative package version architecture source_package source_version digest bytes extra; do
    [[ -z ${extra:-} && $relative == repo/*.deb && ${relative#repo/} != */* \
        && $package =~ ^[a-z0-9][a-z0-9+.-]+$ && -n $version \
        && ( $architecture == arm64 || $architecture == all ) \
        && -n $source_package && -n $source_version \
        && $digest =~ ^[a-f0-9]{64}$ && $bytes =~ ^[0-9]+$ ]]
    deb=$input/$relative
    [[ -f $deb && $(stat -c %s "$deb") == "$bytes" ]]
    [[ $(sha256sum "$deb" | cut -d' ' -f1) == "$digest" ]]
    [[ $(dpkg-deb -f "$deb" Package) == "$package" ]]
    [[ $(dpkg-deb -f "$deb" Version) == "$version" ]]
    [[ $(dpkg-deb -f "$deb" Architecture) == "$architecture" ]]
    printf './%s\n' "${relative#repo/}" >>"$runtime/deb-paths"
done <"$input/packages.tsv"
LC_ALL=C sort -u -o "$runtime/deb-paths" "$runtime/deb-paths"
find "$input/repo" -maxdepth 1 -type f -name '*.deb' -printf './%f\n' \
    | LC_ALL=C sort >"$runtime/repo-debs"
cmp "$runtime/deb-paths" "$runtime/repo-debs"

snapshot_apt() {
    local destination=$1
    (
        cd /etc/apt
        find . -printf '%y\t%m\t%U\t%G\t%p\t%l\n' | LC_ALL=C sort
        find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
    ) >"$destination"
}
snapshot_apt "$runtime/apt-before"
mkdir -m 0755 "$runtime/lists" "$runtime/archives"
install -d -o _apt -g root -m 0700 "$runtime/lists/partial" "$runtime/archives/partial"
cp "$input"/repo/*.deb "$runtime/archives/"
chmod 0644 "$runtime"/archives/*.deb
cat >"$runtime/sources.list" <<EOF
deb [trusted=yes] file:$input/repo ./
EOF
cat >"$runtime/apt.conf" <<EOF
Dir::Etc::sourcelist "$runtime/sources.list";
Dir::Etc::sourceparts "-";
Dir::State::lists "$runtime/lists";
Dir::Cache::archives "$runtime/archives";
Acquire::Retries "0";
Acquire::Languages "none";
APT::Get::List-Cleanup "0";
EOF
chmod 0644 "$runtime/sources.list" "$runtime/apt.conf"

if [[ -e /usr/sbin/policy-rc.d || -L /usr/sbin/policy-rc.d ]]; then
    [[ -f /usr/sbin/policy-rc.d && ! -L /usr/sbin/policy-rc.d ]]
else
    printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
    chmod 0755 /usr/sbin/policy-rc.d
    policy_created=1
fi
export APT_CONFIG=$runtime/apt.conf
export YONDER_FROZEN_BUILD=1
apt-get update
mapfile -t install_packages <"$input/install-packages.txt"
apt-get -s --no-download --no-install-recommends install "${install_packages[@]}" \
    >"$runtime/apt-simulation.txt"
env DEBIAN_FRONTEND=noninteractive apt-get -y --no-download --no-install-recommends \
    install "${install_packages[@]}"

set +e
"$@"
child_status=$?
set -e

snapshot_apt "$runtime/apt-after"
cmp "$runtime/apt-before" "$runtime/apt-after"
if [[ $child_status != 0 ]]; then exit "$child_status"; fi

mapfile -t required_packages <"$input/requested-packages.txt"
for package in "${required_packages[@]}"; do
    # shellcheck disable=SC2016 # dpkg-query expands its own format field
    dpkg-query -W -f='${Status}\n' "$package" | grep -qx 'install ok installed'
done
while IFS=$'\t' read -r _ package version architecture _; do
    # shellcheck disable=SC2016 # dpkg-query expands its own format fields
    installed=$(dpkg-query -W -f='${Version}\t${Architecture}\n' "$package")
    [[ $installed == "$version"$'\t'"$architecture" ]]
done <"$input/packages.tsv"
exit "$child_status"
