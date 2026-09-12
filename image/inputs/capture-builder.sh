#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Explicit input refresh. Final assembly loads the saved image without networking.
set -euo pipefail
umask 077
runtime='debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1'
if [[ ${1:-} == --inside ]]; then
    [[ $# == 1 && -f /.dockerenv && $(uname -m) == aarch64 ]]
    export DEBIAN_FRONTEND=noninteractive
    sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
    apt-get -o APT::Update::Error-Mode=any update
    apt-get dist-upgrade -y --no-install-recommends
    apt-get install -y --no-install-recommends build-essential binutils ca-certificates \
        cpio dosfstools e2fsprogs fdisk gdisk python3 util-linux xz-utils zstd
    mkdir -p /capture/sources /capture/notices
    dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n' \
        | LC_ALL=C sort > /capture/packages.tsv
    python3 -I - <<'PY'
from pathlib import Path
import shutil
sources = set()
for line in Path('/capture/packages.tsv').read_text().splitlines():
    package, version, arch, source, source_version = line.split('\t')
    sources.add((source or package.split(':')[0], source_version or version))
    notice = Path('/usr/share/doc') / package.split(':')[0] / 'copyright'
    if not notice.is_file():
        raise SystemExit('builder package copyright notice unavailable')
    shutil.copyfile(notice, Path('/capture/notices') / (package.replace(':', '_') + '.copyright'))
Path('/capture/source-requests.txt').write_text(''.join(f'{s}={v}\n' for s,v in sorted(sources)))
PY
    mapfile -t source_requests </capture/source-requests.txt
    (cd /capture/sources && apt-get source --download-only "${source_requests[@]}")
    cp /etc/apt/sources.list.d/debian.sources /capture/debian.sources
    apt-get clean
    rm -rf /var/lib/apt/lists/*
    exit 0
fi
[[ $# == 2 && $1 == --output && -n $2 && ! -e $2 ]] || {
    echo 'Usage: image/inputs/capture-builder.sh --output NEW_DIRECTORY' >&2; exit 2;
}
mkdir -p "$2"
output=$(cd "$2" && pwd)
script=$(cd "$(dirname "$0")" && pwd)/capture-builder.sh
container="yonder-builder-input-$$"
created=0
cleanup() {
    status=$?
    trap - EXIT
    if [[ $created == 1 ]]; then docker rm -f "$container" >/dev/null || status=1; fi
    exit "$status"
}
trap cleanup EXIT
docker run -d --name "$container" --platform linux/arm64 "$runtime" sleep infinity >/dev/null
created=1
docker cp "$script" "$container:/capture-builder.sh"
docker exec "$container" bash /capture-builder.sh --inside
docker cp "$container:/capture" "$output/retained"
docker exec "$container" rm -rf /capture /capture-builder.sh
image_id=$(docker commit "$container")
[[ $image_id =~ ^sha256:[a-f0-9]{64}$ ]]
docker image inspect "$image_id" >"$output/oci-inspect.json"
docker image save "$image_id" >"$output/builder.docker.tar"
python3 -I - "$output" "$runtime" "$image_id" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
files = []
for path in sorted(root.rglob('*')):
    if path.is_file():
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        h = digest.hexdigest()
        files.append({'path':str(path.relative_to(root)), 'sha256':h, 'bytes':path.stat().st_size})
(root/'builder-input.json').write_text(json.dumps({'schemaVersion':1,'kind':'yonder-builder-input',
    'platform':'linux/arm64','baseRuntime':sys.argv[2],'imageId':sys.argv[3],'files':files}, indent=2)+'\n')
PY
echo "Frozen builder input: $output"
