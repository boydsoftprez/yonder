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
# Since R-UI-23 every reading in those captures is its **widest honest value**
# (scripts/fixtures/specimens.json) rather than a grey box, so the pictures show
# what each page does with the longest value its fields can carry — and the
# camera pages are captured again at the two widths spec §5 writes a viewport
# contract for, with the viewport photographed separately from the full page.
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
# through scripts/pages-daemon.mjs with a capability set recorded off a
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
[ -f "$REPO/packages/node-red-contrib-yonder-mavlink/dist/state.js" ] \
    || die "the mavlink package is not built; run: npm run build"
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
# Where `mavlink-router` stands, as far as anything on this device can tell.
#
# Every other unit this daemon touches is fire-and-forget, and the stand-in
# used to exit 0 for all of them — including `is-active`, which made the
# telemetry renderer believe a router was already holding the serial port
# before one had ever been started. It then declined to sweep (adopting a
# link it could not read is the one thing that would take a port off a
# working router), so the Telemetry page could never be captured with
# anything on it. Only `mavlink-router` is tracked, because it is the only
# unit anything here asks a question about.
ROUTER_STATE="$ROOT/router-state"
echo inactive > "$ROUTER_STATE"
# What the router prints to its journal once a second with `ReportStats =
# true`, written by the router stand-in in scripts/pages-daemon.mjs and read
# back through `journalctl` — the path the renderer actually uses.
ROUTER_STATS="$ROOT/router-stats"
: > "$ROUTER_STATS"
# What is on the other end of the serial port for this part of the run:
# `linked`, `silent` or `noise` — R-MAV-13's three answers, and three of the
# six states the Telemetry page has to be captured in. Read on every open,
# never captured, the way $PROBE_ANSWER is.
MAV_MODE="$ROOT/mav-mode"
echo linked > "$MAV_MODE"

cat > "$BIN/systemctl" <<FAKE
#!/bin/sh
printf '%s\n' "\$*" >> "\$SYSTEMCTL_LOG"
case "\$*" in
    *mavlink-router*)
        case "\$1" in
            is-active)      [ "\$(cat "$ROUTER_STATE")" = active ] || exit 3 ;;
            start|restart)  echo active   > "$ROUTER_STATE" ;;
            stop)           echo inactive > "$ROUTER_STATE" ;;
        esac ;;
esac
exit 0
FAKE
# journalctl, which is how the renderer reads the router's own per-endpoint
# counters (R-MAV-10, and the measurement §6 was reversed by). Nothing else
# on this daemon runs it.
cat > "$BIN/journalctl" <<FAKE
#!/bin/sh
cat "$ROUTER_STATS" 2>/dev/null
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
    "$BIN/hostnamectl" "$BIN/ping" "$BIN/journalctl"

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
      # Two ground stations, and deliberately not three. The Telemetry page
      # has three rows whether or not all three are configured, and an unset
      # one is a different reading from a configured one that has gone quiet
      # (R-UI-17, and `groundStationRow`s three answers) — so the third row
      # stays empty and the page is captured saying so. The addresses are the
      # ones the page was designed against.
      /^  endpoints: \[\]$/ {
          print "  endpoints:";
          print "    - name: gcs0";
          print "      host: 192.168.191.40";
          print "      port: 14550";
          print "    - name: gcs1";
          print "      host: 10.147.20.8";
          print "      port: 14551";
          next
      }
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

# The camera answer the daemon reads, and a second one for the half of R-CTL-15
# no camera on this bench can draw.
#
# `pages-daemon.mjs` re-reads its fixture on every call, the way the
# `nmcli`/`mmcli` stand-ins above re-read `$MODEM_PRESENT`, so swapping this
# copy describes a different camera without restarting anything. The console
# has to say which of the sensor and the board is turning the picture
# (R-CTL-15); the Global Shutter Camera implements no `horizontal_flip`, no
# `vertical_flip` and no `rotate`, so the board carries all three here and the
# sensor's own sentence has no hardware to produce it. `camera-sensor-turns
# .json` is the overlay that does, and it is merged rather than kept as a
# second whole fixture so the board's recorded answers stay in one file.
CAMERAS_LIVE="$ROOT/cameras.json"
CAMERAS_SENSOR="$ROOT/cameras-sensor.json"
SENSOR_OVERLAY="$REPO/scripts/fixtures/camera-sensor-turns.json"
cp "$CAMERAS" "$CAMERAS_LIVE" || die "could not stage the camera fixture at $CAMERAS_LIVE"
[ -f "$SENSOR_OVERLAY" ] || die "no sensor-turns overlay at $SENSOR_OVERLAY"
BASE="$CAMERAS" OVERLAY="$SENSOR_OVERLAY" OUT="$CAMERAS_SENSOR" node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const base = JSON.parse(readFileSync(process.env.BASE, "utf8"));
const overlay = JSON.parse(readFileSync(process.env.OVERLAY, "utf8"));
for (const [key, value] of Object.entries(overlay.capabilities)) {
  // A capability the overlay names and the recorded fixture does not is a
  // renamed key, not a camera that lacks it: written silently it would leave
  // the sensor capture describing the board case and passing.
  if (!(key in base.found[0].capabilities)) {
    throw new Error(`the overlay names ${key}, which the recorded fixture has no key for`);
  }
  base.found[0].capabilities[key] = value;
}
writeFileSync(process.env.OUT, JSON.stringify(base, null, 2) + "\n");
' || die "could not build the sensor-turns fixture at $CAMERAS_SENSOR"

# A third copy: two cameras, and a gimbal on the first.
#
# The gate's daemon answered one camera and no gimbal, and no browser had ever
# reported to it — so the state overlay on the picture, the drag hint, and the
# strip's `Still · N s` row with its `OTHER CAMERAS` figure were built and
# uncaptured (blueprint L-10 to L-13, L-17, L-20 to L-22). None of them can be
# photographed against one stopped camera: the overlay is the daemon's answer
# to *this browser's* own viewer report, the hint is drawn only where `aim`
# answers `present`, and a still can only be taken off a pipeline that is
# running.
#
# An overlay again, merged the same way and for the same reason: the recorded
# answers stay in one file. The second camera is `found[0]` on another socket
# — cloned *before* the gimbal goes on the first, so it answers `aim:
# not-offered` exactly as the board did, and the pair differ in what they are
# as well as in where they are. See scripts/fixtures/camera-pair.json.
CAMERAS_PAIR="$ROOT/cameras-pair.json"
PAIR_OVERLAY="$REPO/scripts/fixtures/camera-pair.json"
[ -f "$PAIR_OVERLAY" ] || die "no camera-pair overlay at $PAIR_OVERLAY"
BASE="$CAMERAS" OVERLAY="$PAIR_OVERLAY" OUT="$CAMERAS_PAIR" node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const base = JSON.parse(readFileSync(process.env.BASE, "utf8"));
const overlay = JSON.parse(readFileSync(process.env.OVERLAY, "utf8"));
const second = overlay.second;
// The configured camera has to be one the sweep reports, or `refuse()` stops
// the start with "this board has no /dev/v4l/by-path/..." and the strip has
// nothing running in it — a fixture that disagreed with itself would fail as
// a page with no picture rather than as the typo it is.
if (second.camera.device !== second.byPath) {
  throw new Error("the second camera is configured on a by-path name the sweep does not report");
}
base.found.push({
  ...structuredClone(base.found[0]),
  device: second.device,
  card: second.card,
  byPath: second.byPath,
});
// A capability the overlay names and the recorded fixture has no key for is a
// renamed key, not a camera that lacks it — the same guard the sensor-turns
// merge above makes, and for the same reason: written silently it would leave
// the pair capture drawing no aim panel and passing.
if (!("aim" in base.found[0].capabilities)) {
  throw new Error("the recorded fixture has no `aim` key for the overlay to answer");
}
base.found[0].capabilities.aim = overlay.aim;
base.cameras = [base.camera, second.camera];
writeFileSync(process.env.OUT, JSON.stringify(base, null, 2) + "\n");
' || die "could not build the pair fixture at $CAMERAS_PAIR"

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

# scripts/pages-daemon.mjs, not dist/daemon/server.js, and only here.
#
# `MavlinkRenderer` is assembled only when a caller hands `startServer` a way
# to open a serial port, and nothing in this repository implements one — so
# the shipped `main()` supplies none and every `/mav/*` route answers 503.
# That is the true state of every device built to date and it is also a
# Telemetry page with nothing on it, which is the failure R-UI-12 exists to
# prevent. The harness entry point builds the same daemon from the same
# environment and adds the serial stand-in, exactly as the files above stand
# in for nmcli, mmcli, curl and ping. `scripts/verify-console.sh` still
# starts the production entry point, so `main()`'s own wiring stays covered.
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
    YONDER_PAGES_MAV_MODE="$MAV_MODE" \
    YONDER_PAGES_MAV_CONF="$ETC/mavlink-router/main.conf" \
    YONDER_PAGES_MAV_HINT="$STATE/mavlink-link.json" \
    YONDER_PAGES_ROUTER_STATE="$ROUTER_STATE" \
    YONDER_PAGES_ROUTER_STATS="$ROUTER_STATS" \
    YONDER_CAMERAS_FIXTURE="$CAMERAS_LIVE" \
    YONDER_MEDIA_CONFIG="$ROOT/etc/mediamtx/mediamtx.yml" \
    PATH="$BIN:$PATH" \
        node "$REPO/scripts/pages-daemon.mjs" >>"$JOURNAL" 2>&1 &
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
# One field out of a JSON reply, parsed rather than pattern-matched.
#
# `sed -n 's/.*"id":"\([^"]*\)".*/\1/p'` is greedy, and `GET /status` carries
# two ids: the pending change's and `lastResult`'s, left over from the apply
# before it. So the pattern read the *previous* apply's id, confirmed a change
# that was already over, and left the real one pending — which then refused
# every apply after it and took the rest of the run with it.
json_field() {
    node -e '
        let raw = "";
        process.stdin.on("data", (d) => { raw += d; });
        process.stdin.on("end", () => {
            try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")); }
            catch { process.stdout.write(""); }
        });
    ' "$1"
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

# The same confirmation, **waited out**, and by a parsed id.
#
# `confirm_apply` above sends the confirmation and returns, which is enough
# where the next thing to happen is another route. It is not enough before a
# *capture*: the engine is still settling for a moment afterwards, an apply
# that has not settled blocks every apply behind it — the theme change
# included — and a page photographed inside the window carries a countdown
# banner it was not taken for.
#
# `json_field`, not the pattern above, for the reason that function's own
# comment gives: a greedy match reads whichever id came last in the reply.
settle_apply() {
    settle_id=$(printf '%s' "$1" | json_field id)
    [ -n "$settle_id" ] && sock_post /confirm "{\"id\":\"$settle_id\"}" >/dev/null
    i=0
    while [ "$i" -lt "$TRIES" ]; do
        case "$(sock /status)" in *'"state":"pending"'*) ;; *) return 0 ;; esac
        sleep "$POLL"; i=$((i + 1))
    done
    bad "an apply was still pending after it was confirmed: $(sock /status)"
    return 1
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

# The telemetry layer, which every device built to date does not have. See
# start_daemon: this run has a serial stand-in, so these five routes answer
# rather than 503, and the Telemetry page can be captured with something on it.
wait_for_phase() {
    i=0
    while [ "$i" -lt "$TRIES" ]; do
        case "$(sock /mav/state)" in *"\"phase\":\"$1\""*) return 0 ;; esac
        sleep "$POLL"; i=$((i + 1))
    done
    return 1
}

# A camera's pipeline, in the state the **supervisor observed** it in — never
# the configuration's own `enabled` (R-CTL-10).
#
# Matched on the run block's two fields together rather than on
# `"state":"running"` alone: this reply carries a dozen other objects with a
# `state` in them, and one of those answering for the pipeline would be a wait
# that returns before anything has started.
wait_for_run() {
    i=0
    while [ "$i" -lt "$TRIES" ]; do
        case "$(sock "/cameras/$1")" in
            *"\"run\":{\"id\":\"$1\",\"state\":\"$2\""*) return 0 ;;
        esac
        sleep "$POLL"; i=$((i + 1))
    done
    return 1
}
if wait_for_phase linked; then
    ok "GET /mav/state found the autopilot and says so"
else
    bad "GET /mav/state never reported a link: $(sock /mav/state)"
fi
mav=$(sock /mav/state)
expect_contains "and names the port it was found on"   '"device":"/dev/ttyAMA0"' "$mav"
expect_contains "and the speed the sweep settled at"   '"baud":57600' "$mav"
expect_contains "with telemetry flowing to the ground stations" '"telemetryRunning":true' "$mav"
expect_contains "GET /mav/check answers as a chain, not a verdict" '"autopilot"' "$(sock /mav/check)"

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
mkdir -p "$CONSOLE/node_modules" "$USERDIR/node_modules"
# **Into the user directory as well as the console tree, and that is what
# makes this gate photograph the packages under test** (K-46).
#
# Node-RED finds a node module by walking up from its *own* directory looking
# for `node_modules`, and `node-red` here is a symlink into `vendor/console`
# — which node resolves, so the walk starts in this repository and climbs out
# of it. On a checkout whose parent directory happens to hold another
# workspace's `node_modules`, the packages it finds are that other one's:
# every yonder node loaded from a different tree, silently, and a package
# this branch added was simply absent. `$CONSOLE/node_modules` is not on that
# path at all, so the careful staging below was never what got loaded.
#
# `<userDir>/node_modules` is scanned first and its modules win the dedupe
# outright (`localfilesystem.scanTreeForNodesModules` marks them `local` and
# sorts them ahead), so linking them there is what pins the gate to this
# tree. The console tree's copy stays, because that is where a board has them
# and this script exists to run what a board runs.
#
# rm then ln, never `ln -sfn`: -n is not POSIX, and without it `ln -sf` onto an
# existing symlink-to-a-directory creates the link inside it.
for pkg in node-red-contrib-yonder-system node-red-contrib-yonder-network \
           node-red-contrib-yonder-remote node-red-contrib-yonder-modem \
           node-red-contrib-yonder-video node-red-contrib-yonder-mavlink \
           node-red-dashboard-2-yonder; do
    rm -f "$CONSOLE/node_modules/$pkg" "$USERDIR/node_modules/$pkg"
    ln -s "$REPO/packages/$pkg" "$CONSOLE/node_modules/$pkg"
    # Dashboard discovers a third-party widget package by reading the *user
    # directory's* package.json for a dependency and resolving it beneath that
    # directory, so the widget package has to be here whatever else is (K-28).
    ln -s "$REPO/packages/$pkg" "$USERDIR/node_modules/$pkg"
done
rm -f "$CONSOLE/node_modules/yonder-core" "$USERDIR/node_modules/yonder-core"
ln -s "$CORE" "$CONSOLE/node_modules/yonder-core"
ln -s "$CORE" "$USERDIR/node_modules/yonder-core"
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
            yonder-cameras yonder-camera yonder-stream yonder-stream-address; do
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

# R-UI-22. The stylesheet has to be *in the document the browser is handed*,
# not fetched by something the document later runs: a link the SPA adds after
# boot is a link that arrives after the first paint, and the console flashes
# white on every load. So this asks the two questions separately — is it there
# at all, and is it there before the browser has anything to paint.
expect_contains "the theme is in the served document" "/yonder/theme.css" "$dash"
head_of_dash=${dash%%</head>*}
[ "$head_of_dash" = "$dash" ] && head_of_dash=""
expect_contains "and it is in the head, so the first paint has it" \
    "/yonder/theme.css" "$head_of_dash"
# The way it used to arrive. A ui-template's @import is injected over
# Dashboard's own socket, which does not exist until the SPA has booted.
expect_missing "and nothing imports it from inside a style block" \
    "@import" "$dash"

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
    # The gate's own rules, before the console is asked anything.
    #
    # Everything below this line proves the rules against the pages this
    # console happens to have, which is the claim that matters and is also the
    # claim's limit: a rule can only be seen working on a defect that is
    # actually there. `measure-page.test.mjs` builds the defect instead — six
    # lines of HTML per case, each written as a mutation, so a case that
    # passes because the rule never fires cannot pass quietly. The sideways
    # rule shipped with a false negative that no page here reaches.
    if node "$REPO/scripts/measure-page.test.mjs"; then
        ok "the rules that run inside a page hold against a page built to break them"
    else
        bad "the rules that run inside a page: see the output above"
    fi

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

    # R-CTL-15's other sentence: the camera turning its own picture.
    #
    # Mirror, Flip and Rotation are drawn on **every** camera, because where
    # the sensor will not turn the picture the board does, after decoding
    # (`video/orientation.ts`). The two are identical in the picture and not
    # in their cost, so the console says which of them is carrying each
    # control — and that is two sentences, of which the base captures can only
    # ever show one. The Global Shutter Camera implements none of the three:
    # every capture above this line photographs the *board* case, with the
    # recorded fixture's own `horizontalFlip: true` being carried by a
    # `videoflip`.
    #
    # **There is no hardware here that can draw the other one**, which is why
    # this swaps the fixture rather than pressing something. A gate that only
    # ever photographed the board's sentence would not notice the sensor's
    # going wrong, and the sensor's is the one that says a correction is free.
    #
    # Only `camera-live`: the group is the same group on Setup, drawn by the
    # same method from the same payload, and a second picture of it would cost
    # a capture to prove nothing the first does not.
    capture_sensor_turns() {
        cp "$CAMERAS_SENSOR" "$CAMERAS_LIVE"
        # One poll of the camera page's own report, so the deck is drawing
        # this camera and not the one before it.
        sleep 7
        # The whole hop, through a real daemon: this camera's sensor answers a
        # mirror of its own, and the deck's payload says the camera is
        # carrying it. `orientation.test.ts` proves the answer and
        # `present.test.ts` proves the payload; this is the only place the two
        # are joined by the daemon that actually composes them.
        expect_contains "the deck says the camera is turning its own picture, not the board" \
            '"by":"sensor"' "$(sock /cameras/front)"
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only camera-live \
                --as camera-live-sensor-turns \
                --artifacts "$REPO/vendor/capture" \
                --synthetic-cameras "$CAMERAS_SENSOR" \
                --secrets "$ETC/secrets.yaml" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: Orientation on a camera whose sensor turns its own picture"
        else
            bad "the $1 palette: Orientation on a camera whose sensor turns it, see above"
        fi
        # Back to the board's own camera before anything else is captured:
        # every other picture in this run is of the recorded fixture.
        cp "$CAMERAS" "$CAMERAS_LIVE"
        sleep 7
        expect_contains "the recorded camera is back for the rest of the run" \
            '"horizontalFlip":{"state":"not-offered"}' "$(sock /cameras/front)"
    }

    # The picture and the strip with something on them (R-VID-14, R-VID-18;
    # blueprint L-10 to L-13, L-17, L-20 to L-22).
    #
    # Every other camera capture in this run is of a one-camera board with
    # nothing running on it, which is the state an operator meets first and is
    # worth photographing — and it is also a picture with no overlay, a strip
    # with one stopped thumbnail and a figure reading zero. Eight rows of the
    # blueprint are drawn only in the other state, so this is that state: two
    # cameras, both pipelines up under the fake host, a gimbal answering on the
    # first, and a browser left on the page long enough to fall back to stills
    # and be answered.
    #
    # **The waits are conditions, not sleeps**, and each names the row it is
    # for: the overlay and its bitrate line (L-10 to L-13), the frame on the
    # picture, the drag hint (L-17), the second camera's thumbnail and its
    # caption (L-20), and a non-zero figure beside `OTHER CAMERAS` (L-22).
    #
    # The state overlay reaches a page only as the daemon's answer to *that
    # browser's own* viewer report, and the report the harness produces is the
    # one the picture posts when it gives up on video after twelve seconds —
    # then this device has to take a frame, serve it, and answer the report
    # after that with what the copy cost. A fixed sleep covering all of that
    # would be a number too short on a loaded machine and wasted on every
    # other run, and one too short is a picture filed under a state it is not
    # in. `--wait-for` is what the capture waits on instead.
    #
    # **`camera-live` and the Cockpit, and deliberately not `camera-setup`.**
    # The picture and the strip are the same group on Setup, drawn by the same
    # method from the same payload, so a third picture of them would cost a
    # capture to prove nothing the first does. The Cockpit is not that: it is a
    # second `ui-yonder-picture`, fed by a second change node (R-UI-28), and
    # `payload.aim` reaching it is exactly what Task 47 had to add.
    capture_pair() {
        cp "$CAMERAS_PAIR" "$CAMERAS_LIVE"
        # The second camera into the applied document, through the engine like
        # any other change (R-CFG-01, R-CFG-03) — never a write behind its
        # back — and taken out again at the end of this function.
        sock /config > "$ROOT/config.json"
        SECOND="$PAIR_OVERLAY" node -e '
            const { readFileSync } = require("node:fs");
            const config = require(process.argv[1]);
            const overlay = JSON.parse(readFileSync(process.env.SECOND, "utf8"));
            config.cameras = [...config.cameras, overlay.second.camera];
            process.stdout.write(JSON.stringify(config));
        ' "$ROOT/config.json" > "$ROOT/pair.json"
        added=$(curl -s -H 'content-type: application/json' --data @"$ROOT/pair.json" \
            --unix-socket "$SOCKET" http://localhost/apply)
        settle_apply "$added"
        expect_contains "the board has a second camera configured" \
            '"id":"tail"' "$(sock /config)"
        # Both pipelines up. Start is a runtime action and survives no apply
        # (R-CTL-01), so it comes after the change above rather than before it.
        sock_post /cameras/front/run '{"action":"start"}' >/dev/null
        sock_post /cameras/tail/run '{"action":"start"}' >/dev/null
        for pair_cam in front tail; do
            if wait_for_run "$pair_cam" running; then
                ok "the $pair_cam camera is running, under a pipeline host with no GStreamer in it"
            else
                bad "the $pair_cam camera never reached running: $(sock "/cameras/$pair_cam")"
            fi
        done
        # What the pages are about to draw, asserted through the daemon first,
        # so a capture that comes out wrong is read as a page defect and not as
        # a fixture that never arrived.
        pair=$(sock /cameras/front)
        expect_contains "the deck's aim panel says this camera can be aimed" \
            '"aim":{"state":"present"' "$pair"
        expect_contains "with the envelope the fixture answered, both ends of both axes" \
            '"bounds":{"pan":[-180,180],"tilt":[-90,30]}' "$pair"
        expect_contains "and the strip carries the second camera beside it" \
            '"name":"Tail camera"' "$pair"
        expect_contains "which is running, so it is not drawn as stopped" \
            '"stopped":false' "$pair"
        for pair_page in camera-live cockpit; do
            if node "$REPO/scripts/capture-pages.mjs" \
                    --base-url "http://127.0.0.1:$PORT" \
                    --password "$PASSWORD" \
                    --palette "$1" \
                    --only "$pair_page" \
                    --as "$pair_page-pair" \
                    --artifacts "$REPO/vendor/capture" \
                    --synthetic-cameras "$CAMERAS_PAIR" \
                    --secrets "$ETC/secrets.yaml" \
                    --wait-for ".y-pic__state" \
                    --wait-for ".y-ov__bitrate" \
                    --wait-for "img.y-pic__video" \
                    --wait-for ".y-pic__hint" \
                    --wait-for ".y-strip__img:not(.is-empty)" \
                    --wait-for '.y-strip__cap:text-matches("^Still . [0-9]")' \
                    --wait-for '.y-strip__dl-v:text-matches("^[1-9]")' \
                    ${ACCEPT_SHAPE:+--accept}; then
                ok "the $1 palette: $pair_page with two cameras, a gimbal and a picture on stills"
            else
                bad "the $1 palette: $pair_page with two cameras, see above"
            fi
        done
        # Back to the one-camera board before anything else is captured. Both
        # pipelines down first: a camera cannot be taken out from under a
        # running one, which is `removalRefusal`'s whole job.
        sock_post /cameras/tail/run '{"action":"stop"}' >/dev/null
        sock_post /cameras/front/run '{"action":"stop"}' >/dev/null
        for pair_cam in front tail; do
            wait_for_run "$pair_cam" stopped \
                || bad "the $pair_cam camera never stopped: $(sock "/cameras/$pair_cam")"
        done
        sock /config > "$ROOT/config.json"
        node -e '
            const config = require(process.argv[1]);
            config.cameras = config.cameras.filter((c) => c.id !== "tail");
            process.stdout.write(JSON.stringify(config));
        ' "$ROOT/config.json" > "$ROOT/one-camera.json"
        settle_apply "$(curl -s -H 'content-type: application/json' --data @"$ROOT/one-camera.json" \
            --unix-socket "$SOCKET" http://localhost/apply)"
        cp "$CAMERAS" "$CAMERAS_LIVE"
        sleep 7
        expect_missing "the board is back to one camera for the rest of the run" \
            '"id":"tail"' "$(sock /config)"
        expect_contains "and it answers no gimbal again" \
            '"aim":{"state":"not-offered"}' "$(sock /cameras/front)"
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

    # ---- the Telemetry page, in each of the states it hides ---------------
    #
    # R-UI-12: a surface that hides part of itself is captured in each of
    # those parts, and this page hides five of its six behind live readings.
    # The design README enumerates them, so the gate works from a list rather
    # than from a judgement — and every one is reached the way an operator
    # reaches it, through the daemon, never by writing a payload into a widget.
    #
    # `telemetry` itself is the sixth: the base capture above, taken with an
    # autopilot answering and telemetry flowing.
    capture_telemetry() {
        # $1 palette, $2 the name this state is filed under
        if node "$REPO/scripts/capture-pages.mjs" \
                --base-url "http://127.0.0.1:$PORT" \
                --password "$PASSWORD" \
                --palette "$1" \
                --only telemetry \
                --as "$2" \
                --artifacts "$REPO/vendor/capture" \
                ${ACCEPT_SHAPE:+--accept}; then
            ok "the $1 palette: $2"
        else
            bad "the $1 palette: $2, see above"
        fi
    }

    # R-MAV-09, and the distinction the two running fields exist for: a stop
    # takes the ground stations out of what is generated and leaves the
    # flight-controller link and the loopback copy up. So the Autopilot half
    # of the page stays lit and only the Ground stations half goes quiet — a
    # page that greyed the aircraft out here would be the defect
    # `routerRunning` was separated from `telemetryRunning` to prevent.
    capture_telemetry_stopped() {
        sock_post /mav/stop "{}" >/dev/null
        stopped=$(sock /mav/state)
        expect_contains "stopping telemetry stops the sending" \
            '"telemetryRunning":false' "$stopped"
        expect_contains "and leaves mavlink-router carrying the aircraft" \
            '"routerRunning":true' "$stopped"
        # One poll of the page, so it is showing the stop and not the moment
        # before it.
        sleep 7
        capture_telemetry "$1" telemetry-stopped
        sock_post /mav/start "{}" >/dev/null
        if wait_for_phase linked; then
            ok "and starting it again brings the link back"
        else
            bad "telemetry never came back after the stop: $(sock /mav/state)"
        fi
        sleep 7
    }

    # R-MAV-13's two kinds of nothing, which are two different pictures and
    # two different things to do about them. Driven by changing what is on the
    # other end of the serial stand-in and asking the device to look again —
    # `POST /mav/detect` is the only route that takes the port back off the
    # router, which is why nothing else in this run re-probes.
    capture_telemetry_nothing() {
        # $1 palette, $2 the mode the stand-in answers in, $3 the phase that
        # produces, $4 the name this state is filed under
        echo "$2" > "$MAV_MODE"
        sock_post /mav/detect "{}" >/dev/null
        if wait_for_phase "$3"; then
            ok "the sweep came back $3 with $2 on the wire"
        else
            bad "the sweep never reported $3: $(sock /mav/state)"
        fi
        sleep 7
        capture_telemetry "$1" "$4"
    }

    # R-MAV-07 and R-UI-15, in one press.
    #
    # Where MAVLink is accepted from is configuration and is **not** exempt
    # from the confirmation window, so pressing ANY NETWORK applies a whole
    # document and the change pends — which is two states, not one: the page
    # with the banner up, and the page once the change is in force.
    #
    # The press is the point. This rail was wired in the change that captured
    # it, and every soft key on this console shipped dead once, because
    # Dashboard drops a widget-action from a widget that did not register
    # onAction and says nothing. Only pressing it says otherwise.
    capture_telemetry_ingest() {
        node "$REPO/scripts/capture-pages.mjs" \
            --base-url "http://127.0.0.1:$PORT" --password "$PASSWORD" \
            --palette "$1" --only telemetry --as telemetry \
            --artifacts "$REPO/vendor/capture" \
            --press "ANY NETWORK" >/dev/null 2>&1 || true
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            case "$(sock /status)" in *'"state":"pending"'*) break ;; esac
            sleep "$POLL"; i=$((i + 1))
        done
        pending=$(sock /status)
        expect_contains "pressing ANY NETWORK on the rail reached the device" \
            '"state":"pending"' "$pending"
        expect_missing "and it is an ordinary change, not one that moves the radio" \
            '"movesRadio":true' "$pending"
        sleep 7
        capture_telemetry "$1" telemetry-pending
        pending_id=$(printf '%s' "$pending" | json_field id)
        [ -n "$pending_id" ] && sock_post /confirm "{\"id\":\"$pending_id\"}" >/dev/null
        # Confirmed, not idle: the engine's state after a confirm is
        # `confirmed`, and only a revert ends at `idle`. Waiting for the wrong
        # word here spent forty seconds and then carried on regardless.
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            case "$(sock /status)" in *'"state":"pending"'*) ;; *) break ;; esac
            sleep "$POLL"; i=$((i + 1))
        done
        sleep 7
        expect_contains "confirming it leaves MAVLink accepted from any network" \
            '"loopback_only":false' "$(sock /config)"
        capture_telemetry "$1" telemetry-ingest-open

        # Back to loopback before anything else is captured: every other
        # picture in this run describes a device that accepts MAVLink from
        # itself alone, which is the shipped default (R-MAV-07).
        sock /config > "$ROOT/config.json"
        node -e '
            const config = require(process.argv[1]);
            config.mavlink.ingest.loopback_only = true;
            process.stdout.write(JSON.stringify(config));
        ' "$ROOT/config.json" > "$ROOT/closed.json"
        closed=$(curl -s -H 'content-type: application/json' --data @"$ROOT/closed.json" \
            --unix-socket "$SOCKET" http://localhost/apply)
        closed_id=$(printf '%s' "$closed" | json_field id)
        [ -n "$closed_id" ] && sock_post /confirm "{\"id\":\"$closed_id\"}" >/dev/null
        i=0
        while [ "$i" -lt "$TRIES" ]; do
            case "$(sock /status)" in *'"state":"pending"'*) ;; *) break ;; esac
            sleep "$POLL"; i=$((i + 1))
        done
        expect_contains "the ingest path is closed again for the rest of the run" \
            '"loopback_only":true' "$(sock /config)"
        sleep 7
    }

    # Every state this page hides, in one palette. Called from both.
    capture_telemetry_states() {
        capture_telemetry_stopped "$1"
        capture_telemetry_ingest "$1"
        capture_telemetry_nothing "$1" silent silent telemetry-searching
        capture_telemetry_nothing "$1" noise  noise  telemetry-not-mavlink
        # Back to an autopilot on the wire, so the next palette starts where
        # this one did and the base capture is of a linked device.
        echo linked > "$MAV_MODE"
        sock_post /mav/detect "{}" >/dev/null
        if wait_for_phase linked; then
            ok "the autopilot is back on the wire for the rest of the run"
        else
            bad "the link never came back: $(sock /mav/state)"
        fi
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

    # ---------------------------------------------------------------------
    # The viewport contract, spec §5 (R-UI-23, R-UI-12).
    #
    # Every capture above is at 1280x900, which is what makes the shape
    # references comparable. It is also a width nobody flies with. Spec §5
    # names two surfaces the camera pages have to hold their shape on and
    # states a different promise for each: a notebook at 1440x900 with the
    # sidebar open, where the picture, the Aim panel and the shutter key fit
    # above the fold and the deck may run past it; and a landscape tablet
    # below the 1100 px breakpoint, where the Aim panel drops beneath the
    # picture and the groups flow into fewer columns.
    #
    # **A tall full-page PNG is not evidence that anything fits above the
    # fold**, which is the sentence spec §13 ends that paragraph with, so
    # `--fold` photographs the viewport on its own beside the full page and
    # asserts what is inside it.
    #
    # Only the pages that draw the picture, because that is what the contract
    # is written about — the picture, the Aim panel, the shutter key, one deck
    # and one rail. Every other page is checked for sideways scroll and
    # clipped text at 1280 like everything else.
    #
    # **The Cockpit is one of them, and it is held to less** (R-UI-28). It
    # carries the picture and the Aim panel and deliberately nothing else, so
    # the fold rule applies to those two and the shutter-key, deck-scroller
    # and rail rules do not — there is no deck and no rail on it to check.
    # Which of the three each surface answers for is read off `flows.json` in
    # `capture-pages.mjs` rather than decided here, so a page that loses its
    # rail by accident still fails.
    #
    # Each width records a shape reference of its own, under its own `--as`
    # name, so a 1440 rendering is never compared against a 1024 one.
    #
    # **`--secrets`, because these runs write committed images too.**
    # `deviceSecret()` answers `null` without it, which switches off both
    # R-SEC-10 guards — the page-HTML check and the specimen-file check — and
    # these are the two pages that carry the resolved stream address. Sixteen
    # images went into `docs/console/capture/` from this function with neither
    # guard running. `--synthetic-cameras` goes with it: without `--secrets`
    # it is what makes the gate say "nothing checked the real credential"
    # rather than pass quietly, and the pair is what the base capture uses.
    capture_fold() {
        # $1 palette, $2 surface name, $3 viewport
        for camera_page in camera-live camera-setup cockpit; do
            if node "$REPO/scripts/capture-pages.mjs" \
                    --base-url "http://127.0.0.1:$PORT" \
                    --password "$PASSWORD" \
                    --palette "$1" \
                    --only "$camera_page" \
                    --as "$camera_page-$2" \
                    --viewport "$3" \
                    --fold \
                    --artifacts "$REPO/vendor/capture" \
                    --synthetic-cameras "$CAMERAS" \
                    --secrets "$ETC/secrets.yaml" \
                    ${ACCEPT_SHAPE:+--accept}; then
                ok "the $1 palette: $camera_page holds its shape on a $2 at $3"
            else
                bad "the $1 palette: $camera_page on a $2 at $3, see above"
            fi
        done
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
        capture_sensor_turns night
        capture_pair night
        capture_fold night notebook 1440x900
        capture_fold night tablet 1024x768
        capture_telemetry_states night
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
        capture_sensor_turns day
        capture_pair day
        capture_fold day notebook 1440x900
        capture_fold day tablet 1024x768
        capture_telemetry_states day
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
