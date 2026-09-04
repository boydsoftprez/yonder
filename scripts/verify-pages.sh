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
# The camera CI does not have.
#
# R-UI-03 builds navigation from detected hardware and R-UI-12 photographs
# every page on every build, so with no camera attached there is no camera page
# and this gate covers none of the camera work — without complaining, because
# from its point of view there is nothing there. So the daemon is started
# through scripts/synthetic-daemon.mjs with a capability set recorded off a
# Raspberry Pi 4, and the camera pages exist to be photographed.
CAMERAS=${CAMERAS:-$REPO/scripts/fixtures/camera-globalshutter.json}

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

# `etc/mediamtx` as well as `etc/yonder`: with a camera configured, the media
# renderer writes the media server's configuration on every apply, and a
# missing directory is not a media failure — it fails the *whole* apply, so the
# next theme change reports "the control is wired but dead". The installer's
# 50-mediamtx.sh makes this directory on a board; this is the harness's copy.
mkdir -p "$ETC" "$ROOT/etc/mediamtx" "$RUN" "$STATE" "$CONSOLE" "$USERDIR" "$BIN"
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
# Which board this run is describing: 1 with a modem in the slot, 0 without.
#
# It is read on every call by both `nmcli` and `mmcli` below, the way
# `$PROBE_ANSWER` is, because it names a *board* and not one command's answer.
# It used to be read only by `mmcli`, so with 0 the fixture set described a
# board that cannot exist: no modem, and a connected `cdc-wdm0` anyway.
# Unplugging a modem takes its control port away from NetworkManager too.
MODEM_PRESENT="$ROOT/modem-present"
echo 1 > "$MODEM_PRESENT"

# What NetworkManager says about the wired port, read on every call the way
# $MODEM_PRESENT is, so the gate can photograph a board with nothing plugged
# into it. `unavailable` is the word a real board reported for an eth0 with no
# carrier, and it is the state the `Way out` panel described as "Up, and not
# yet tested" until R-NET-14.
ETH_STATE="$ROOT/eth-state"
echo connected > "$ETH_STATE"

# How long `nmcli device show` takes to answer the *join check* — the one
# query that carries IP4.GATEWAY, which is `joinSucceeded` asking whether the
# radio landed anywhere (R-CFG-11).
#
# It exists so a radio-moving apply can be photographed while it is still
# pending. A join on this board never lands: nothing here issues an address,
# so the verifier polls until its 20-second grace runs out and then reverts —
# and 20 seconds is not long enough to start a browser, sign in, load a page
# and screenshot it twice. Holding the *first* poll open holds the pending
# state without touching production code and without pretending the join
# worked; a real board's DHCP taking its time is exactly what that poll is
# written for.
#
# 0 for every other capture in this run, so nothing else waits on it. Only
# this query is delayed: `device status`, `connection show` and the
# GENERAL.DEVICE,IP4.ADDRESS form of `device show` — which is the fallback
# watchdog's own probe — answer immediately as they always did.
JOIN_DELAY="$ROOT/join-delay"
echo 0 > "$JOIN_DELAY"

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
cat > "$BIN/nmcli" <<FAKE
#!/bin/sh
case "\$*" in
    # joinSucceeded's poll. See \$JOIN_DELAY above: it answers with nothing,
    # which is a radio that has not landed, after however long it is told to
    # take about it.
    *IP4.GATEWAY*)
        sleep "\$(cat "$JOIN_DELAY")" ;;
    *"device status"*)
        printf 'lo:loopback:connected:lo\n'
        printf 'eth0:ethernet:%s:Wired connection 1\n' "\$(cat "$ETH_STATE")"
        printf 'wlan0:wifi:disconnected:\n'
        # The control port goes with the modem. See \$MODEM_PRESENT above.
        [ "\$(cat "$MODEM_PRESENT")" = "1" ] \\
            && printf 'cdc-wdm0:gsm:connected:yonder-modem\n' ;;
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
# It also answers the second board. With `$MODEM_PRESENT` at 0 there are no
# modems and the daemon reports `mode: absent`, which is the board both
# `Reachable by` on Status and the whole Cellular tab have to be captured on.
# Each drops its two gauges entirely there — a gauge with no needle reads as a
# fault, and *there is no modem* is not a fault — so it is a second shape of
# each page and R-UI-12 asks for both.
MMCLI_FIXTURES="$REPO/packages/yonder-core/src/net/modem/mmcli/fixtures"
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

# The modem password this run puts on the device, and the one string that must
# never come back out of it (R-SEC-10).
#
# Distinctive on purpose, the way `$PASSWORD` is: the checks below grep the
# journal, the dashboard and every route the console serves for it, and a
# value like "secret" would match by accident. It goes into secrets.yaml
# because that is where a credential lives — config.yaml carries only the
# *name* of the row — and the Cellular tab's password box is the one field on
# this console that is deliberately never seeded from either.
MODEM_PASSWORD='verify-pages-modem-Jv7Hs2Bn'

# The access-point passphrase this run has the operator change it to, late in
# the run, and the second string that must never come back out of the device
# (R-SEC-10, R-UI-18).
#
# It is the *other* half of the one rule the way-back panel exists to get
# right. While the device is on the published default that value is printed on
# the page deliberately — ADR-0007 makes it public, and it is the only thing
# that makes a locked-out operator's way back in usable at all. The moment the
# operator sets their own it becomes a credential like any other, and the
# panel says it has been changed rather than showing it. Both halves are
# captured below, and this string is what proves the second one.
AP_PASSPHRASE='verify-pages-ap-Tq9Lm3Vx'

# The shipped defaults, with the console on this run's port and the modem
# turned on and configured. `network.modem.enabled` is false by default and
# that is right for a board nobody has configured — but with it off
# `pathDevices` never names a modem, so the daemon reports the cellular path
# absent and neither the Cellular tab nor the `Way out` panel can be captured
# showing a modem at all. The mmcli stand-in above is already replaying a real
# EC25; this is what lets the pages see it.
#
# **The rest of the modem block is configured because R-UI-17 made it visible.**
# The Cellular tab's four boxes are seeded from `network.modem`, so a capture
# taken against `apn: null` would photograph the defect it was taken to prove
# fixed. `apn` is the value the bearer fixture is dialled on, which is the
# ordinary state of a working device: the form and the fact cell above it agree.
# `dial` is deliberately left unset — an empty box beside two filled ones is
# what "not configured" has to look like, and it is the honest value besides
# (R-CEL-02 asks for the field; no modem measured has needed it). `password` is
# a reference into secrets.yaml, so the box can be photographed saying a
# credential is on file without one ever reaching a page.
#
# awk rather than another `sed -e`, because the password substitution turns one
# line into two and `\n` in a replacement is a GNU extension this script cannot
# rely on — it runs on macOS and on a CI runner.
#
# The range is not decoration: `enabled: false` at that indent also appears
# under `remote.zerotier`, and a substitution without one turns the mesh on too
# — which would have this gate asking a `zerotier-cli` that does not exist on a
# development machine.
sed -e "s/^  port: .*/  port: $PORT/" "$REPO/config/defaults/config.yaml" \
  | awk '
      /^  modem:/    { modem = 1 }
      /^  priority:/ { modem = 0 }
      modem && /^    enabled:/  { print "    enabled: true";      next }
      modem && /^    apn:/      { print "    apn: ereseller";     next }
      modem && /^    username:/ { print "    username: sim-user"; next }
      modem && /^    password:/ { print "    password:"; print "      secret: modem_password"; next }
      { print }
    ' > "$ETC/config.yaml"
grep -q "port: $PORT" "$ETC/config.yaml" || die "could not set the console port in $ETC/config.yaml"
modem_block=$(awk '/^  modem:/,/^  priority:/' "$ETC/config.yaml")
for setting in "enabled: true" "apn: ereseller" "username: sim-user" "secret: modem_password"; do
    case "$modem_block" in
        *"$setting"*) ;;
        *) die "the modem block in $ETC/config.yaml has no '$setting'; the defaults must have moved" ;;
    esac
done
case "$modem_block" in
    *"dial: null"*) ;;
    *) die "the modem's dial is no longer unset; the empty box in the capture is not empty" ;;
esac
awk '/^  zerotier:/,0' "$ETC/config.yaml" | grep -q "enabled: false" \
    || die "the mesh was turned on by accident; there is no zerotier-cli here"

# The credential the reference above names. Written before the daemon starts,
# because the renderer resolves `network.modem.password` when it builds the
# gsm profile and a reference to a row that is not there fails the first apply.
# The store adds `ap_psk` to this file itself on the way past.
umask 077
printf 'modem_password: %s\n' "$MODEM_PASSWORD" > "$ETC/secrets.yaml"
umask 022

# The fixture's camera, into the configuration the daemon loads. Written by the
# schema's own serialiser rather than by appending YAML here, so a schema change
# breaks this loudly instead of producing a document that parses and means
# something else.
[ -f "$CAMERAS" ] || die "no camera fixture at $CAMERAS"
CONFIG_PATH="$ETC/config.yaml" FIXTURE_PATH="$CAMERAS" REPO_PATH="$REPO" node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const { parse, stringify } = require(process.env.REPO_PATH + "/node_modules/yaml");
const path = process.env.CONFIG_PATH;
const config = parse(readFileSync(path, "utf8"));
config.cameras = [JSON.parse(readFileSync(process.env.FIXTURE_PATH, "utf8")).camera];
writeFileSync(path, stringify(config));
' || die "could not put the fixture's camera into $ETC/config.yaml"
grep -q "^cameras:" "$ETC/config.yaml" || die "the fixture's camera did not reach $ETC/config.yaml"

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
    YONDER_CAMERAS_FIXTURE="$CAMERAS" \
    YONDER_MEDIA_CONFIG="$ROOT/etc/mediamtx/mediamtx.yml" \
    PATH="$BIN:$PATH" \
        node "$REPO/scripts/synthetic-daemon.mjs" >>"$JOURNAL" 2>&1 &
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

expect_contains "GET /cameras finds the fixture's camera" '"card":"Global Shutter Camera' "$(sock /cameras)"
expect_contains "and says whether its identity survives a reboot" 'survives a reboot' "$(sock /cameras)"
expect_contains "and reports what was rejected, with a reason"    '"reason"' "$(sock /cameras)"
expect_contains "GET /cameras/front reads the device, not a form" '"capabilities"' "$(sock /cameras/front)"
expect_contains "and states what this camera cannot do"           '"facts"' "$(sock /cameras/front)"

# A camera in the configuration means the media server has one too, before
# anything tries to publish to it: mediamtx started with no paths accepts none,
# and a pipeline publishing to it dies with 400 Bad Request.
check "the media server's configuration was written for it" \
    test -f "$ROOT/etc/mediamtx/mediamtx.yml"
expect_contains "with a path for the picture the browser watches" \
    "front-preview" "$(cat "$ROOT/etc/mediamtx/mediamtx.yml" 2>/dev/null)"
# Asserted before it is used: a check against an empty needle matches
# everything, so a secrets.yaml with no RTSP password would turn the two lines
# below into a guard that always passes.
check "the device generated its own RTSP credential" \
    grep -q '^rtsp_password:' "$ETC/secrets.yaml"
RTSP_SECRET=$(sed -n 's/^rtsp_password: //p' "$ETC/secrets.yaml" 2>/dev/null | tr -d '"')
expect_missing "and it is in nothing either service printed" "$RTSP_SECRET" "$(cat "$JOURNAL")"

# R-CFG-12 against R-CFG-03, on the two kinds of camera setting. This is what
# the Setup deck's countdown is drawn from, so it is asserted here rather than
# inferred from the page.
kept=$(sock_post /cameras/front/settings '{"framerate":25}')
expect_contains "a picture setting is kept, with nothing to confirm" '"expiresAt":null' "$kept"
armed=$(sock_post /cameras/front/settings '{"bitrate_kbps":2500}')
expect_missing "a bitrate change arms the confirmation window" '"expiresAt":null' "$armed"
# Confirmed, and then put back and confirmed again — an apply left pending
# blocks every apply behind it, including the theme change the capture gate
# makes to reach the second palette. That is not hypothetical: it is how this
# script first reported "pressing NIGHT did nothing: the control is wired but
# dead", and the control was fine.
confirm_apply() {
    id=$(printf '%s' "$1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [ -n "$id" ] && sock_post /confirm "{\"id\":\"$id\"}" >/dev/null
}
confirm_apply "$armed"
confirm_apply "$(sock_post /cameras/front/settings '{"bitrate_kbps":2000,"framerate":30}')"
expect_contains "and the document really changed, not only the answer" \
    '"bitrate_kbps":2000' "$(sock /config)"


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
           node-red-contrib-yonder-video node-red-dashboard-2-yonder; do
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
# It removed nothing from R-CFG-03, and two callers have put the node back.
# R-UI-15 gave it one: an apply that does not move the radio still goes
# through the engine's confirmation timer, and Status now carries the banner
# that shows one. `yonder-revert` is its twin, and `yonder-pending` is what
# reads the state both act on. The camera page gave it the other: a camera's
# bitrate is spend on the path the console is standing on, nobody has measured
# what a saturated uplink does to a console session, and that apply arms a
# window somebody has to confirm. Naming them all here is the half of K-30
# that stopped watching.
for type in yonder-status yonder-activity yonder-diag yonder-config yonder-scan \
            yonder-apply yonder-join yonder-pending yonder-confirm yonder-revert \
            yonder-cameras yonder-camera yonder-stream yonder-receive-line; do
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
say "R-SEC-10: the modem's credential never comes back off the device"

# The half a unit test cannot make. `modemForm` is asserted not to seed the
# password, and this is the same claim made against a running daemon, a running
# console and a configuration that really does have a credential in it — the
# one arrangement in which a leak could actually happen.
expect "the modem password is nowhere in what either service printed" 0 \
    "$(grep -c "$MODEM_PASSWORD" "$JOURNAL" || true)"
expect_missing "and nowhere in the configuration the console is served" \
    "$MODEM_PASSWORD" "$(sock /config)"
expect_missing "nor in the modem state every surface is drawn from" \
    "$MODEM_PASSWORD" "$(sock /modem/state)"

# **Not `$dash`.** That is the Dashboard SPA shell — `index.html`, asserted
# above to contain `id="app"` — and every widget value arrives afterwards over
# socket.io. Grepping it for a credential could not fail for the only way one
# would get there, which is a value rendered into a widget.
#
# `_debug/datastore/<widget id>` is that value: exactly what Dashboard replays
# to a browser when it connects, behind the same login. The password box is
# the widget on this console that would carry the credential if anything did —
# `modemForm` sends it a label and deliberately no payload — so this is the
# check the shell grep was pretending to be.
# The label goes to Dashboard's *state* store and the value to its data store,
# and both are asked here — the label because it proves this check is live
# (`modemForm` really did reach that widget), the value because "there is
# nothing there" is the claim R-SEC-10 needs and an assertion that cannot fail
# is not one.
# The one check in this section that has to wait for something: the boxes are
# seeded by an `inject` a second after deploy and a round trip to the daemon,
# and this used to race it.
i=0
seeded=""
while [ "$i" -lt "$TRIES" ]; do
    seeded=$(body "/dashboard/_debug/statestore/input-cell-password")
    case "$seeded" in *"leave blank to keep it"*) break ;; esac
    sleep "$POLL"; i=$((i + 1))
done
expect_contains "the password box is told a credential is on file" \
    "leave blank to keep it" "$seeded"
expect_missing "and is never told the credential" "$MODEM_PASSWORD" "$seeded"
stored=$(body "/dashboard/_debug/datastore/input-cell-password")
expect_missing "and has no value at all for Dashboard to replay into it" \
    '"payload"' "$stored"
expect_missing "nor the credential in what it would replay" "$MODEM_PASSWORD" "$stored"

# What `GET /config` *does* carry is the name of the row, not the row. Stated
# as an assertion rather than left implicit, because it is the thing the seed
# node is handed and deliberately does not pass on: if this ever stops being
# true the leak has moved upstream of anything the console can prevent.
expect_contains "the configuration names the secret and does not contain it" \
    '"secret":"modem_password"' "$(sock /config)"

# Every file either service wrote, not only the log. secrets.yaml is the one
# place it belongs, and mode 0600 is what makes that acceptable.
leaked=$(grep -rl "$MODEM_PASSWORD" "$ROOT" 2>/dev/null | grep -v "etc/yonder/secrets.yaml" || true)
if [ -z "$leaked" ]; then
    ok "and in no file under the temporary root but secrets.yaml"
else
    bad "the modem password is in: $leaked"
fi

# ---------------------------------------------------------------------------
say "R-UI-18: the way back in, while the access point is on the published default"

# The half of the rule that is about *printing* the value, and it is the
# unusual direction: this is a passphrase the device is supposed to hand out.
# ADR-0007 makes it public because a per-device one could only be read from the
# device you are locked out of, so it guarded nothing and locked out the
# legitimate operator. Withholding it here would be as much of a defect as
# leaking a changed one.
back=$(sock /status)
expect_contains "the panel names the access point"  '"ssid":"yonder"' "$back"
expect_contains "and its address, without the prefix length" '"address":"192.168.77.1"' "$back"
expect_contains "and the name it answers to" '"hostname":"yonder.local"' "$back"
expect_contains "and prints the published passphrase" '"passphrase":"yonder1234"' "$back"

# The boundary this route keeps. /status is deliberately in front of the
# administrator-password gate, and `wayBackIn` is the only configuration it
# carries: three facts that are beaconed, handed out by DHCP and announced
# over mDNS anyway. Nothing else out of config.yaml may follow them here.
expect_missing "and carries no other configuration onto an ungated route" \
    "ereseller" "$back"
expect_missing "nor any reference to a stored credential" '"secret"' "$back"

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
                --synthetic-cameras "$CAMERAS" \
                --secrets "$ETC/secrets.yaml" \
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
    # exactly the way a tab hides its siblings. The `Way out` rows have four —
    # three of them driven here by probing, and the fourth by taking the wired
    # port down; see capture_unplugged below.
    #
    # What separates them is the **sentence**, not the geometry. Each row
    # wears `yonder-fixed`, so the words are visible in the committed picture
    # and recorded in the shape manifest; without it the four states were
    # three grey rectangles apiece and four byte-identical references. The
    # defect this gate was written after — an interface name right-aligned in
    # its own column, visible only when the qualifier beneath it was the wider
    # line — is in the same two elements, and was behind the mask too.
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

    # The second shape of the two pages that draw a modem, and it is a
    # different *board* rather than a different reading. Both draw signal as
    # gauges, and on a board with no modem both drop them entirely: a gauge
    # with no needle reads as a fault, and there being no modem is not one.
    #
    # **Both pages, in one flip.** The Cellular tab shipped drawing two empty
    # gauge tracks on this board — the defect was found in a browser and not
    # here, because Status was the only page this state was ever captured on.
    # A page that hides part of itself is captured in each of those parts
    # (R-UI-12), and the tab hides its gauges exactly the way the panel does.
    # It also happens to be the only board on which `COMPOSITION` has nothing
    # to say, which is the other thing worth a picture.
    #
    # Taken by the same `--only`/`--as` mechanism the Way out states use, so
    # each is held to exactly the rules and the shape reference every other
    # page is.
    capture_without_modem() {
        echo 0 > "$MODEM_PRESENT"
        # One poll of `yonder-modem-state`, so the pages are showing this board
        # and not the one before it.
        sleep 7
        expect_contains "the harness board has nothing in the modem slot" \
            '"mode":"absent"' "$(sock /modem/state)"
        # The lamp reads NO MODEM. `/reach/state` reports the cellular path as
        # absent once ModemManager says there is no modem to read (R-CEL-13,
        # K-41), so these two pictures are the board they claim to be.
        for without in status:status network-cellular:network-cellular; do
            if node "$REPO/scripts/capture-pages.mjs" \
                    --base-url "http://127.0.0.1:$PORT" \
                    --password "$PASSWORD" \
                    --palette "$1" \
                    --only "${without%%:*}" \
                    --as "${without#*:}-without-modem" \
                    --artifacts "$REPO/vendor/capture" \
                    ${ACCEPT_SHAPE:+--accept}; then
                ok "the $1 palette: ${without#*:} on a board with no modem"
            else
                bad "the $1 palette: ${without#*:} on a board with no modem, see above"
            fi
        done
        # Put it back before anything else is captured: every other page in
        # this run describes a board that has one.
        echo 1 > "$MODEM_PRESENT"
        sleep 7
        expect_missing "the modem is back for the rest of the run" \
            '"mode":"absent"' "$(sock /modem/state)"
    }

    # The `Way out` panel's fourth row shape: a wired port with nothing
    # plugged into it (R-NET-14, R-UI-12).
    #
    # This is the state an operator found on a real board, where the panel
    # said "Up, and not yet tested — nothing has established that it reaches
    # anything" about an eth0 NetworkManager had in `unavailable` with no
    # carrier and no address. The sentence asserted a condition the daemon had
    # not established, and the condition was in the device list it had already
    # read.
    #
    # **It is a different sentence and not a different geometry**, which is
    # what the reference used to claim. Nothing moves: an annunciator is
    # `inline-flex` inside a grid-fixed wrapper and the qualifier wraps to one
    # line in every state. The words are the difference, so the row wears
    # `yonder-fixed` — which both unmasks it in the committed picture and puts
    # its text in the shape manifest, where a regression in the sentence
    # R-NET-14 was written for now fails the gate.
    capture_unplugged() {
        echo unavailable > "$ETH_STATE"
        # One poll of `yonder-modem-state`, so the panel is showing this board
        # and not the one before it.
        sleep 7
        expect_contains "the wired port reports itself down, not up and untested" \
            '"standing":"down"' "$(sock /reach/state)"
        expect_missing "and nothing on this board claims to be up" \
            "Up, and not yet tested" "$(sock /reach/state)"
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only network-interfaces \
                --as network-interfaces-down \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: the Way out rows with the wired port unplugged"
        else
            bad "the $1 palette: the Way out rows with the wired port unplugged, see above"
        fi
        # Plug it back in before anything else is captured: every other page in
        # this run describes a board whose wired port is up.
        echo connected > "$ETH_STATE"
        sleep 7
        expect_missing "the wired port is back for the rest of the run" \
            '"standing":"down"' "$(sock /reach/state)"
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
        # One poll of the *slowest* thing on this page, so every panel is
        # showing the change and not the moment before it. `yonder-pending`
        # runs at 2 s; `yonder-wayback` runs at 5, and it draws the hostname —
        # which this change moves. Three seconds photographed the banner up
        # and the way back in still naming the old name, in one palette and
        # not the other, so the committed picture depended on where a timer
        # happened to fall.
        sleep 7
        # What Dashboard would replay into the soft-key rail — the same read
        # the credential checks above use, and for the same reason: the SPA
        # shell carries no widget value, and a picture proves the keys were
        # drawn but not what decided them. An ordinary change is the
        # operator's to keep, so both keys are on the rail (R-UI-15).
        rail=$(body "/dashboard/_debug/datastore/keys-pending")
        expect_contains "the rail is offered CONFIRM for a change the operator can confirm" \
            '"action":"confirm"' "$rail"
        expect_contains "and REVERT NOW beside it" '"action":"revert"' "$rail"
        # **And the message stopped there.** The rail's output goes to the node
        # that re-reads `/status` and feeds the rail, so a widget that
        # forwarded its input would turn one poll into an endless loop of
        # them. `ui-yonder-softkeys` declares `passthru: false` to stop that,
        # and this is the observable: a message that went round would arrive
        # back with `tag-pending-key` having set `topic` to the whole payload
        # *object*, where a press sets it to the action string.
        expect_missing "and stopped there rather than going round the rail again" \
            '"topic":{' "$rail"
        # **The banner on a tab, which is the half that was missing** (R-UI-15).
        # A `ui-group` belongs to one page and Dashboard's tabs layout draws
        # one group per tab, so the four widgets live inside each tab instead
        # and are raised by id. Nothing but a picture says whether that
        # actually happens, and the Cellular tab is the one the requirement
        # was failing on: an operator who fixed an APN there, watched the
        # modem redial and stayed put had no countdown and no key to press.
        #
        # Before the press below, which is what ends the pending state.
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only network-cellular \
                --as network-cellular-pending \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: the Cellular tab with the same change pending on it"
        else
            bad "the $1 palette: the Cellular tab with a change pending, see above"
        fi
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
        # One more poll of the slowest panel, so the banner is down *and* the
        # way back in has the reverted hostname before anything else is
        # captured. Every other picture in this run is of a settled device.
        sleep 7
    }

    # Status's fifth shape, and the one with a decision in it (R-CFG-11).
    #
    # The same banner over a change that moved the Wi-Fi radio. **It offers no
    # `CONFIRM`**, because that confirmation is the device's: the console an
    # operator would press it from goes off the air with the access point, so
    # a press either does nothing useful or is made by somebody who cannot see
    # that the device is already fine — and it ends the device's own check
    # early. The countdown is still there, the prose says who is confirming,
    # and `REVERT NOW` is still there because deciding you do not want the
    # change is still a real thing to want.
    #
    # Two things make this capturable at all. The join never lands on this
    # board — nothing here issues an address — so `$JOIN_DELAY` holds the
    # verifier's first poll open rather than letting its 20-second grace run
    # out mid-screenshot. And the press at the end is the proof that matters:
    # `REVERT NOW` is the operator's only remaining control over this apply,
    # so a picture of it that nobody pressed would be a picture of a key that
    # might be dead.
    capture_pending_radio() {
        echo 90 > "$JOIN_DELAY"
        sock /config > "$ROOT/config.json"
        node -e '
            const config = require(process.argv[1]);
            config.network.client.ssid = "HomeNetwork";
            process.stdout.write(JSON.stringify(config));
        ' "$ROOT/config.json" > "$ROOT/joining.json"
        joined=$(curl -s -H 'content-type: application/json' --data @"$ROOT/joining.json" \
            --unix-socket "$SOCKET" http://localhost/apply)
        expect_contains "the join went pending, on the longer window" '"movesRadio":true' "$joined"
        pending_status=$(sock /status)
        expect_contains "and GET /status says the pending change moved the radio" \
            '"movesRadio":true' "$pending_status"
        expect_contains "with the change still in force while the device checks" \
            '"state":"pending"' "$pending_status"
        sleep 7
        # **The decision, read where the browser reads it.** The rail's keys
        # are computed by `pendingChange()` in yonder-core and travel on the
        # same payload as the countdown; this is what Dashboard replays into
        # the widget. A picture shows one key rather than two — this says
        # *which* key, and that the other one is not merely off screen.
        rail=$(body "/dashboard/_debug/datastore/keys-pending")
        expect_contains "the rail still offers REVERT NOW for a radio move" \
            '"action":"revert"' "$rail"
        expect_missing "and offers no CONFIRM, because the device is confirming" \
            '"action":"confirm"' "$rail"
        expect_contains "and the words say who is confirming" \
            "confirming it for itself" "$(body "/dashboard/_debug/datastore/text-pending-what")"
        expect_missing "with the message stopping at the rail, as above" '"topic":{' "$rail"
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only status \
                --as status-pending-radio \
                --artifacts "$REPO/vendor/capture" \
                --press "REVERT NOW" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: Status with a radio move pending, and only REVERT NOW to press"
        else
            bad "the $1 palette: Status with a radio move pending, see above"
        fi
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            case "$(sock /status)" in *'"state":"idle"'*) break ;; esac
            sleep "$POLL"; i=$((i + 1))
        done
        # **The point of the press.** `REVERT NOW` is the only control this
        # banner still offers, so a rail that drew it and could not act on it
        # would be worse than the confirm control it replaced.
        expect_contains "pressing REVERT NOW undid the radio move" \
            '"outcome":"reverted"' "$(sock /status)"
        expect_contains "and the device is back on its access point" \
            '"ssid":null' "$(sock /config)"
        # The verifier's poll is still asleep and will answer into a state
        # that is no longer pending, where the engine ignores it. Let go of it
        # for the rest of the run.
        echo 0 > "$JOIN_DELAY"
        sleep 7
    }

    # ---- the way back in, once the operator has set their own -------------
    #
    # **There is no route that changes the access-point passphrase.**
    # ADR-0007 asks the console to notice the default and offer to change it,
    # and nothing has built that yet — so this does what an operator would
    # have to do today: stop the daemon, edit `secrets.yaml`, start it again.
    # `SecretStore` reads that file once, in its constructor, so a change
    # while the daemon is up would not be seen.
    #
    # A restart is a bigger hammer than any other state in this gate reaches
    # for, and it is the honest one. The alternative — a second daemon on a
    # second socket — would photograph a console that is not the console.
    change_ap_passphrase() {
        kill "$DAEMON_PID" 2>/dev/null || true
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            kill -0 "$DAEMON_PID" 2>/dev/null || break
            sleep "$POLL"; i=$((i + 1))
        done
        umask 077
        sed "s/^ap_psk: .*/ap_psk: $AP_PASSPHRASE/" "$ETC/secrets.yaml" > "$ETC/secrets.next"
        mv "$ETC/secrets.next" "$ETC/secrets.yaml"
        umask 022
        grep -q "^ap_psk: $AP_PASSPHRASE$" "$ETC/secrets.yaml" \
            || die "the ap_psk row is not where this expected it; the store's format has moved"
        start_daemon
        wait_for_socket
        # Long enough for every poller on Status to have asked again after the
        # socket came back. Without it the page would be photographed still
        # showing the answer from before the restart — which is the published
        # passphrase, under the name of the state that does not print one.
        sleep 8
    }

    capture_psk_changed() {
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only status \
                --as status-psk-changed \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: Status with a passphrase the operator set"
        else
            bad "the $1 palette: Status with a passphrase the operator set, see above"
        fi
    }

    if reach_theme night; then
        ok "the device reached the night palette through /ui/theme"
        capture night
        # After the base capture, never before: a path that has been probed
        # has a record, and `untested` cannot be reached again without
        # restarting the daemon.
        capture_state night 1 not-reaching
        capture_state night 0 reaching
        capture_without_modem night
        capture_unplugged night
        capture_status_pending night
        capture_pending_radio night
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
        capture_without_modem day
        capture_unplugged day
        capture_status_pending day
        capture_pending_radio day
    else
        bad "the console is still in the night palette; a held run will be wrong"
    fi

    # ---------------------------------------------------------------------
    # Status's fourth shape, and the one with the credential rule in it
    # (R-UI-18, R-SEC-10).
    #
    # This is the state nobody would look at again. Everything above was
    # photographed with the access point on its published passphrase, which is
    # the state the panel *prints* a value in; this is the other one, and it
    # is the one where getting it wrong is a credential leak rather than a
    # missing convenience. Last in the run, because a daemon restart is what
    # reaches it and every other picture describes the device before that.
    say "R-UI-18: the way back in, once the operator has set their own passphrase"

    change_ap_passphrase
    changed=$(sock /status)
    expect_contains "the panel still names the access point" '"ssid":"yonder"' "$changed"
    expect_contains "and says there is no passphrase to print" '"passphrase":null' "$changed"
    expect_missing  "the published default is no longer offered" \
        '"passphrase":"yonder1234"' "$changed"
    expect_missing  "and the passphrase the operator set is not in the answer" \
        "$AP_PASSPHRASE" "$changed"

    # The same claim as the modem credential's, against the other secret this
    # device holds. A unit test can assert a pure function; this is a running
    # daemon, a running console, and a real value in a real secrets.yaml.
    expect "the operator's passphrase is nowhere in what either service printed" 0 \
        "$(grep -c "$AP_PASSPHRASE" "$JOURNAL" || true)"
    expect_missing "nor in the configuration the console is served" \
        "$AP_PASSPHRASE" "$(sock /config)"
    expect_contains "which names the row and does not contain it" \
        '"secret":"ap_psk"' "$(sock /config)"
    # The widget that draws it, not the SPA shell — see the note on the modem
    # password above. `bar-wayback` is where an access-point passphrase would
    # appear if `publishableApPassphrase` ever handed back what it read.
    wayback=$(body "/dashboard/_debug/datastore/bar-wayback")
    expect_contains "the way-back panel really is drawing something" \
        "passphrase" "$wayback"
    expect_missing "and the operator's passphrase is not in what it draws" \
        "$AP_PASSPHRASE" "$wayback"
    leaked=$(grep -rl "$AP_PASSPHRASE" "$ROOT" 2>/dev/null \
        | grep -v "etc/yonder/secrets.yaml" || true)
    if [ -z "$leaked" ]; then
        ok "and in no file under the temporary root but secrets.yaml"
    else
        bad "the operator's access-point passphrase is in: $leaked"
    fi

    capture_psk_changed day
    if reach_theme night; then
        capture_psk_changed night
        if reach_theme day; then
            ok "the console was left in the default palette"
        else
            bad "the console is still in the night palette; a held run will be wrong"
        fi
    else
        bad "the console never reached the night palette for the changed-passphrase capture"
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
