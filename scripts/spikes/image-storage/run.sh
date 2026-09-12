#!/bin/sh
# Disposable Linux-only mount/account/APT experiment; no host directories/devices mounted.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
probe_image=${YONDER_PROBE_IMAGE:-debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1}
probe_name="yonder-storage-probe-$$"
cleanup() { docker rm -f "$probe_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
test "$(docker info --format '{{.OSType}}')" = linux
docker run -d --name "$probe_name" --cap-add SYS_ADMIN "$probe_image" sleep infinity >/dev/null
docker image inspect "$probe_image" --format '{{.Id}} {{.Architecture}}'
docker cp "$script_dir/container-probe.sh" "$probe_name:/prototype.sh"
docker cp "$script_dir/restart-check.sh" "$probe_name:/restart-check.sh"
if ! docker exec "$probe_name" sh /prototype.sh; then
  docker exec "$probe_name" sh -c 'for f in /lab/normal-apt-result /lab/apt-update.log /lab/apt-install.log; do test ! -f "$f" || tail -20 "$f"; done' || true
  exit 1
fi
docker restart "$probe_name" >/dev/null
docker exec "$probe_name" sh /restart-check.sh
