#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -Eeuo pipefail
[[ -f /.dockerenv ]]
source_dir=${1:-/repo/image/storage}
scratch=$(mktemp -d /tmp/yonder-maintenance-token.XXXXXX)
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT INT TERM
cc -std=c11 -O2 -Wall -Wextra -Werror -static \
    "$source_dir/maintenance-token.c" -o "$scratch/helper"
if readelf -l "$scratch/helper" | grep -q 'Requesting program interpreter'; then
    exit 1
fi

root=$scratch/root
transactions=$root/var/lib/yonder-state/transactions
maintenance=$root/var/lib/yonder-state/maintenance
mkdir -p "$transactions" "$maintenance"
chmod 0700 "$transactions" "$maintenance"
operation=12345678-1234-4123-8123-123456789abc
generation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
write_operation() {
    printf '{"schemaVersion":1,"id":"%s","kind":"maintenance","phase":"%s","previousGeneration":"%s","maintenance":{"schemaVersion":1,"mode":"writable-next-boot"},"startedAt":1789160000000}\n' \
        "$operation" "$1" "$generation" >"$transactions/operation.json"
    chmod 0600 "$transactions/operation.json"
}
write_token() {
    printf '{"schemaVersion":1,"kind":"yonder-maintenance-boot","operationId":"%s"}\n' \
        "$1" >"$maintenance/pending.json"
    chmod 0600 "$maintenance/pending.json"
}

write_operation awaiting-maintenance-reboot
# A power cut after the temp file is synced but before its publish rename is
# unarmed. The initramfs helper durably discards only this exact private temp.
write_token "$operation"
mv "$maintenance/pending.json" "$maintenance/pending.json.tmp"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 10 && ! -e $maintenance/pending.json.tmp ]]

# Once the rename is visible, the same exact bytes are an armed request even
# if the directory fsync had not completed when power was lost.
write_token "$operation"
mv "$maintenance/pending.json" "$maintenance/pending.json.tmp"
mv "$maintenance/pending.json.tmp" "$maintenance/pending.json"
[[ $("$scratch/helper" consume "$root") == maintenance ]]
rm "$maintenance/consumed.json"

# A nonprivate temp or a temp alongside a published token is corruption.
write_token "$operation"
mv "$maintenance/pending.json" "$maintenance/pending.json.tmp"
chmod 0644 "$maintenance/pending.json.tmp"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json.tmp ]]
chmod 0600 "$maintenance/pending.json.tmp"
write_token "$operation"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json.tmp && -f $maintenance/pending.json ]]
rm "$maintenance/pending.json.tmp" "$maintenance/pending.json"

write_token "$operation"
[[ $("$scratch/helper" consume "$root") == maintenance ]]
[[ ! -e $maintenance/pending.json && -f $maintenance/consumed.json ]]
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 10 ]]

rm "$maintenance/consumed.json"
write_token aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json ]]

write_token "$operation"
printf ' ' >>"$maintenance/pending.json"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json ]]

write_token "$operation"
chmod 0644 "$maintenance/pending.json"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json ]]

chmod 0600 "$maintenance/pending.json"
write_operation entered-maintenance
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json ]]

write_operation awaiting-maintenance-reboot
printf 'x%.0s' {1..513} >"$transactions/operation.json"
chmod 0600 "$transactions/operation.json"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json ]]

write_operation awaiting-maintenance-reboot
touch "$maintenance/unexpected"
set +e
"$scratch/helper" consume "$root"
status=$?
set -e
[[ $status -eq 20 && -f $maintenance/pending.json ]]

printf '%s\n' 'PASS: static initramfs helper strictly consumes one matching private maintenance token and fails closed.'
