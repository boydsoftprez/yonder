#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# End-to-end proof that the console's *pages* fit together, on this machine.
#
# scripts/verify-console.sh proved the spine: a daemon, a socket, a gate, one
# setup page. This is the other half — the shipped `flows/flows.json` loaded by
# a real Node-RED with the real Dashboard, with the two contrib packages
# installed, in front of the real daemon.
#
# What it stands between: "every node has unit tests" and "the flows load".
# Those are not the same claim, and the gap between them is exactly where a
# mistyped node type, a dangling group reference or a package that does not
# resolve `yonder-core` lives. None of those fails a unit test; all of them are
# a console page that is silently missing a control.
#
# Since R-UI-12 it also captures every page in both palettes in a real browser,
# checks that nothing is clipped and no action spans its surface, and fails when
# a page changed shape without somebody accepting it.
#
# What it does NOT prove: that a widget is usable on a tablet, that a reading is
# legible in sunlight, or anything at all about hardware, systemd,
# NetworkManager or a radio. Those need a board and a person holding it.
#
#     ./scripts/verify-pages.sh
#     ACCEPT_SHAPE=1 ./scripts/verify-pages.sh   # adopt a deliberate change
#
# Requires: a node new enough for Node-RED (22.12+), curl, a built yonder-core
# and contrib tree (`npm run build`), and a console tree staged by
# installer/make-payload.sh. Everything it creates lives in one temporary
# directory and is removed on exit.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/.." && pwd)
CORE="$REPO/packages/yonder-core"
CONSOLE_TREE=${CONSOLE_TREE:-$REPO/vendor/console}
PORT=${PORT:-18881}

pass=0
fail=0

say()  { printf '\n== %s\n' "$*"; }
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is needed"
command -v node >/dev/null 2>&1 || die "node is needed"
[ -f "$CORE/dist/daemon/server.js" ] || die "no built daemon; run: npm run build"
[ -f "$REPO/packages/node-red-contrib-yonder-system/dist/status.js" ] \
    || die "the contrib packages are not built; run: npm run build"
[ -f "$CONSOLE_TREE/node_modules/node-red/red.js" ] \
    || die "no console tree at $CONSOLE_TREE; run: ./installer/make-payload.sh --arch linux-arm64"
[ -d "$CONSOLE_TREE/node_modules/@flowfuse/node-red-dashboard" ] \
    || die "the console tree has no dashboard in it; re-run installer/make-payload.sh"

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/yonder-pages.XXXXXX")
ETC="$ROOT/etc/yonder"
RUN="$ROOT/run/yonder"
STATE="$ROOT/var/lib/yonder"
CONSOLE="$ROOT/opt/yonder/console"
USERDIR="$STATE/console"
SOCKET="$RUN/core.sock"
JOURNAL="$ROOT/journal.log"
BIN="$ROOT/bin"
SYSTEMCTL_LOG="$ROOT/systemctl.log"

mkdir -p "$ETC" "$RUN" "$STATE" "$CONSOLE" "$USERDIR" "$BIN"
: > "$JOURNAL"
: > "$SYSTEMCTL_LOG"

# Stand-ins for everything the daemon shells out to. None of them exists on a
# development machine, and their absence would stop the run before it reached
# anything under test. `ping` answers the way a host that replied does, so the
# diagnostics route has something real to parse.
cat > "$BIN/systemctl" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
FAKE
cat > "$BIN/nmcli" <<'FAKE'
#!/bin/sh
case "$*" in
    *"device status"*)
        printf 'lo:loopback:connected:lo\nwlan0:wifi:disconnected:\n' ;;
    *"device wifi list"*)
        printf 'HomeNetwork:78:WPA2\nHomeNetwork:41:WPA2\nCafe:33:--\n' ;;
    *"connection show"*) : ;;
esac
exit 0
FAKE
cat > "$BIN/rfkill" <<'FAKE'
#!/bin/sh
exit 0
FAKE
cat > "$BIN/hostnamectl" <<'FAKE'
#!/bin/sh
exit 0
FAKE
cat > "$BIN/ping" <<'FAKE'
#!/bin/sh
printf 'PING\n3 packets transmitted, 3 received, 0%% packet loss, time 2003ms\n'
printf 'rtt min/avg/max/mdev = 8.294/9.117/10.352/0.884 ms\n'
exit 0
FAKE
chmod +x "$BIN/systemctl" "$BIN/nmcli" "$BIN/rfkill" "$BIN/hostnamectl" "$BIN/ping"

sed "s/^  port: .*/  port: $PORT/" "$REPO/config/defaults/config.yaml" > "$ETC/config.yaml"
grep -q "port: $PORT" "$ETC/config.yaml" || die "could not set the console port in $ETC/config.yaml"

DAEMON_PID=""
CONSOLE_PID=""
cleanup() {
    [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null
    [ -n "$DAEMON_PID" ]  && kill "$DAEMON_PID" 2>/dev/null
    wait 2>/dev/null
    [ "${KEEP:-0}" = "1" ] || rm -rf "$ROOT"
    return 0
}
trap cleanup EXIT INT TERM

PASSWORD='verify-pages-Kp4Rn8Wq'
POLL=0.2
TRIES=200

give_up() {
    printf '\n--- %s ---\n' "$JOURNAL"
    cat "$JOURNAL" 2>/dev/null
    die "$1"
}

start_daemon() {
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
    YONDER_SOCKET="$SOCKET" \
    YONDER_CONFIG="$ETC/config.yaml" \
    YONDER_SECRETS="$ETC/secrets.yaml" \
    YONDER_JOURNAL="$STATE/apply.json" \
    YONDER_CONSOLE_SETTINGS="$CONSOLE/settings.js" \
    YONDER_CONSOLE_USERDIR="$USERDIR" \
    YONDER_CONSOLE_CORE_TREE="$CORE" \
    YONDER_CONSOLE_UNIT="yonder-console.service" \
    PATH="$BIN:$PATH" \
        node "$CORE/dist/daemon/server.js" >>"$JOURNAL" 2>&1 &
    DAEMON_PID=$!
}

wait_for_socket() {
    i=0
    while [ "$i" -lt "$TRIES" ]; do
        [ -S "$SOCKET" ] && return 0
        kill -0 "$DAEMON_PID" 2>/dev/null || give_up "the daemon exited before binding $SOCKET"
        sleep "$POLL"
        i=$((i + 1))
    done
    give_up "the daemon never bound $SOCKET"
}

wait_for_console() {
    i=0
    while [ "$i" -lt "$TRIES" ]; do
        if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then return 0; fi
        kill -0 "$CONSOLE_PID" 2>/dev/null || give_up "the console exited before it answered"
        sleep "$POLL"
        i=$((i + 1))
    done
    give_up "the console never answered on port $PORT"
}

status() { curl -s -o /dev/null -w '%{http_code}' -b "$ROOT/cookies" -X "$1" "http://127.0.0.1:$PORT$2"; }
body()   { curl -s -b "$ROOT/cookies" "http://127.0.0.1:$PORT$1"; }
sock()   { curl -s --unix-socket "$SOCKET" "http://localhost$1"; }
sock_post() {
    curl -s -H 'content-type: application/json' --data "$2" \
        --unix-socket "$SOCKET" "http://localhost$1"
}

expect() {
    what="$1"; want="$2"; got="$3"
    if [ "$want" = "$got" ]; then ok "$what ($got)"; else bad "$what: wanted $want, got $got"; fi
}
check() { ck_msg="$1"; shift; if "$@"; then ok "$ck_msg"; else bad "$ck_msg"; fi; }
expect_contains() {
    what="$1"; needle="$2"; haystack="$3"
    case "$haystack" in
        *"$needle"*) ok "$what" ;;
        *) bad "$what: '$needle' is not in the reply" ;;
    esac
}
expect_missing() {
    what="$1"; needle="$2"; haystack="$3"
    case "$haystack" in
        *"$needle"*) bad "$what: '$needle' is in the reply and must not be" ;;
        *) ok "$what" ;;
    esac
}

# ---------------------------------------------------------------------------
say "a provisioned daemon, and the console it generates"
printf '  root: %s\n' "$ROOT"

start_daemon
wait_for_socket
ok "the daemon bound $SOCKET"

curl -s -o /dev/null -H 'content-type: application/json' \
    --data "{\"password\":\"$PASSWORD\"}" \
    --unix-socket "$SOCKET" http://localhost/admin/password
i=0
while [ "$i" -lt "$TRIES" ]; do
    grep -q "provisioned: true" "$CONSOLE/settings.js" 2>/dev/null && break
    sleep "$POLL"; i=$((i + 1))
done
check "settings.js is provisioned" grep -q "provisioned: true" "$CONSOLE/settings.js"
check "it serves the real flows file" grep -q 'flowFile: "flows.json"' "$CONSOLE/settings.js"
check "it mounts one static directory" grep -q 'httpStatic:' "$CONSOLE/settings.js"
check "it tells the nodes where the socket is" grep -q "socketPath: \"$SOCKET\"" "$CONSOLE/settings.js"
check "the palette was generated" test -f "$CONSOLE/public/theme.css"
check "and it is the day palette, which is the default" \
    grep -q -- '--yonder-theme: "day"' "$CONSOLE/public/theme.css"

# ---------------------------------------------------------------------------
say "the routes the pages read, over the socket"

expect_contains "GET /system reports a board"        '"display"'   "$(sock /system)"
expect_contains "GET /net/scan folds the mesh"       '"ssid":"HomeNetwork"' "$(sock /net/scan)"
expect_missing  "and carries no key"                 'psk'         "$(sock /net/scan)"
expect_contains "GET /log has the daemon's own start-up" '"level"' "$(sock /log)"
expect_contains "GET /diag/reachable probes"         '"reachable":true' "$(sock /diag/reachable)"

ping_json=$(curl -s -H 'content-type: application/json' --data '{"host":"1.1.1.1"}' \
    --unix-socket "$SOCKET" http://localhost/diag/ping)
expect_contains "POST /diag/ping parses what ping printed" '"rttMs":9.117' "$ping_json"
bad_host=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    --data '{"host":"1.1.1.1; reboot"}' --unix-socket "$SOCKET" http://localhost/diag/ping)
expect "and refuses a host that is not one" 400 "$bad_host"

# ---------------------------------------------------------------------------
say "the shipped flows, in a real Node-RED with the real dashboard"

# What 30-console.sh does on a board: place the flows, and put the contrib
# packages where the console's own node resolution will find them.
cp "$REPO/flows/flows.json" "$USERDIR/flows.json"
mkdir -p "$CONSOLE/node_modules"
# rm then ln, never `ln -sfn`: -n is not POSIX, and without it `ln -sf` onto an
# existing symlink-to-a-directory creates the link inside it.
for pkg in node-red-contrib-yonder-system node-red-contrib-yonder-network; do
    rm -f "$CONSOLE/node_modules/$pkg"
    ln -s "$REPO/packages/$pkg" "$CONSOLE/node_modules/$pkg"
done
rm -f "$CONSOLE/node_modules/yonder-core"
ln -s "$CORE" "$CONSOLE/node_modules/yonder-core"
# The dashboard and node-red itself come from the staged tree.
for entry in "$CONSOLE_TREE/node_modules"/*; do
    name=$(basename "$entry")
    [ -e "$CONSOLE/node_modules/$name" ] || ln -s "$entry" "$CONSOLE/node_modules/$name"
done

node "$CONSOLE/node_modules/node-red/red.js" -s "$CONSOLE/settings.js" >>"$JOURNAL" 2>&1 &
CONSOLE_PID=$!
wait_for_console

# Node-RED says so itself, and this is the assertion that matters: a flow file
# with a type nothing registers starts anyway, with the node inert.
i=0
while [ "$i" -lt "$TRIES" ]; do
    grep -q "Started flows" "$JOURNAL" && break
    sleep "$POLL"; i=$((i + 1))
done
check "the flows started" grep -q "Started flows" "$JOURNAL"

if grep -qi "unknown type\|Type not registered\|missing types" "$JOURNAL"; then
    bad "Node-RED could not register every node type in the shipped flows"
    grep -i "unknown type\|Type not registered\|missing types" "$JOURNAL" | sed 's/^/      /'
else
    ok "every node type in the shipped flows registered"
fi

# The failure this whole script exists for. A widget whose group does not
# resolve logs one line and then simply never appears — the page renders, the
# control is absent, and nothing on screen says why. It is what a config node
# whose id collides with a node type produces, which is what the first run of
# this script found.
if grep -q "No group configured\|Circular config node" "$JOURNAL"; then
    bad "a widget could not find its group, so it will not appear on any page"
    grep "No group configured\|Circular config node" "$JOURNAL" | head -5 | sed 's/^/      /'
else
    ok "every widget found its group, page and dashboard"
fi

if grep -q "\[error\]" "$JOURNAL"; then
    bad "the console logged an error while starting the shipped flows"
    grep "\[error\]" "$JOURNAL" | head -8 | sed 's/^/      /'
else
    ok "the console logged no error at all"
fi

for type in yonder-status yonder-activity yonder-diag yonder-config yonder-scan yonder-apply yonder-confirm yonder-join; do
    if grep -q "\"$type\"" "$USERDIR/flows.json" || grep -q "$type" "$REPO/flows/flows.json"; then
        ok "the flows use $type"
    else
        bad "$type is registered but the flows never use it"
    fi
done

# ---------------------------------------------------------------------------
say "the dashboard and its palette are both behind the login"

# Node-RED mounts httpNodeAuth before httpStatic, so the palette is gated
# exactly like the dashboard it styles. That is the right place for it: the
# login page carries its own inline CSS and needs none of this.
: > "$ROOT/cookies"
expect_contains "the palette asks for a sign-in first" "Sign in" "$(body /yonder/theme.css)"
expect_contains "the dashboard asks for a sign-in first" "Sign in" "$(body /dashboard)"

curl -s -o /dev/null -c "$ROOT/cookies" \
    --data-urlencode "password=$PASSWORD" "http://127.0.0.1:$PORT/login"
check "a session cookie was set" grep -q yonder_session "$ROOT/cookies"

expect_contains "the palette is served with a session" "--yonder-background" "$(body /yonder/theme.css)"
expect_missing  "the static mount does not expose settings.js" "uiPort" "$(body /yonder/settings.js)"

dash=$(body /dashboard/)
expect_missing "the dashboard is past the gate with a session" "Sign in" "$dash"
expect_contains "and it is the dashboard" "id=\"app\"" "$dash"

# ---------------------------------------------------------------------------
say "R-SEC-10: the password is nowhere in the journal"

hits=$(grep -c "$PASSWORD" "$JOURNAL" || true)
expect "the password appears nowhere in what either service printed" 0 "$hits"

# ---------------------------------------------------------------------------
say "R-UI-12: capture every page, in both palettes, and look at them"

# The gate this repository did not have when 39% of the join warning shipped
# behind a scrollbar. Every check above this line passed on that build.
#
# It needs a browser, which is not something to assume on a development
# machine — so a missing playwright is a loud skip rather than a failure, and
# CI installs it so that there it is neither.
if node -e 'import("playwright")' >/dev/null 2>&1; then
    capture() {
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: every page captured, and none changed shape"
        else
            bad "the $1 palette: see the capture output above"
        fi
    }

    capture day

    # Night through the route an operator uses, not by writing the file: the
    # theme goes through the apply engine, so this also proves the palette a
    # page is captured in is one the device actually reached.
    theme_reply=$(sock_post /ui/theme '{"theme":"night"}')
    theme_id=$(printf '%s' "$theme_reply" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    if [ -n "$theme_id" ]; then
        sock_post /confirm "{\"id\":\"$theme_id\"}" >/dev/null
    fi

    i=0
    while [ "$i" -lt "$TRIES" ]; do
        grep -q -- '--yonder-theme: "night"' "$CONSOLE/public/theme.css" 2>/dev/null && break
        sleep "$POLL"; i=$((i + 1))
    done
    if grep -q -- '--yonder-theme: "night"' "$CONSOLE/public/theme.css" 2>/dev/null; then
        ok "the device reached the night palette through /ui/theme"
        capture night
    else
        bad "the console never regenerated theme.css as night, so night was not captured"
    fi

    # Back to the default, so a kept working directory is left as it was found.
    back=$(sock_post /ui/theme '{"theme":"day"}')
    back_id=$(printf '%s' "$back" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [ -n "$back_id" ] && sock_post /confirm "{\"id\":\"$back_id\"}" >/dev/null
else
    printf '  SKIP  no browser: the pages were not captured and nobody looked\n'
    printf '        npm install --save-dev playwright && npx playwright install --with-deps chromium\n'
fi

# ---------------------------------------------------------------------------
say "result"
printf '  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = "0" ] || exit 1
