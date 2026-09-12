#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Explicitly refresh every byte needed by one production image build.
set -euo pipefail
umask 077

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
target=
output=

usage() {
    echo 'Usage: image/capture-inputs.sh --target rpi|radxa-zero3w|radxa-rock5c --output NEW_DIRECTORY' >&2
}

while (($#)); do
    case "$1" in
        --target) shift; (($#)) || { usage; exit 2; }; target=$1 ;;
        --output) shift; (($#)) || { usage; exit 2; }; output=$1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
    shift
done
case "$target" in rpi|radxa-zero3w|radxa-rock5c) ;; *) usage; exit 2 ;; esac
[[ -n $output && ! -e $output && ! -L $output ]] || { usage; exit 2; }

output_parent=$(CDPATH='' cd -- "$(dirname -- "$output")" && pwd)
output_name=$(basename -- "$output")
partial=$output_parent/.$output_name.partial.$$
[[ ! -e $partial && ! -L $partial ]]
mkdir -m 0700 "$partial"
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [[ $status != 0 ]]; then rm -rf -- "$partial"; fi
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

base_cache=${YONDER_BASE_CACHE:-$repo/vendor/image-bases}
base=$(node "$repo/image/fetch-base.mjs" --target "$target" --cache "$base_cache")
[[ -f $base && ! -L $base ]]
cp -- "$base" "$partial/base.img.xz"

"$repo/installer/make-payload.sh" --arch linux-arm64 --target "$target" \
    --out "$partial/.payload-work" --capture-inputs "$partial/payload"

"$repo/image/inputs/capture-apt.sh" --target "$target" \
    --base "$partial/base.img.xz" --payload "$partial/payload/files/payload" \
    --output "$partial/apt"

"$repo/image/inputs/capture-builder.sh" --output "$partial/builder"
rm -rf -- "$partial/.payload-work"

base_sha=$(node --input-type=module - "$repo" "$target" <<'NODE'
import { readFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile(`${process.argv[2]}/image/bases.lock.json`, 'utf8'));
const value = lock.targets?.[process.argv[3]]?.sha256;
if (!/^[a-f0-9]{64}$/.test(value ?? '')) process.exit(1);
console.log(value);
NODE
)
node --input-type=module - "$repo" "$partial" "$target" "$base_sha" <<'NODE'
import { pathToFileURL } from 'node:url';
const { writeInputSetManifest } = await import(
  pathToFileURL(`${process.argv[2]}/image/lib/input-set.mjs`)
);
await writeInputSetManifest(process.argv[3], process.argv[4], process.argv[5]);
NODE

mv -- "$partial" "$output"
trap - EXIT HUP INT TERM
echo "Captured production input set: $output"
