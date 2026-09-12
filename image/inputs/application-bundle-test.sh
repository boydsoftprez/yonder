#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
helper=$repo/image/inputs/application-bundle.py
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }

source=$work/source
mkdir -p "$source/packages"
cat >"$source/.gitignore" <<'EOF'
dist/
node_modules/
resources/
EOF
cat >"$source/package.json" <<'JSON'
{"name":"fixture","private":true,"workspaces":["packages/*"],"scripts":{"build":"fixture-build"}}
JSON
cat >"$source/package-lock.json" <<'JSON'
{"name":"fixture","lockfileVersion":3,"packages":{}}
JSON
printf 'fixture licence\n' >"$source/LICENSE"
packages=(yonder-core node-red-contrib-yonder-system node-red-contrib-yonder-network node-red-contrib-yonder-remote node-red-contrib-yonder-modem node-red-contrib-yonder-video node-red-contrib-yonder-mavlink node-red-dashboard-2-yonder)
for package in "${packages[@]}"; do
    mkdir -p "$source/packages/$package/src"
    if [[ $package == yonder-core ]]; then
        printf '{"name":"yonder-core","dependencies":{"yaml":"2.8.1"}}\n' >"$source/packages/$package/package.json"
        cp "$source/package-lock.json" "$source/packages/$package/package-lock.json"
        printf '{}\n' >"$source/packages/$package/tsconfig.json"
    else
        printf '{"name":"%s","dependencies":{"yonder-core":"2026.9.0"}}\n' "$package" >"$source/packages/$package/package.json"
    fi
    printf 'source %s\n' "$package" >"$source/packages/$package/src/index.ts"
done
mkdir -p "$source/scripts"
printf 'builder input\n' >"$source/scripts/build.mjs"

git -C "$source" init -q
git -C "$source" config user.email fixture@example.invalid
git -C "$source" config user.name Fixture
git -C "$source" add .
git -C "$source" commit -qm fixture
commit=$(git -C "$source" rev-parse HEAD)

mkdir -p "$source/packages/yonder-core/dist" "$source/packages/node-red-dashboard-2-yonder/resources"
printf 'STALE-IGNORED-DIST\n' >"$source/packages/yonder-core/dist/stale.js"
printf 'STALE-IGNORED-RESOURCE\n' >"$source/packages/node-red-dashboard-2-yonder/resources/stale.js"

engine=$work/fake-engine
cat >"$engine" <<'BASH'
#!/bin/bash
set -euo pipefail
build_script=${!#}
[[ $build_script != *'+  '* ]]
bash -n <<<"$build_script"
src=
cache=
offline=0
while (($#)); do
    [[ $1 == --network && ${2:-} == none ]] && offline=1
    if [[ $1 == -v ]]; then
        shift
        case $1 in
            *:/src) src=${1%:/src} ;;
            *:/npm-input) cache=${1%:/npm-input} ;;
        esac
    fi
    shift
done
[[ -n $src && -n $cache ]]
if ((offline == 0)); then
    mkdir -p "$cache/cache/workspace/content-v2" "$cache/cache/core/content-v2"
    printf 'workspace tarball\n' >"$cache/cache/workspace/content-v2/input"
    printf 'core tarball\n' >"$cache/cache/core/content-v2/input"
    printf 'online\n' >>"$0.calls"
    exit 0
fi
[[ -s $cache/cache/workspace/content-v2/input ]]
[[ -s $cache/cache/core/content-v2/input ]]
printf 'offline\n' >>"$0.calls"
for package_dir in "$src"/packages/*; do
    mkdir -p "$package_dir/dist"
    printf 'fresh build for %s\n' "$(basename "$package_dir")" >"$package_dir/dist/fresh.js"
done
mkdir -p "$src/packages/yonder-core/dist/daemon" "$src/packages/yonder-core/dist/admin" "$src/packages/yonder-core/dist/owner-access" "$src/packages/yonder-core/node_modules/yaml"
printf 'export {};\n' >"$src/packages/yonder-core/dist/daemon/server.js"
printf 'export {};\n' >"$src/packages/yonder-core/dist/admin/main.js"
printf 'export {};\n' >"$src/packages/yonder-core/dist/owner-access/cli.js"
printf '{"name":"yaml","version":"2.8.1"}\n' >"$src/packages/yonder-core/node_modules/yaml/package.json"
mkdir -p "$src/packages/node-red-dashboard-2-yonder/resources"
printf 'fresh widget\n' >"$src/packages/node-red-dashboard-2-yonder/resources/ui-yonder-fixture.umd.js"
BASH
chmod +x "$engine"
mkdir -p "$work/node/bin"
python3 -I - "$work/node/bin/node" <<'PY'
from pathlib import Path
import sys

header = bytearray(64)
header[:4] = b"\x7fELF"
header[4] = 2
header[5] = 1
header[18:20] = (183).to_bytes(2, "little")
Path(sys.argv[1]).write_bytes(header)
PY
chmod +x "$work/node/bin/node"

python3 -I "$helper" --repo "$source" --output "$work/application" --npm-input "$work/npm-input" --source-output "$work/source.tar" --node-runtime "$work/node" --engine "$engine" --image debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --platform linux/arm64 --expected-commit "$commit"

[[ -f $work/application/application-bundle.json ]]
[[ -f $work/source.tar ]]
[[ -f $work/npm-input/manifests/package-lock.json ]]
[[ -f $work/npm-input/cache/workspace/content-v2/input ]]
[[ $(cat "$engine.calls") == $'online\noffline' ]] || fail 'application was not rebuilt from retained inputs with networking disabled'
[[ ! -e $work/application/packages/yonder-core/dist/stale.js ]] || fail 'ignored stale dist entered the application bundle'
[[ ! -e $work/application/packages/node-red-dashboard-2-yonder/resources/stale.js ]] || fail 'ignored stale resources entered the application bundle'
for package in "${packages[@]}"; do
    [[ -f $work/application/packages/$package/package.json ]]
    [[ -f $work/application/packages/$package/dist/fresh.js ]] || fail "$package fresh dist is missing"
done
[[ -f $work/application/packages/node-red-dashboard-2-yonder/resources/ui-yonder-fixture.umd.js ]]
[[ -f $work/application/packages/yonder-core/node_modules/yaml/package.json ]] || fail 'standalone yonder-core production dependency is missing'

python3 -I - "$work/application/application-bundle.json" "$commit" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
assert value["sourceCommit"] == sys.argv[2]
assert value["sourceKind"] == "git-archive"
assert value["platform"] == "linux/arm64"
assert value["offlineBuild"] == {
    "network": "none",
    "npmInputs": "retained-cache-and-manifests",
    "source": "retained-git-archive",
    "status": "verified",
}
assert value["coreProductionDependencies"] == ["yaml"]
assert len(value["sourceArchiveSha256"]) == 64
PY

mkdir -p "$source/packages/unlisted-workspace"
printf '{"name":"unlisted-workspace"}\n' >"$source/packages/unlisted-workspace/package.json"
git -C "$source" add packages/unlisted-workspace/package.json
git -C "$source" commit -qm 'add uncovered workspace'
uncovered_commit=$(git -C "$source" rev-parse HEAD)
if python3 -I "$helper" --repo "$source" --output "$work/uncovered-output" --npm-input "$work/uncovered-npm" --source-output "$work/uncovered-source.tar" --node-runtime "$work/node" --engine "$engine" --image debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --platform linux/arm64 --expected-commit "$uncovered_commit" >"$work/uncovered.log" 2>&1; then
    fail 'unlisted workspace package was omitted from the application contract'
fi
grep -q 'workspace package set is not explicitly covered' "$work/uncovered.log"
git -C "$source" reset -q --hard "$commit"

printf '//registry.npmjs.org/:_authToken=must-not-ship\n' >"$source/.npmrc"
git -C "$source" add .npmrc
git -C "$source" commit -qm 'add forbidden access input'
private_commit=$(git -C "$source" rev-parse HEAD)
if python3 -I "$helper" --repo "$source" --output "$work/private-output" --npm-input "$work/private-npm" --source-output "$work/private-source.tar" --node-runtime "$work/node" --engine "$engine" --image debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --platform linux/arm64 --expected-commit "$private_commit" >"$work/private.log" 2>&1; then
    fail 'private access input in the Git source archive was accepted'
fi
grep -q 'private access input' "$work/private.log"
git -C "$source" reset -q --hard "$commit"

printf 'dirty\n' >>"$source/package.json"
if python3 -I "$helper" --repo "$source" --output "$work/dirty-output" --npm-input "$work/dirty-npm" --source-output "$work/dirty-source.tar" --node-runtime "$work/node" --engine "$engine" --image debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --platform linux/arm64 --expected-commit "$commit" >"$work/dirty.log" 2>&1; then
    fail 'dirty application source was accepted'
fi
grep -q 'source tree is not clean' "$work/dirty.log"
git -C "$source" checkout -q -- package.json

if python3 -I "$helper" --repo "$source" --output "$work/mismatch-output" --npm-input "$work/mismatch-npm" --source-output "$work/mismatch-source.tar" --node-runtime "$work/node" --engine "$engine" --image debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --platform linux/arm64 --expected-commit 0000000000000000000000000000000000000000 >"$work/mismatch.log" 2>&1; then
    fail 'mismatched source commit was accepted'
fi
grep -q 'source commit does not match' "$work/mismatch.log"

git -C "$source" ls-tree -r --name-only HEAD | grep -qv '/dist/'
tar -tf "$work/source.tar" | grep -q '^packages/yonder-core/src/index.ts$'

echo 'PASS: clean archived source builds a complete ARM64 application bundle without stale ignored outputs.'
