#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# End-to-end proof that the console spine fits together, on this machine, with
# no hardware.
#
# Everything below is covered by unit tests already — the gate, the client, the
# generated settings — and every one of those tests runs against a fake. This
# runs the real daemon, over a real Unix socket, behind a real Node-RED, and
# asks it questions with curl. It is what stands between "the parts are
# correct" and "the parts fit", and the two are not the same claim.
#
# What it does NOT prove: anything about systemd, about a board, about
# NetworkManager or about a radio. Those need hardware, and they are the
# separate boot test.
#
#     ./scripts/verify-console.sh
#
# Requires: a node new enough for Node-RED (22.9+), curl, and a console tree
# staged by installer/make-payload.sh. Everything it creates lives in one
# temporary directory and is removed on exit.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/.." && pwd)
CORE="$REPO/packages/yonder-core"
CONSOLE_TREE=${CONSOLE_TREE:-$REPO/vendor/console}
PORT=${PORT:-18880}

pass=0
fail=0

say()  { printf '\n== %s\n' "$*"; }
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is needed"
command -v node >/dev/null 2>&1 || die "node is needed"
[ -f "$CORE/dist/daemon/server.js" ] || die "no built daemon; run: npm run build"
[ -f "$CONSOLE_TREE/node_modules/node-red/red.js" ] \
    || die "no console tree at $CONSOLE_TREE; run: ./installer/make-payload.sh --arch linux-arm64"

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/yonder-e2e.XXXXXX")
ETC="$ROOT/etc/yonder"
RUN="$ROOT/run/yonder"
STATE="$ROOT/var/lib/yonder"
CONSOLE="$ROOT/opt/yonder/console"
USERDIR="$STATE/console"
SOCKET="$RUN/core.sock"
# One file for everything either service prints. The password must not be in
# it, and that is checked at the end.
JOURNAL="$ROOT/journal.log"

BIN="$ROOT/bin"
SYSTEMCTL_LOG="$ROOT/systemctl.log"

mkdir -p "$ETC" "$RUN" "$STATE" "$CONSOLE" "$USERDIR" "$BIN"
: > "$JOURNAL"
: > "$SYSTEMCTL_LOG"

# Stand-ins for the three things the daemon shells out to, none of which exists
# on a development machine. They are not there to make the daemon "work": they
# are there so the parts under test — the renderers, the gate, the socket — are
# reached at all, instead of the run stopping at the first missing binary.
#
# systemctl is the interesting one. It records what it was asked to restart,
# which is how this script can assert that setting a password made the daemon
# ask for the console to come back — the one piece of wiring that has no
# observable effect anywhere else.
cat > "$BIN/systemctl" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
FAKE
cat > "$BIN/nmcli" <<'FAKE'
#!/bin/sh
exit 0
FAKE
cat > "$BIN/rfkill" <<'FAKE'
#!/bin/sh
exit 0
FAKE
chmod +x "$BIN/systemctl" "$BIN/nmcli" "$BIN/rfkill"

# The console's port. Set in the configuration rather than by editing
# settings.js, because settings.js is generated: the daemon rewrites it from
# the configuration and any edit here would be undone the moment it did.
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

# The password used throughout. Distinctive on purpose: the last check greps
# the whole journal for it, and a password like "test" would match by accident.
PASSWORD='verify-console-Zx9Qw4Tm'
SHORT='abcd'

# ---------------------------------------------------------------------------
# The daemon, pointed entirely at the temporary root: its socket, its
# configuration, its secrets, and the console it renders.
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

start_console() {
    node "$CONSOLE_TREE/node_modules/node-red/red.js" -s "$CONSOLE/settings.js" \
        >>"$JOURNAL" 2>&1 &
    CONSOLE_PID=$!
}

stop_console() {
    [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null
    CONSOLE_PID=""
    # Poll for the port to be free rather than guessing at a delay: Node-RED
    # takes a second or two to let go of it, and a fixed sleep is either too
    # short on a loaded machine or wasted on an idle one.
    i=0
    while [ "$i" -lt "$TRIES" ]; do
        curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" || return 0
        sleep "$POLL"
        i=$((i + 1))
    done
    return 0
}

# Polling, not sleeping-and-hoping. 0.2 s a turn for at most 30 s: far longer
# than either service takes to come up, and it costs only what it needs.
POLL=0.2
TRIES=150

# The journal is the only place a failure to start says why, so it is printed
# rather than referred to. A script that says "see the log" about a file it is
# about to delete has told nobody anything.
give_up() {
    printf '\n--- %s ---\n' "$JOURNAL"
    cat "$JOURNAL" 2>/dev/null
    die "$1"
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

# curl helpers. `status <method> <path>` prints the HTTP status; `body` prints
# the body. Both go through the console's TCP port.
status() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "http://127.0.0.1:$PORT$2"; }
body()   { curl -s "http://127.0.0.1:$PORT$1"; }
sock_status() { curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCKET" "http://localhost$1"; }

expect() {
    what="$1"; want="$2"; got="$3"
    if [ "$want" = "$got" ]; then ok "$what ($got)"; else bad "$what: wanted $want, got $got"; fi
}

# `A && ok || bad` is a trap even when it happens to work: it runs the third
# branch whenever the second one fails too. One helper instead.
check() {
    ck_msg="$1"; shift
    if "$@"; then ok "$ck_msg"; else bad "$ck_msg"; fi
}

expect_contains() {
    what="$1"; needle="$2"; haystack="$3"
    case "$haystack" in
        *"$needle"*) ok "$what" ;;
        *) bad "$what: '$needle' is not in the reply" ;;
    esac
}

# ---------------------------------------------------------------------------
say "a daemon and a console from a clean root"
printf '  root: %s\n' "$ROOT"

start_daemon
wait_for_socket
ok "the daemon bound $SOCKET"

check "it generated settings.js" test -f "$CONSOLE/settings.js"
check "settings.js is in setup mode" grep -q "provisioned: false" "$CONSOLE/settings.js"
check "the flow editor is not mounted" grep -q "httpAdminRoot: false" "$CONSOLE/settings.js"
check "it took the port from the configuration" grep -q "uiPort: $PORT" "$CONSOLE/settings.js"
check "it restarted the console and nothing else" grep -qx "restart yonder-console.service" "$SYSTEMCTL_LOG"
if grep -q "yonder-core" "$SYSTEMCTL_LOG"; then
    bad "the console renderer touched yonder-core"
else
    ok "it never touched yonder-core"
fi

# The empty flows file setup mode runs on, seeded by 30-console.sh on a board.
printf '[]\n' > "$USERDIR/setup-flows.json"

# ---------------------------------------------------------------------------
say "setup mode: one page, and nothing else"

start_console
wait_for_console

expect "GET / is the setup page"            200 "$(status GET /)"
expect_contains "the setup page is the setup page" "Set an administrator password" "$(body /)"
expect_contains "it says the passphrase is published, not secret" "published default" "$(body /)"

for path in /editor /editor/ /dashboard /ui /config /status /settings /admin/verify /login /flows; do
    expect "GET $path is 404" 404 "$(status GET "$path")"
done

# ---------------------------------------------------------------------------
say "the socket refuses configuration while unprovisioned"

expect "GET /config on the socket is 403" 403 "$(sock_status /config)"
expect "GET /status on the socket still answers" 200 "$(sock_status /status)"

# ---------------------------------------------------------------------------
say "setting the password"

short_status=$(curl -s -o "$ROOT/short.html" -w '%{http_code}' \
    --data-urlencode "password=$SHORT" --data-urlencode "confirm=$SHORT" \
    "http://127.0.0.1:$PORT/setup")
expect "a 4-character password is refused" 400 "$short_status"
expect_contains "the refusal says the rule" "at least 8 characters" "$(cat "$ROOT/short.html")"
expect "and nothing was set" '{"provisioned":false}' \
    "$(curl -s --unix-socket "$SOCKET" http://localhost/console/state)"

good_status=$(curl -s -o "$ROOT/set.html" -w '%{http_code}' \
    --data-urlencode "password=$PASSWORD" --data-urlencode "confirm=$PASSWORD" \
    "http://127.0.0.1:$PORT/setup")
expect "a good password is accepted" 200 "$good_status"
expect_contains "the page says the console is restarting" "The password is set" "$(cat "$ROOT/set.html")"
expect "the daemon now says provisioned" '{"provisioned":true}' \
    "$(curl -s --unix-socket "$SOCKET" http://localhost/console/state)"

expect "a second attempt is refused" 409 \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
        --data '{"password":"another one entirely"}' \
        --unix-socket "$SOCKET" http://localhost/admin/password)"

# The daemon rewrites settings.js and asks for the console back, after a delay
# — the delay exists so the browser gets the "password is set" page before the
# process writing it is killed. Polled rather than assumed.
say "the daemon rewrites the console and asks for it back"
i=0
while [ "$i" -lt "$TRIES" ]; do
    grep -q "provisioned: true" "$CONSOLE/settings.js" && break
    sleep "$POLL"
    i=$((i + 1))
done
check "settings.js is now provisioned" grep -q "provisioned: true" "$CONSOLE/settings.js"
check "the flow editor is now mounted" grep -q 'httpAdminRoot: "/editor"' "$CONSOLE/settings.js"
check "it uses the real flows file" grep -q 'flowFile: "flows.json"' "$CONSOLE/settings.js"
expect "the console was asked to restart twice: once at start-up, once now" 2 \
    "$(grep -c "restart yonder-console.service" "$SYSTEMCTL_LOG")"
if grep -q "yonder-core" "$SYSTEMCTL_LOG"; then
    bad "the console renderer touched yonder-core"
else
    ok "and still never touched yonder-core"
fi

# ---------------------------------------------------------------------------
say "the socket opens once there is a password"

expect "GET /config on the socket is 200" 200 "$(sock_status /config)"

# ---------------------------------------------------------------------------
say "restarting the console into its provisioned shape"

# The half systemd does on a real board: the daemon has already rewritten
# settings.js and asked for a restart, and this is the restart.
stop_console
printf '[]\n' > "$USERDIR/flows.json"
start_console
wait_for_console

expect_contains "GET / is now a login page" "Sign in" "$(body /)"

wrong=$(curl -s -o /dev/null -w '%{http_code}' -c "$ROOT/wrong-cookies" \
    --data-urlencode "password=not-the-password" "http://127.0.0.1:$PORT/login")
expect "the wrong password fails" 401 "$wrong"
if grep -q yonder_session "$ROOT/wrong-cookies" 2>/dev/null; then
    bad "a failed sign-in set a session cookie"
else
    ok "a failed sign-in set no cookie"
fi

right=$(curl -s -o /dev/null -w '%{http_code}' -c "$ROOT/cookies" \
    --data-urlencode "password=$PASSWORD" "http://127.0.0.1:$PORT/login")
expect "the right password is accepted" 303 "$right"
if grep -q yonder_session "$ROOT/cookies"; then
    ok "it set a session cookie"
else
    bad "no session cookie was set"
fi
# curl's jar marks an HttpOnly cookie by prefixing its domain line. A token a
# script on the page could read is a token an injected script could steal.
check "the cookie is HttpOnly" grep -q '^#HttpOnly_.*yonder_session' "$ROOT/cookies"

# The dashboard is not built yet, so "behind the gate" is Node-RED's own 404
# rather than a page — the point is that it is no longer the login page.
with_session=$(curl -s -b "$ROOT/cookies" "http://127.0.0.1:$PORT/anything")
case "$with_session" in
    *"Sign in"*) bad "a signed-in request still gets the login page" ;;
    *) ok "a signed-in request goes past the gate" ;;
esac

# ---------------------------------------------------------------------------
say "the flow editor asks for credentials"

editor=$(status GET /editor/)
case "$editor" in
    200|401) ok "GET /editor/ is mounted and answers ($editor)" ;;
    *) bad "GET /editor/ answered $editor" ;;
esac
# The status a refusal carries is Node-RED's business — it answers 403 — so
# what is asserted is the thing that matters: no token comes back. A token is
# what opens the editor.
editor_wrong=$(curl -s \
    --data 'client_id=node-red-editor&grant_type=password&scope=*' \
    --data-urlencode 'username=admin' --data-urlencode 'password=not-the-password' \
    "http://127.0.0.1:$PORT/editor/auth/token")
case "$editor_wrong" in
    *access_token*) bad "the editor issued a token for the wrong password: $editor_wrong" ;;
    *) ok "the editor issues no token for the wrong password" ;;
esac

editor_right=$(curl -s \
    --data 'client_id=node-red-editor&grant_type=password&scope=*' \
    --data-urlencode 'username=admin' --data-urlencode "password=$PASSWORD" \
    "http://127.0.0.1:$PORT/editor/auth/token")
case "$editor_right" in
    *access_token*) ok "and issues one for the right password" ;;
    *) bad "the editor refused the right password: $editor_right" ;;
esac

# The same failing-closed property at the editor's door. Checked after the
# daemon is stopped, below, would need a second editor request; asserting the
# refusal shape here is enough, and the daemon-down case is covered for the
# console's own login.
editor_wrong_user=$(curl -s \
    --data 'client_id=node-red-editor&grant_type=password&scope=*' \
    --data-urlencode 'username=root' --data-urlencode "password=$PASSWORD" \
    "http://127.0.0.1:$PORT/editor/auth/token")
case "$editor_wrong_user" in
    *access_token*) bad "the editor issued a token for a username it does not know" ;;
    *) ok "and none for a username it does not know" ;;
esac

# ---------------------------------------------------------------------------
say "the console fails closed when the daemon is not there"

kill "$DAEMON_PID" 2>/dev/null
DAEMON_PID=""
i=0
while [ "$i" -lt "$TRIES" ]; do [ -S "$SOCKET" ] || break; sleep "$POLL"; i=$((i + 1)); done

down=$(curl -s -o /dev/null -w '%{http_code}' -c "$ROOT/down-cookies" \
    --data-urlencode "password=$PASSWORD" "http://127.0.0.1:$PORT/login")
expect "the right password fails while the daemon is down" 401 "$down"
if grep -q yonder_session "$ROOT/down-cookies" 2>/dev/null; then
    bad "a sign-in against a dead daemon set a session cookie"
else
    ok "and set no cookie"
fi

# ---------------------------------------------------------------------------
say "R-SEC-10: the password is nowhere in the journal"

printf '  grep -c %s %s\n' "$PASSWORD" "$JOURNAL"
hits=$(grep -c "$PASSWORD" "$JOURNAL" || true)
printf '  %s\n' "$hits"
expect "the password appears nowhere in what either service printed" 0 "$hits"
# The whole temporary root, not just the log: nothing may have written it to a
# file either. secrets.yaml holds a scrypt hash, which is the point.
files=$(grep -rl "$PASSWORD" "$ROOT" 2>/dev/null | grep -v cookies || true)
if [ -z "$files" ]; then
    ok "and in no file under the temporary root"
else
    bad "the password is in: $files"
fi
check "secrets.yaml holds a scrypt hash" grep -q 'admin_password: scrypt\$' "$ETC/secrets.yaml"

# ---------------------------------------------------------------------------
say "result"
printf '  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = "0" ] || exit 1
