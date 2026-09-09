#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
test_transport=${1:-tcp}
case "$test_transport" in tcp|udp) ;; *) exit 2;; esac
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
result_dir=$(mktemp -d /tmp/yonder-rtsp-adaptive.XXXXXX)
fixture_id="yonder-rtsp-$$"
cleanup() {
 docker rm -f "$fixture_id-client" "$fixture_id-server" >/dev/null 2>&1 || true
 docker network rm "$fixture_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker network create "$fixture_id" >/dev/null
docker run -d --env TEST_TRANSPORT="$test_transport" --name "$fixture_id-server" --network "$fixture_id" --network-alias media --cap-add NET_ADMIN -v "$repo_dir:/work:ro" -v "$result_dir:/results" yonder-rtsp-adaptive-test:local node scripts/tests/rtsp-adaptive/server.mjs >/dev/null
for attempt in $(seq 1 150); do
 test ! -e "$result_dir/result.json" || break
 test ! -e "$result_dir/ready" || break
 sleep 1
done
docker run -d --env TEST_TRANSPORT="$test_transport" --name "$fixture_id-client" --network "$fixture_id" -v "$repo_dir:/work:ro" -v "$result_dir:/results" yonder-rtsp-adaptive-test:local python3 scripts/tests/rtsp-adaptive/receiver.py >/dev/null
code=$(docker wait "$fixture_id-server")
docker logs "$fixture_id-server"
docker logs "$fixture_id-client" > "$result_dir/receiver.log" 2>&1 || true
printf 'Results: %s\n' "$result_dir"
cat "$result_dir/result.json"
exit "$code"
