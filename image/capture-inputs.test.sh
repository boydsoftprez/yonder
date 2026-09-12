#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if "$repo/image/capture-inputs.sh" --target unknown --output "$work/nope" \
        >"$work/error" 2>&1; then
    echo 'FAIL: unknown target was accepted' >&2
    exit 1
fi
[[ ! -e $work/nope ]]
grep -q '^Usage:' "$work/error"

mkdir "$work/existing"
if "$repo/image/capture-inputs.sh" --target rpi --output "$work/existing" \
        >"$work/existing-error" 2>&1; then
    echo 'FAIL: existing capture destination was accepted' >&2
    exit 1
fi
grep -q '^Usage:' "$work/existing-error"

echo 'PASS: input refresh refuses invalid targets and non-new destinations before mutation.'
