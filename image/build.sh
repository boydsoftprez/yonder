#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
target=
output=

usage() {
    echo 'Usage: image/build.sh --target rpi|radxa-zero3w|radxa-rock5c --output NEW_DIRECTORY' >&2
}

while (($#)); do
    case "$1" in
        --target) shift; (($#)) || { usage; exit 2; }; target=$1 ;;
        --output) shift; (($#)) || { usage; exit 2; }; output=$1 ;;
        *) usage; exit 2 ;;
    esac
    shift
done

case "$target" in rpi|radxa-zero3w|radxa-rock5c) ;; *) usage; exit 2 ;; esac
[[ -n $output ]] || { usage; exit 2; }
inputs_root=${YONDER_INPUTS_ROOT:-$repo/image/out/input-sets}
input_set=$inputs_root/$target

mapfile -t resolved < <(node --input-type=module - "$repo" "$input_set" "$target" <<'NODE'
import { pathToFileURL } from 'node:url';
const { resolveInputSet } = await import(pathToFileURL(`${process.argv[2]}/image/lib/input-set.mjs`));
const value = await resolveInputSet(process.argv[3], process.argv[4]);
for (const key of ['base', 'aptInput', 'payloadInput', 'builderInput']) console.log(value[key]);
NODE
)
[[ ${#resolved[@]} == 4 ]] || { echo 'error: input-set resolution failed' >&2; exit 1; }

exec node "$repo/image/build.mjs" --target "$target" --base "${resolved[0]}" \
    --apt-input "${resolved[1]}" --payload-input "${resolved[2]}" \
    --builder-input "${resolved[3]}" --output "$output"
