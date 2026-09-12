#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -Eeuo pipefail
source_dir=${1:-$(cd "${BASH_SOURCE[0]%/*}" && pwd)}
scratch=$(mktemp -d /tmp/yonder-layout-test.XXXXXX)
trap 'rm -rf "$scratch"' EXIT INT TERM
# shellcheck disable=SC1091 # explicit test argument
. "$source_dir/layout.sh"

radxa=$scratch/radxa.conf
cat >"$radxa" <<'EOF'
SCHEMA_VERSION=1
KIND=yonder-storage-layout
TARGET=radxa-zero3w
PARTITION_TABLE=gpt
ROOT_UUID=11111111-1111-4111-8111-111111111111
STATE_UUID=22222222-2222-4222-8222-222222222222
LOG_UUID=33333333-3333-4333-8333-333333333333
MEDIA_UUID=44444444-4444-4444-8444-444444444444
DISK_GUID=55555555-5555-4555-8555-555555555555
ROOT_PARTUUID=66666666-6666-4666-8666-666666666666
STATE_PARTUUID=77777777-7777-4777-8777-777777777777
LOG_PARTUUID=88888888-8888-4888-8888-888888888888
MEDIA_PARTUUID=99999999-9999-4999-8999-999999999999
ROOT_TYPE_GUID=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
STATE_TYPE_GUID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
LOG_TYPE_GUID=cccccccc-cccc-4ccc-8ccc-cccccccccccc
MEDIA_TYPE_GUID=dddddddd-dddd-4ddd-8ddd-dddddddddddd
ROOT_START=32768
ROOT_SIZE=12582912
STATE_START=12615680
STATE_SIZE=1048576
LOG_START=13664256
LOG_SIZE=524288
MEDIA_START=14188544
MEDIA_MIN_SIZE=1048576
MEDIA_PARTLABEL=yonder-media
EOF
yonder_read_layout "$radxa" radxa-zero3w
[ "$TARGET:$ROOT_SIZE:$MEDIA_PARTLABEL" = radxa-zero3w:12582912:yonder-media ]

pi=$scratch/pi.conf
cat >"$pi" <<'EOF'
SCHEMA_VERSION=1
KIND=yonder-storage-layout
TARGET=rpi
PARTITION_TABLE=mbr
MBR_DISK_ID=041bba91
BOOT_UUID=B2F0-82D2
ROOT_UUID=15f4c6be-1102-4331-9904-f78e78afd1fd
STATE_UUID=1b09abf7-4d55-4ec3-b480-0e503f6ad440
LOG_UUID=80305cc3-c18e-4d6c-b14d-22f78a536c40
MEDIA_UUID=e43b8b78-96ce-407a-817c-a36156158e6b
BOOT_START=16384
BOOT_SIZE=1048576
ROOT_START=1064960
ROOT_SIZE=12582912
STATE_START=13647872
STATE_SIZE=1048576
EXTENDED_START=14696448
EXTENDED_MIN_SIZE=2080768
LOG_START=14698496
LOG_SIZE=524288
SECOND_EBR=15222784
MEDIA_START=15224832
MEDIA_MIN_SIZE=1552384
EOF
yonder_read_layout "$pi" rpi
[ "$TARGET:$ROOT_SIZE:$SECOND_EBR" = rpi:12582912:15222784 ]

awk '{ if ($0 ~ /^ROOT_SIZE=/) print "ROOT_SIZE=12582913"; else print }' \
    "$pi" >"$scratch/invalid.conf"
if yonder_read_layout "$scratch/invalid.conf" rpi >/dev/null 2>&1; then exit 1; fi
cp "$radxa" "$scratch/invalid.conf"
printf '%s\n' UNEXPECTED=value >>"$scratch/invalid.conf"
if yonder_read_layout "$scratch/invalid.conf" radxa-zero3w >/dev/null 2>&1; then exit 1; fi
awk '{ if ($0 ~ /^STATE_UUID=/) sub(/^STATE_UUID=/, "WRONG_KEY="); print }' \
    "$radxa" >"$scratch/invalid.conf"
if yonder_read_layout "$scratch/invalid.conf" radxa-zero3w >/dev/null 2>&1; then exit 1; fi
printf '%4097s' x >"$scratch/invalid.conf"
if yonder_read_layout "$scratch/invalid.conf" radxa-zero3w >/dev/null 2>&1; then exit 1; fi
printf '%s\n' 'PASS: exact production storage layouts parse without source/eval and reordered, foreign, oversized or altered fixed Pi layouts fail closed.'
