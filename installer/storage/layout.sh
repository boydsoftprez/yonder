#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# shellcheck disable=SC2034 # fields are consumed by scripts that source this parser
# Strict parser for the builder-generated storage layout. This file is code;
# the layout itself is never sourced or evaluated.

yonder_layout_fail() {
    echo "Yonder storage layout: $*" >&2
    return 1
}

yonder_layout_field() {
    expected=$1
    IFS= read -r layout_line <&3 || {
        yonder_layout_fail "missing $expected"
        return 1
    }
    layout_key=${layout_line%%=*}
    layout_value=${layout_line#*=}
    [ "$layout_key" = "$expected" ] && [ -n "$layout_value" ] &&
        [ "$layout_line" = "$layout_key=$layout_value" ] || {
        yonder_layout_fail "expected $expected"
        return 1
    }
    case "$layout_value" in *'='*) yonder_layout_fail "invalid $expected"; return 1 ;; esac
}

yonder_layout_uuid() {
    printf '%s\n' "$1" | grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
}

yonder_layout_number() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    [ "$1" -gt 0 ] 2>/dev/null
}

yonder_read_layout() {
    layout_path=$1
    expected_target=$2
    [ -f "$layout_path" ] && [ ! -L "$layout_path" ] || {
        yonder_layout_fail 'layout file is not regular'
        return 1
    }
    layout_size=$(wc -c <"$layout_path" | tr -d '[:space:]') || return 1
    yonder_layout_number "$layout_size" && [ "$layout_size" -le 4096 ] || {
        yonder_layout_fail 'file size is invalid'
        return 1
    }
    exec 3<"$layout_path"
    yonder_layout_field SCHEMA_VERSION && SCHEMA_VERSION=$layout_value
    yonder_layout_field KIND && KIND=$layout_value
    yonder_layout_field TARGET && TARGET=$layout_value
    yonder_layout_field PARTITION_TABLE && PARTITION_TABLE=$layout_value
    case "$expected_target:$TARGET" in
        radxa:radxa-zero3w|radxa:radxa-rock5c|rpi:rpi|radxa-zero3w:radxa-zero3w|radxa-rock5c:radxa-rock5c)
            target_matches=1 ;;
        *) target_matches=0 ;;
    esac
    [ "$SCHEMA_VERSION:$KIND:$target_matches" = "1:yonder-storage-layout:1" ] || {
        exec 3<&-
        yonder_layout_fail 'header does not match the selected target'
        return 1
    }
    case "$TARGET:$PARTITION_TABLE" in
        radxa-zero3w:gpt|radxa-rock5c:gpt)
            for field in ROOT_UUID STATE_UUID LOG_UUID MEDIA_UUID DISK_GUID \
                    ROOT_PARTUUID STATE_PARTUUID LOG_PARTUUID MEDIA_PARTUUID \
                    ROOT_TYPE_GUID STATE_TYPE_GUID LOG_TYPE_GUID MEDIA_TYPE_GUID; do
                yonder_layout_field "$field" || { exec 3<&-; return 1; }
                yonder_layout_uuid "$layout_value" || {
                    exec 3<&-
                    yonder_layout_fail "invalid $field"
                    return 1
                }
                case "$field" in
                    ROOT_UUID) ROOT_UUID=$layout_value ;; STATE_UUID) STATE_UUID=$layout_value ;;
                    LOG_UUID) LOG_UUID=$layout_value ;; MEDIA_UUID) MEDIA_UUID=$layout_value ;;
                    DISK_GUID) DISK_GUID=$layout_value ;; ROOT_PARTUUID) ROOT_PARTUUID=$layout_value ;;
                    STATE_PARTUUID) STATE_PARTUUID=$layout_value ;; LOG_PARTUUID) LOG_PARTUUID=$layout_value ;;
                    MEDIA_PARTUUID) MEDIA_PARTUUID=$layout_value ;; ROOT_TYPE_GUID) ROOT_TYPE_GUID=$layout_value ;;
                    STATE_TYPE_GUID) STATE_TYPE_GUID=$layout_value ;; LOG_TYPE_GUID) LOG_TYPE_GUID=$layout_value ;;
                    MEDIA_TYPE_GUID) MEDIA_TYPE_GUID=$layout_value ;;
                esac
            done
            for field in ROOT_START ROOT_SIZE STATE_START STATE_SIZE LOG_START LOG_SIZE MEDIA_START MEDIA_MIN_SIZE; do
                yonder_layout_field "$field" || { exec 3<&-; return 1; }
                yonder_layout_number "$layout_value" || {
                    exec 3<&-
                    yonder_layout_fail "invalid $field"
                    return 1
                }
                case "$field" in
                    ROOT_START) ROOT_START=$layout_value ;; ROOT_SIZE) ROOT_SIZE=$layout_value ;;
                    STATE_START) STATE_START=$layout_value ;; STATE_SIZE) STATE_SIZE=$layout_value ;;
                    LOG_START) LOG_START=$layout_value ;; LOG_SIZE) LOG_SIZE=$layout_value ;;
                    MEDIA_START) MEDIA_START=$layout_value ;; MEDIA_MIN_SIZE) MEDIA_MIN_SIZE=$layout_value ;;
                esac
            done
            yonder_layout_field MEDIA_PARTLABEL || { exec 3<&-; return 1; }
            MEDIA_PARTLABEL=$layout_value
            [ "$MEDIA_PARTLABEL" = yonder-media ] || {
                exec 3<&-
                yonder_layout_fail 'invalid media label'
                return 1
            }
            ;;
        rpi:mbr)
            yonder_layout_field MBR_DISK_ID && MBR_DISK_ID=$layout_value
            [ "$MBR_DISK_ID" = 041bba91 ] || { exec 3<&-; yonder_layout_fail 'invalid MBR identifier'; return 1; }
            yonder_layout_field BOOT_UUID && BOOT_UUID=$layout_value
            [ "$BOOT_UUID" = B2F0-82D2 ] || { exec 3<&-; yonder_layout_fail 'invalid boot UUID'; return 1; }
            for field in ROOT_UUID STATE_UUID LOG_UUID MEDIA_UUID; do
                yonder_layout_field "$field" || { exec 3<&-; return 1; }
                yonder_layout_uuid "$layout_value" || { exec 3<&-; yonder_layout_fail "invalid $field"; return 1; }
                case "$field" in ROOT_UUID) ROOT_UUID=$layout_value ;; STATE_UUID) STATE_UUID=$layout_value ;;
                    LOG_UUID) LOG_UUID=$layout_value ;; MEDIA_UUID) MEDIA_UUID=$layout_value ;; esac
            done
            for field in BOOT_START BOOT_SIZE ROOT_START ROOT_SIZE STATE_START STATE_SIZE \
                    EXTENDED_START EXTENDED_MIN_SIZE LOG_START LOG_SIZE SECOND_EBR MEDIA_START MEDIA_MIN_SIZE; do
                yonder_layout_field "$field" || { exec 3<&-; return 1; }
                yonder_layout_number "$layout_value" || { exec 3<&-; yonder_layout_fail "invalid $field"; return 1; }
                case "$field" in BOOT_START) BOOT_START=$layout_value ;; BOOT_SIZE) BOOT_SIZE=$layout_value ;;
                    ROOT_START) ROOT_START=$layout_value ;; ROOT_SIZE) ROOT_SIZE=$layout_value ;;
                    STATE_START) STATE_START=$layout_value ;; STATE_SIZE) STATE_SIZE=$layout_value ;;
                    EXTENDED_START) EXTENDED_START=$layout_value ;; EXTENDED_MIN_SIZE) EXTENDED_MIN_SIZE=$layout_value ;;
                    LOG_START) LOG_START=$layout_value ;; LOG_SIZE) LOG_SIZE=$layout_value ;;
                    SECOND_EBR) SECOND_EBR=$layout_value ;; MEDIA_START) MEDIA_START=$layout_value ;;
                    MEDIA_MIN_SIZE) MEDIA_MIN_SIZE=$layout_value ;; esac
            done
            [ "$ROOT_UUID:$STATE_UUID:$LOG_UUID:$MEDIA_UUID" = \
                15f4c6be-1102-4331-9904-f78e78afd1fd:1b09abf7-4d55-4ec3-b480-0e503f6ad440:80305cc3-c18e-4d6c-b14d-22f78a536c40:e43b8b78-96ce-407a-817c-a36156158e6b ] &&
            [ "$BOOT_START:$BOOT_SIZE:$ROOT_START:$ROOT_SIZE" = \
                16384:1048576:1064960:12582912 ] &&
            [ "$STATE_START:$STATE_SIZE:$EXTENDED_START:$EXTENDED_MIN_SIZE" = \
                13647872:1048576:14696448:2080768 ] &&
            [ "$LOG_START:$LOG_SIZE:$SECOND_EBR:$MEDIA_START:$MEDIA_MIN_SIZE" = \
                14698496:524288:15222784:15224832:1552384 ] || {
                exec 3<&-
                yonder_layout_fail 'Pi layout differs from the accepted fixed geometry'
                return 1
            }
            ;;
        *) exec 3<&-; yonder_layout_fail 'partition table does not match target'; return 1 ;;
    esac
    if IFS= read -r layout_line <&3 || [ -n "${layout_line:-}" ]; then
        exec 3<&-
        yonder_layout_fail 'unexpected trailing field'
        return 1
    fi
    exec 3<&-
}
