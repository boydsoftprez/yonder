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
[ -f "$REPO/packages/node-red-contrib-yonder-modem/dist/state.js" ] \
    || die "the modem package is not built; run: npm run build"
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
# nmcli, reporting the board this project is built for: a wired port, the
# radio, and the modem's control port. It used to list only `lo` and `wlan0`,
# and the cost of that was invisible until the `Way out` panel existed — with
# no ethernet and no gsm device the daemon called every path absent, so the
# panel captured as three rows of "no interface on this board" and none of the
# three states R-UI-12 asks to see could be reached at all.
#
# No address is reported by `device show`, deliberately: nothing holds the
# default route, so `ReachWatch` finds no path in use and probes nothing on
# its own. Every probe in this run is one the gate asked for, which is what
# makes the three states below reproducible rather than a race with a timer.
cat > "$BIN/nmcli" <<'FAKE'
#!/bin/sh
case "$*" in
    *"device status"*)
        printf 'lo:loopback:connected:lo\n'
        printf 'eth0:ethernet:connected:Wired connection 1\n'
        printf 'wlan0:wifi:disconnected:\n'
        printf 'cdc-wdm0:gsm:connected:yonder-modem\n' ;;
    *"device wifi list"*)
        printf 'HomeNetwork:78:WPA2\nHomeNetwork:41:WPA2\nCafe:33:--\n' ;;
    *"connection show"*) : ;;
esac
exit 0
FAKE
# mmcli, replaying what a real EC25-AF on a live SIM answered. The fixtures are
# the ones yonder-core's own parser tests are written against, so the Cellular
# tab is captured showing what that board actually reported rather than a panel
# of em dashes — and a page captured with nothing on it is a page nobody has
# looked at, which is the failure R-UI-12 exists to prevent.
#
# It also answers a second board. `$MODEM_PRESENT` holds 1 or 0 and is read on
# every call, the way `$PROBE_ANSWER` below is: with 0 there are no modems and
# the daemon reports `mode: absent`, which is the board `Reachable by` on
# Status has to be captured on. That panel drops its two gauges entirely
# there — a gauge with no needle reads as a fault, and *there is no modem* is
# not a fault — so it is a second shape of the page and R-UI-12 asks for it.
MMCLI_FIXTURES="$REPO/packages/yonder-core/src/net/modem/mmcli/fixtures"
MODEM_PRESENT="$ROOT/modem-present"
echo 1 > "$MODEM_PRESENT"
cat > "$BIN/mmcli" <<FAKE
#!/bin/sh
F="$MMCLI_FIXTURES"
# A board with nothing in the slot. ModemManager prints the empty list rather
# than failing, and so does this.
if [ "\$(cat "$MODEM_PRESENT")" = "0" ]; then
    case "\$*" in
        *"-L"*) printf 'modem-list.length   : 0\n' ;;
    esac
    exit 0
fi
case "\$*" in
    *"-L"*)             cat "\$F/modem-list.txt" ;;
    *"--signal-get"*)   cat "\$F/signal-get.txt" ;;
    *"--signal-setup"*) : ;;
    # Two bearers, and the connected one is not the first. The network's own
    # initial bearer carries an APN nobody configured and is not connected;
    # reading it is the mistake connectedBearer() exists to avoid.
    *"-b "*Bearer/1*)   cat "\$F/bearer-connected.txt" ;;
    *"-b "*)            cat "\$F/bearer-initial.txt" ;;
    *"-m "*)            cat "\$F/modem-show.txt" ;;
esac
exit 0
FAKE

# curl, which is what `commandProbe` runs to find out whether a path carries
# traffic. It answers whatever `$PROBE_ANSWER` holds at the moment it is run —
# read on every call, never captured — so the gate can put the board's paths
# into each of the three states R-UI-12 asks to see them in.
#
# Only the daemon has $BIN on its PATH, so this is not the curl every check in
# this script uses to talk to the console.
PROBE_ANSWER="$ROOT/probe-answer"
echo 0 > "$PROBE_ANSWER"
cat > "$BIN/curl" <<FAKE
#!/bin/sh
exit \$(cat "$PROBE_ANSWER")
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
chmod +x "$BIN/systemctl" "$BIN/nmcli" "$BIN/mmcli" "$BIN/curl" "$BIN/rfkill" \
    "$BIN/hostnamectl" "$BIN/ping"

# The shipped defaults, with the console on this run's port and the modem
# turned on. `network.modem.enabled` is false by default and that is right for
# a board nobody has configured — but with it off `pathDevices` never names a
# modem, so the daemon reports the cellular path absent and neither the
# Cellular tab nor the `Way out` panel can be captured showing a modem at all.
# The mmcli stand-in above is already replaying a real EC25; this is what lets
# the pages see it.
#
# The range address is not decoration: `enabled: false` at that indent also
# appears under `remote.zerotier`, and a substitution without one turns the
# mesh on too — which would have this gate asking a `zerotier-cli` that does
# not exist on a development machine.
sed -e "s/^  port: .*/  port: $PORT/" \
    -e "/^  modem:/,/^  priority:/ s/^    enabled: false/    enabled: true/" \
    "$REPO/config/defaults/config.yaml" > "$ETC/config.yaml"
grep -q "port: $PORT" "$ETC/config.yaml" || die "could not set the console port in $ETC/config.yaml"
awk '/^  modem:/,/^  priority:/' "$ETC/config.yaml" | grep -q "enabled: true" \
    || die "the modem is not enabled in $ETC/config.yaml; the defaults must have moved"
awk '/^  zerotier:/,0' "$ETC/config.yaml" | grep -q "enabled: false" \
    || die "the mesh was turned on by accident; there is no zerotier-cli here"

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
for pkg in node-red-contrib-yonder-system node-red-contrib-yonder-network \
           node-red-contrib-yonder-remote node-red-contrib-yonder-modem \
           node-red-dashboard-2-yonder; do
    rm -f "$CONSOLE/node_modules/$pkg"
    ln -s "$REPO/packages/$pkg" "$CONSOLE/node_modules/$pkg"
done
rm -f "$CONSOLE/node_modules/yonder-core"
ln -s "$CORE" "$CONSOLE/node_modules/yonder-core"
# What 30-console.sh also does, and what the widgets do not appear without:
# Dashboard discovers a third-party widget package by reading the *user
# directory's* package.json for a dependency and resolving it beneath that
# directory. A package in the console tree's node_modules is where Node-RED
# finds the nodes and is invisible to that scan (K-28).
mkdir -p "$USERDIR/node_modules"
rm -f "$USERDIR/node_modules/node-red-dashboard-2-yonder"
ln -s "$REPO/packages/node-red-dashboard-2-yonder" \
      "$USERDIR/node_modules/node-red-dashboard-2-yonder"
cat > "$USERDIR/package.json" <<'MANIFEST'
{ "name": "yonder-console-state", "version": "0.0.0", "private": true,
  "dependencies": { "node-red-dashboard-2-yonder": "0.1.0" } }
MANIFEST
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

# yonder-confirm is named again, and that is what closed K-30.
#
# R-CFG-11 removed the operator confirmation of a *join* - joining takes the
# access point off the air, so the console you would confirm from goes with it
# - and the wiring that used this node went with it while the node stayed.
# R-UI-15 gave it a real caller: an apply that does not move the radio still
# goes through the engine's confirmation timer, and Status now carries the
# banner that shows one. `yonder-revert` is its twin, and `yonder-pending` is
# what reads the state both act on. Naming them here is the half of K-30 that
# stopped watching.
for type in yonder-status yonder-activity yonder-diag yonder-config yonder-scan yonder-apply \
            yonder-join yonder-pending yonder-confirm yonder-revert; do
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

    # The base captures are the *untested* state, and this is what makes that
    # a statement rather than an accident: nothing holds the default route in
    # this harness, so `ReachWatch` finds no path in use and probes nothing on
    # its own. Every path is up and nothing has established that any of them
    # reaches anything — the state R-CEL-09 is about, and the one a console
    # must not draw as ready.
    expect_contains "nothing has been probed, so the base captures are the untested state" \
        '"evidence":"untested"' "$(sock /reach/state)"

    capture day

    # Night through the route an operator uses, not by writing the file: the
    # theme goes through the apply engine, so this also proves the palette a
    # page is captured in is one the device actually reached.
    # Each palette through the route an operator uses, not by writing the
    # file: this also proves the palette a page is captured in is one the
    # device actually reached.
    wait_for_theme() {
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            grep -q -- "--yonder-theme: \"$1\"" "$CONSOLE/public/theme.css" 2>/dev/null && return 0
            sleep "$POLL"; i=$((i + 1))
        done
        return 1
    }

    reach_theme() {
        reply=$(sock_post /ui/theme "{\"theme\":\"$1\"}")
        id=$(printf '%s' "$reply" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
        [ -n "$id" ] && sock_post /confirm "{\"id\":\"$id\"}" >/dev/null
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            grep -q -- "--yonder-theme: \"$1\"" "$CONSOLE/public/theme.css" 2>/dev/null && return 0
            sleep "$POLL"; i=$((i + 1))
        done
        return 1
    }

    # Day is captured above, as the default the device boots into.
    #
    # Night is reached by **pressing the key**, not by posting to the socket.
    # The gate has to change palette anyway to photograph the second one, and
    # doing it through the control makes that the one end-to-end proof that
    # anything on this console does anything when pressed. Every soft key
    # shipped dead once — Dashboard drops a widget-action from a widget that
    # did not register onAction, silently — and no layout check could see it.
    node "$REPO/scripts/capture-pages.mjs" \
        --base-url "http://127.0.0.1:$PORT" --password "$PASSWORD" \
        --palette day --artifacts "$REPO/vendor/capture" \
        --press NIGHT >/dev/null 2>&1 || true

    if wait_for_theme night; then
        ok "pressing NIGHT on the rail actually reached the device"
    else
        bad "pressing NIGHT did nothing: the control is wired but dead"
    fi

    # One page, in one state, under a name of its own.
    #
    # R-UI-12: a surface that hides part of itself is captured in each of
    # those parts, and a panel drawn from live state hides its other states
    # exactly the way a tab hides its siblings. The `Way out` rows have three,
    # and they are three different *shapes* — the sentences are different
    # lengths and wrap differently, which is how the defect this gate is for
    # showed up in the first place: an interface name right-aligned in its own
    # column, visible only when the qualifier beneath it was the wider line.
    #
    # The state is driven through `POST /reach/test`, the daemon's own route
    # for R-CEL-09's "on request" and the one the TEST NOW key presses. Only
    # what the gate asks for is ever probed, so the states are reproducible.
    drive_paths() {
        printf '%s\n' "$1" > "$PROBE_ANSWER"
        for probe_path in ethernet modem wifi_client; do
            sock_post /reach/test "{\"path\":\"$probe_path\"}" >/dev/null
        done
        # One poll of `yonder-modem-state`, so the page is showing the answer
        # rather than the one before it. Dashboard replays the last message it
        # holds for a widget when a browser connects, so capturing early would
        # photograph the previous state under the new state's name.
        sleep 7
    }

    capture_state() {
        # $1 palette, $2 what curl answers, $3 the state that produces
        drive_paths "$2"
        expect_contains "every path this board has is now $3" \
            "\"evidence\":\"$3\"" "$(sock /reach/state)"
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only network-interfaces \
                --as "network-interfaces-$3" \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: the Way out rows with every path $3"
        else
            bad "the $1 palette: the Way out rows with every path $3, see above"
        fi
    }

    # Status's own second shape, and it is a different *board* rather than a
    # different reading. `Reachable by` is gauges over a labelled strip, and on
    # a board with no modem the gauges are absent and the panel is the strip
    # alone. Nothing draws an empty gauge there: a gauge with no needle reads
    # as a fault, and there being no modem is not one.
    #
    # Taken by the same `--only`/`--as` mechanism the Way out states use, so it
    # is held to exactly the rules and the shape reference every other page is.
    capture_status_without_modem() {
        echo 0 > "$MODEM_PRESENT"
        # One poll of `yonder-modem-state`, so the page is showing this board
        # and not the one before it.
        sleep 7
        expect_contains "the harness board has nothing in the modem slot" \
            '"mode":"absent"' "$(sock /modem/state)"
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only status \
                --as status-without-modem \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: Status on a board with no modem"
        else
            bad "the $1 palette: Status on a board with no modem, see above"
        fi
        # Put it back before anything else is captured: every other page in
        # this run describes a board that has one.
        echo 1 > "$MODEM_PRESENT"
        sleep 7
        expect_missing "the modem is back for the rest of the run" \
            '"mode":"absent"' "$(sock /modem/state)"
    }

    # Status's third shape, and the one the confirmation timer exists for
    # (R-UI-15, R-CFG-03). A change is applied and deliberately *not*
    # confirmed, so the banner is up with a real countdown on it — then the
    # gate presses `REVERT NOW` and asserts the device put the previous
    # configuration back.
    #
    # `system.hostname` is the change: it affects reachability, so the apply
    # goes pending rather than being kept (R-CFG-12); the hostname renderer
    # cannot fail an apply by design; and there is nothing else on any page
    # that draws it, so no other capture moves.
    #
    # The press is the point. A banner that renders correctly and whose keys
    # do nothing is the exact failure `--press NIGHT` was added for — every
    # soft key on every page shipped dead once, silently — and this is the
    # only end-to-end proof that either half of this panel reaches the device.
    capture_status_pending() {
        sock /config > "$ROOT/config.json"
        node -e '
            const config = require(process.argv[1]);
            config.system.hostname = "yonder-under-test";
            process.stdout.write(JSON.stringify(config));
        ' "$ROOT/config.json" > "$ROOT/pending.json"
        applied=$(curl -s -H 'content-type: application/json' --data @"$ROOT/pending.json" \
            --unix-socket "$SOCKET" http://localhost/apply)
        expect_contains "the apply went pending rather than being kept" '"expiresAt"' "$applied"
        expect_contains "and the daemon holds it, with a deadline" '"state":"pending"' "$(sock /status)"
        # One poll of `yonder-pending`, so the page is showing the change and
        # not the moment before it.
        sleep 3
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only status \
                --as status-pending \
                --artifacts "$REPO/vendor/capture" \
                --press "REVERT NOW" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: Status with a change pending, and REVERT NOW to press"
        else
            bad "the $1 palette: Status with a change pending, see above"
        fi
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            case "$(sock /status)" in *'"state":"idle"'*) break ;; esac
            sleep "$POLL"; i=$((i + 1))
        done
        expect_contains "pressing REVERT NOW rolled the change back" \
            '"outcome":"reverted"' "$(sock /status)"
        expect_contains "and the device is running the previous configuration" \
            '"hostname":"yonder"' "$(sock /config)"
        # One more poll, so the banner is down before anything else is
        # captured. Every other picture in this run is of a settled device.
        sleep 3
    }

    if reach_theme night; then
        ok "the device reached the night palette through /ui/theme"
        capture night
        # After the base capture, never before: a path that has been probed
        # has a record, and `untested` cannot be reached again without
        # restarting the daemon.
        capture_state night 1 not-reaching
        capture_state night 0 reaching
        capture_status_without_modem night
        capture_status_pending night
    else
        bad "the console never regenerated theme.css as night, so it was not captured"
    fi

    # Back to the default, so a kept run is left as it was found — and said
    # out loud, because `|| true` on a restore is how a HOLD=1 console sat in
    # the night palette while its own log claimed everything passed.
    if reach_theme day; then
        ok "the console was left in the default palette"
        capture_state day 1 not-reaching
        capture_state day 0 reaching
        capture_status_without_modem day
        capture_status_pending day
    else
        bad "the console is still in the night palette; a held run will be wrong"
    fi
else
    printf '  SKIP  no browser: the pages were not captured and nobody looked\n'
    printf '        npm install --save-dev playwright && npx playwright install --with-deps chromium\n'
fi

# ---------------------------------------------------------------------------
say "result"
printf '  %s passed, %s failed\n' "$pass" "$fail"

# HOLD=1 leaves the daemon and the console running so a browser can be pointed
# at them. The alternative, when a page renders blank, is reading framework
# source and guessing — which is slower and less honest than looking.
if [ "${HOLD:-0}" = "1" ]; then
    # The stop command, with the real pids in it.
    #
    # `pkill -f yonder-pages` looks like it would do this and does not: the
    # daemon's argv is the *repository* path, so only Node-RED matches and the
    # daemon is left running with its socket and its port. Three of them
    # accumulated that way, and the oldest was still answering on this port
    # with a build from before the palette changed — so a page that had been
    # rebuilt looked untouched, and the bug appeared to be in the theme.
    printf '\n  holding: http://127.0.0.1:%s/dashboard  (password: %s)\n' "$PORT" "$PASSWORD"
    printf '  root: %s\n' "$ROOT"
    printf '  stop:  ctrl-c, or: kill %s %s\n' "$DAEMON_PID" "$CONSOLE_PID"
    printf '%s %s\n' "$DAEMON_PID" "$CONSOLE_PID" > "$REPO/vendor/verify-pages.pids"
    while kill -0 "$CONSOLE_PID" 2>/dev/null; do sleep 1; done
fi

[ "$fail" = "0" ] || exit 1
