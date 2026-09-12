#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
helper=$repo/image/inputs/payload-inventory.py
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }

staging=$work/staging
payload=$work/payload
mkdir -p "$staging/inputs/downloads/node" "$staging/inputs/downloads/zerotier" \
    "$staging/inputs/downloads/mediamtx" "$staging/inputs/notices" \
    "$staging/inputs/sources/mavlink-router" "$staging/inputs/sources/zerotier" \
    "$staging/inputs/sources/application" \
    "$staging/inputs/npm/cache/content-v2" "$staging/inputs/npm/manifests" \
    "$staging/inputs/npm/application/cache/workspace/content-v2" \
    "$staging/inputs/npm/application/cache/core/content-v2" \
    "$staging/inputs/npm/application/manifests/packages/yonder-core" \
    "$payload"/{node,zerotier,mediamtx,mavlink-router,console,application}
printf 'node archive\n' >"$staging/inputs/downloads/node/node.tar.xz"
printf 'node sums\n' >"$staging/inputs/downloads/node/SHASUMS256.txt"
printf 'signed index\n' >"$staging/inputs/downloads/zerotier/InRelease"
printf 'package index\n' >"$staging/inputs/downloads/zerotier/Packages"
printf 'deb\n' >"$staging/inputs/downloads/zerotier/zerotier.deb"
printf 'zerotier source\n' >"$staging/inputs/sources/zerotier/source.tar.gz"
printf 'zerotier notice\n' >"$staging/inputs/notices/zerotier-one.copyright"
printf 'media sums\n' >"$staging/inputs/downloads/mediamtx/checksums.sha256"
printf 'media archive\n' >"$staging/inputs/downloads/mediamtx/mediamtx.tar.gz"
printf 'router source\n' >"$staging/inputs/sources/mavlink-router/router.cc"
printf 'router licence\n' >"$staging/inputs/sources/mavlink-router/LICENSE"
printf 'cached npm source\n' >"$staging/inputs/npm/cache/content-v2/package"
printf 'workspace npm source\n' >"$staging/inputs/npm/application/cache/workspace/content-v2/package"
printf 'core npm source\n' >"$staging/inputs/npm/application/cache/core/content-v2/package"
cat >"$staging/inputs/npm/manifests/package-lock.json" <<'JSON'
{"name":"fixture","lockfileVersion":3,"packages":{},"dependencies":{}}
JSON
printf '{"name":"fixture","private":true}\n' >"$staging/inputs/npm/manifests/package.json"
cp "$staging/inputs/npm/manifests/package-lock.json" \
    "$staging/inputs/npm/application/manifests/package-lock.json"
cp "$staging/inputs/npm/manifests/package-lock.json" \
    "$staging/inputs/npm/application/manifests/packages/yonder-core/package-lock.json"
cp "$staging/inputs/npm/manifests/package.json" \
    "$staging/inputs/npm/application/manifests/package.json"
printf 'application source\n' >"$staging/inputs/sources/application/source.tar"
for component in node zerotier mediamtx mavlink-router console; do
    printf '%s payload\n' "$component" >"$payload/$component/artifact"
done
app_packages=(yonder-core node-red-contrib-yonder-system node-red-contrib-yonder-network \
  node-red-contrib-yonder-remote node-red-contrib-yonder-modem \
  node-red-contrib-yonder-video node-red-contrib-yonder-mavlink \
  node-red-dashboard-2-yonder)
for package in "${app_packages[@]}"; do
    mkdir -p "$payload/application/packages/$package/dist"
    if [[ $package == yonder-core ]]; then
        printf '{"name":"yonder-core","dependencies":{"yaml":"2.8.1"}}\n' \
            >"$payload/application/packages/$package/package.json"
        cp "$staging/inputs/npm/manifests/package-lock.json" \
            "$payload/application/packages/$package/package-lock.json"
        printf '{}\n' >"$payload/application/packages/$package/tsconfig.json"
        mkdir -p "$payload/application/packages/$package/node_modules/yaml"
        printf '{"name":"yaml","version":"2.8.1"}\n' \
            >"$payload/application/packages/$package/node_modules/yaml/package.json"
    else
        printf '{"name":"%s"}\n' "$package" \
            >"$payload/application/packages/$package/package.json"
    fi
    printf 'built %s\n' "$package" >"$payload/application/packages/$package/dist/index.js"
done
mkdir -p "$payload/application/packages/node-red-dashboard-2-yonder/resources"
printf 'widget\n' >"$payload/application/packages/node-red-dashboard-2-yonder/resources/widget.js"
printf 'GPL fixture\n' >"$payload/application/LICENSE"
python3 -I - "$payload/application/application-bundle.json" \
    "$staging/inputs/sources/application/source.tar" <<'PY'
from pathlib import Path
import hashlib, json, sys
source = Path(sys.argv[2]).read_bytes()
metadata = {
    'schemaVersion': 1,
    'kind': 'yonder-first-party-application',
    'sourceCommit': '0123456789abcdef0123456789abcdef01234567',
    'sourceKind': 'git-archive',
    'sourceArchiveSha256': hashlib.sha256(source).hexdigest(),
    'platform': 'linux/arm64',
    'toolchainImage': 'debian@sha256:' + 'd' * 64,
    'nodeRuntime': 'retained-payload-node',
    'offlineBuild': {
        'status': 'verified',
        'network': 'none',
        'source': 'retained-git-archive',
        'npmInputs': 'retained-cache-and-manifests',
    },
    'packages': ['yonder-core', 'node-red-contrib-yonder-system',
                 'node-red-contrib-yonder-network', 'node-red-contrib-yonder-remote',
                 'node-red-contrib-yonder-modem', 'node-red-contrib-yonder-video',
                 'node-red-contrib-yonder-mavlink', 'node-red-dashboard-2-yonder'],
    'coreProductionDependencies': ['yaml'],
}
Path(sys.argv[1]).write_text(json.dumps(metadata) + '\n')
PY
mkdir -p "$payload/console/node_modules/example"
cat >"$payload/console/node_modules/example/package.json" <<'JSON'
{"name":"example","version":"1.2.3","license":"MIT"}
JSON
printf 'example licence\n' >"$payload/console/node_modules/example/LICENSE"
printf 'node licence\n' >"$payload/node/LICENSE"
printf 'archive\tnode-distribution\tv1\thttps://node.invalid/\tinputs/downloads/node/node.tar.xz\n' \
    >"$staging/records.tsv"
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$@" >>"$staging/records.tsv"; }
record index node-checksums v1 https://node.invalid/sums inputs/downloads/node/SHASUMS256.txt
record index zerotier-inrelease v1 https://zerotier.invalid/InRelease inputs/downloads/zerotier/InRelease
record index zerotier-packages fixture https://zerotier.invalid/Packages inputs/downloads/zerotier/Packages
record archive zerotier-package fixture https://zerotier.invalid/zerotier.deb inputs/downloads/zerotier/zerotier.deb
record archive zerotier-source fixture https://codeload.github.com/zerotier/ZeroTierOne/tar.gz/refs/tags/1.0 inputs/sources/zerotier/source.tar.gz
record notice zerotier-copyright v1 https://zerotier.invalid/ inputs/notices/zerotier-one.copyright
record index mediamtx-checksums v1 https://media.invalid/checksums inputs/downloads/mediamtx/checksums.sha256
record archive mediamtx-distribution fixture https://media.invalid/archive inputs/downloads/mediamtx/mediamtx.tar.gz
record git-source mavlink-router 0123456789abcdef0123456789abcdef01234567 https://git.invalid/router inputs/sources/mavlink-router
record index console-package-json fixture repository:installer/console/package.json inputs/npm/manifests/package.json
record index console-package-lock fixture repository:installer/console/package-lock.json inputs/npm/manifests/package-lock.json
record npm-cache console-npm-cache fixture https://registry.npmjs.org/ inputs/npm/cache
record git-source application-source 0123456789abcdef0123456789abcdef01234567 repository:git-archive inputs/sources/application/source.tar
record index application-manifests fixture repository:package-lock.json inputs/npm/application/manifests
record npm-cache application-npm-cache fixture https://registry.npmjs.org/ inputs/npm/application/cache

# make-payload.sh keeps downloads and extracted package metadata under this
# transient directory until capture completes. It may contain package-owned
# absolute symlinks, but none of it is part of the replayed payload.
mkdir -p "$payload/.work/zerotier-notice/var/lib/zerotier-one"
ln -s /usr/sbin/zerotier-one \
    "$payload/.work/zerotier-notice/var/lib/zerotier-one/zerotier-one"

python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
    --output "$work/capture" --target rpi --arch linux-arm64 \
    --selected node,zerotier,mediamtx,mavlink-router,console,application \
    --toolchain 'application=debian@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
    --toolchain 'mavlink-router=debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

python3 -I - "$work/capture" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
manifest = json.loads((root / 'payload-input.json').read_text())
assert manifest['schemaVersion'] == 1
assert manifest['kind'] == 'yonder-application-payload-input'
assert manifest['target'] == 'rpi' and manifest['architecture'] == 'linux-arm64'
assert manifest['selectedComponents'] == ['node', 'zerotier', 'mediamtx', 'mavlink-router', 'console', 'application']
assert manifest['payloadReplay']['status'] == 'complete'
assert manifest['sourceRebuild']['status'] == 'incomplete'
codes = {item['code'] for item in manifest['sourceRebuild']['gaps']}
assert codes == {'UPSTREAM_BINARY_SOURCE_NOT_RETAINED',
                 'OCI_IMAGE_NOT_RETAINED', 'OCI_APT_INPUTS_NOT_RETAINED'}
assert manifest['applicationBundle']['sourceCommit'] == '0123456789abcdef0123456789abcdef01234567'
assert manifest['applicationBundle']['platform'] == 'linux/arm64'
assert manifest['applicationBundle']['offlineBuild']['network'] == 'none'
assert manifest['applicationBundle']['offlineBuild']['status'] == 'verified'
assert next(item for item in manifest['records'] if item['name'] == 'mavlink-router')['identity'] == '0123456789abcdef0123456789abcdef01234567'
assert manifest['toolchains'][0]['retained'] is False
package = next(item for item in manifest['npmPackages'] if item['name'] == 'example')
assert package == {'name':'example','version':'1.2.3','license':'MIT',
                   'noticeFiles':['files/payload/console/node_modules/example/LICENSE']}
paths = {item['path'] for item in manifest['files']}
assert 'files/inputs/downloads/node/node.tar.xz' in paths
assert 'files/inputs/npm/cache/content-v2/package' in paths
assert 'files/inputs/sources/mavlink-router/router.cc' in paths
assert 'files/payload/console/node_modules/example/package.json' in paths
assert any(path.startswith('files/notices/') for path in paths)
for item in manifest['files']:
    path = root / item['path']
    if item['type'] == 'file':
        assert path.stat().st_size == item['bytes']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256']
PY

python3 -I "$helper" replay --input "$work/capture" --output "$work/replayed"
diff -r -x .work "$payload" "$work/replayed"

cp "$staging/records.tsv" "$work/rpi-records.tsv"
mkdir -p "$payload/gst-rockchip" "$staging/inputs/sources/rockchip-mpp" \
    "$staging/inputs/sources/librga" "$staging/inputs/sources/gstreamer-rockchip"
printf 'gst payload\n' >"$payload/gst-rockchip/artifact"
for source in rockchip-mpp librga gstreamer-rockchip; do
    printf '%s source\n' "$source" >"$staging/inputs/sources/$source/source"
    record git-source "$source" fixture "https://git.invalid/$source" "inputs/sources/$source"
done
python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
    --output "$work/rock5c" --target radxa-rock5c --arch linux-arm64 \
    --selected node,zerotier,mediamtx,mavlink-router,gst-rockchip,console,application \
    --toolchain 'application=debian@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
    --toolchain 'mavlink-router=debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    --toolchain 'gst-rockchip=debian@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

mkdir -p "$payload/seekerhd" "$staging/inputs/sources/rkaiq" \
    "$staging/inputs/patches/seekerhd" "$staging/inputs/downloads/seekerhd"
printf 'seeker payload\n' >"$payload/seekerhd/artifact"
printf 'rkaiq source\n' >"$staging/inputs/sources/rkaiq/source"
record git-source rkaiq fixture https://git.invalid/rkaiq inputs/sources/rkaiq
for patch in aiq-server.patch aiq-thread-fallback.patch aiq-sensor-timing.patch \
        aiq-live-controls.patch aiq-vendor-hdr-abi.patch; do
    printf '%s\n' "$patch" >"$staging/inputs/patches/seekerhd/$patch"
    record patch "rkaiq-$patch" fixture "repository:$patch" "inputs/patches/seekerhd/$patch"
done
printf 'reference iq\n' >"$staging/inputs/downloads/seekerhd/reference.json"
printf 'divimath iq\n' >"$staging/inputs/downloads/seekerhd/divimath.json"
record archive seekerhd-reference-iq fixture https://seeker.invalid/reference inputs/downloads/seekerhd/reference.json
record archive seekerhd-divimath-iq fixture https://seeker.invalid/divimath inputs/downloads/seekerhd/divimath.json
python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
    --output "$work/zero3w" --target radxa-zero3w --arch linux-arm64 \
    --selected node,zerotier,mediamtx,mavlink-router,gst-rockchip,seekerhd,console,application \
    --toolchain 'application=debian@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
    --toolchain 'mavlink-router=debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    --toolchain 'gst-rockchip=debian@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    --toolchain 'seekerhd-rkaiq=debian@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
mv "$work/rpi-records.tsv" "$staging/records.tsv"
rm -rf "$payload/gst-rockchip" "$payload/seekerhd" \
    "$staging/inputs/sources/rockchip-mpp" "$staging/inputs/sources/librga" \
    "$staging/inputs/sources/gstreamer-rockchip" "$staging/inputs/sources/rkaiq" \
    "$staging/inputs/patches" "$staging/inputs/downloads/seekerhd"

cp "$staging/inputs/npm/manifests/package-lock.json" "$work/clean-lock.json"
cat >"$staging/inputs/npm/manifests/package-lock.json" <<'JSON'
{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/private":{"resolved":"https://token@registry.npmjs.org/private/-/private-1.0.0.tgz"}}}
JSON
if python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
        --output "$work/private-url" --target rpi --arch linux-arm64 \
        --selected node,zerotier,mediamtx,mavlink-router,console,application \
        --toolchain 'application=debian@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
        --toolchain 'mavlink-router=debian@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
        >"$work/private-url.log" 2>&1; then
    fail 'credential-bearing npm source URL was accepted'
fi
[[ ! -e $work/private-url ]] || fail 'rejected npm source URL left an output directory'
grep -q 'non-public or credential-bearing' "$work/private-url.log" \
    || fail 'credential-bearing npm URL refusal was not specific'
mv "$work/clean-lock.json" "$staging/inputs/npm/manifests/package-lock.json"

printf 'tampered\n' >>"$work/capture/files/payload/node/artifact"
if python3 -I "$helper" replay --input "$work/capture" --output "$work/tampered" \
        >"$work/tamper.log" 2>&1; then
    fail 'tampered retained input replayed'
fi
[[ ! -e $work/tampered ]] || fail 'failed replay left an output directory'
grep -q 'hash mismatch' "$work/tamper.log" || fail 'tamper refusal was not specific'

rm -rf "$work/capture"
ln -s ../../../outside "$staging/inputs/sources/escape"
if python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
        --output "$work/escape" --target rpi --arch linux-arm64 \
        --selected node,zerotier,mediamtx,mavlink-router,console,application \
        >"$work/escape.log" 2>&1; then
    fail 'escaping source symlink was accepted'
fi
[[ ! -e $work/escape ]] || fail 'failed capture left an output directory'
grep -q 'escaping symlink' "$work/escape.log" || fail 'symlink refusal was not specific'
rm "$staging/inputs/sources/escape"

printf 'token=must-not-ship\n' >"$staging/inputs/npm/.npmrc"
if python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
        --output "$work/private-input" --target rpi --arch linux-arm64 \
        --selected node,zerotier,mediamtx,mavlink-router,console,application \
        >"$work/private-input.log" 2>&1; then
    fail 'private access input was accepted'
fi
[[ ! -e $work/private-input ]] || fail 'rejected private input left an output directory'
grep -q 'private access input is forbidden' "$work/private-input.log" \
    || fail 'private access input refusal was not specific'
rm "$staging/inputs/npm/.npmrc"

rm -r "$payload/console"
if python3 -I "$helper" capture --staging "$staging" --payload "$payload" \
        --output "$work/missing" --target rpi --arch linux-arm64 \
        --selected node,zerotier,mediamtx,mavlink-router,console,application \
        >"$work/missing.log" 2>&1; then
    fail 'capture accepted a missing required payload component'
fi
grep -q 'missing required payload component console' "$work/missing.log" \
    || fail 'missing-component refusal was not specific'

if "$repo/installer/make-payload.sh" --arch linux-arm64 --target rpi \
        --capture-inputs "$work/selection" --only node --out "$work/selection-payload" \
        >"$work/selection.log" 2>&1; then
    fail 'production capture accepted a partial selector'
fi
[[ ! -e $work/selection && ! -e $work/selection-payload ]] \
    || fail 'rejected production selector created output'
grep -q 'does not accept --only' "$work/selection.log" \
    || fail 'partial-selector refusal was not specific'

if "$repo/installer/make-payload.sh" --arch linux-arm64 --target rpi \
        --capture-inputs "$work/nested/payload/capture" --out "$work/nested/payload" \
        >"$work/nested.log" 2>&1; then
    fail 'production capture accepted nested output paths'
fi
[[ ! -e $work/nested ]] || fail 'nested-path refusal created output'
grep -q 'separate, non-nested paths' "$work/nested.log" \
    || fail 'nested-path refusal was not specific'

mkdir "$work/fake-bin"
cat >"$work/fake-bin/curl" <<'SH'
#!/bin/sh
exit 9
SH
cat >"$work/fake-bin/dpkg-deb" <<'SH'
#!/bin/sh
exit 9
SH
cat >"$work/fake-bin/git" <<'SH'
#!/bin/sh
case " $* " in
    *" rev-parse HEAD "*) printf '%040d\n' 0 ;;
    *" status --porcelain --untracked-files=all "*) : ;;
    *) exit 9 ;;
esac
SH
cat >"$work/fake-bin/docker" <<'SH'
#!/bin/sh
exit 9
SH
chmod +x "$work/fake-bin/curl" "$work/fake-bin/dpkg-deb" \
    "$work/fake-bin/git" "$work/fake-bin/docker"
if PATH="$work/fake-bin:$PATH" "$repo/installer/make-payload.sh" \
        --arch linux-arm64 --target rpi --out "$work/failed-payload" \
        --capture-inputs "$work/failed-capture" >"$work/failed-build.log" 2>&1; then
    fail 'fixture download failure unexpectedly built a production payload'
fi
[[ ! -e $work/failed-payload && ! -e $work/failed-capture ]] \
    || fail 'failed production capture left a partial output'
grep -q 'could not download' "$work/failed-build.log" \
    || fail 'fixture build did not reach the retained-download boundary'

echo 'PASS: application payload inputs, sources, notices and output are inventoried and replay is fail-closed.'
