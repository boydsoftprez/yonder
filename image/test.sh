#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Fast repository gate for image/release plumbing. Privileged real-filesystem
# fixtures stay in CI's native ARM64 image-storage job.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

node --test image/build.test.mjs image/build-cancellation.test.mjs \
    image/bench/build.test.mjs \
    image/lib/*.test.mjs image/release/draft.test.mjs \
    image/release/input-bundles.test.mjs
python3 -m unittest image/test_inspect_base.py
bash image/capture-inputs.test.sh
bash image/inputs/application-bundle-test.sh
bash image/inputs/payload-test.sh
bash -n image/*.sh image/bench/*.sh image/inputs/*.sh image/pi/*.sh \
    image/pi/storage-prototype/*.sh image/prototype/*.sh image/storage/*.sh
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck image/*.sh image/bench/*.sh image/inputs/*.sh image/pi/*.sh \
        image/pi/storage-prototype/*.sh image/prototype/*.sh image/storage/*.sh
fi
