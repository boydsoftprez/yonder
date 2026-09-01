# Verifying M1a on real hardware

M1a — the access point, the Wi-Fi client and Ethernet profiles, the apply/rollback engine
used for real, and the access-point fallback — is built and unit-tested. Every one of those
tests runs against a fake `nmcli`: an injected command runner that returns whatever string
the test hands it. This procedure is what runs the same code against a real one.

Nothing below can be replaced by a better unit test. It requires a Raspberry Pi, a real
NetworkManager, a real Wi-Fi radio, a second device to observe from, and a real reboot.

## Do these two first

**There is no `nmcli` on the machine `yonder-core` was written on.** Every claim in this
document is backed by a unit test against a fake runner — but a fake runner can only ever
confirm that the code agrees with itself. Two pieces of `nmcli` grammar were written from
the documentation and have never been executed, and both of them are load-bearing. Step 1
confirms them, and nothing after Step 1 means much until it has.

| What to confirm | Command | Why it matters |
|---|---|---|
| The shape of `device show` output | the four capture commands in Step 1, especially `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` | It is the reachability probe behind the access-point fallback (R-NET-07), parsed by `parseDeviceShow`. Misread it and the board either raises its access point on every boot forever, or never raises it at all. |
| That `connection modify` rejects add-only options | `nmcli connection modify yonder-ap type wifi` | `type` and `ifname` belong to `connection add`. If `modify` accepted them the code would be over-cautious; if it rejects them, as expected, every render after the first would have failed had they still been sent. |

**If a real board disagrees with either, the code is wrong and the fixture is right.** Fix
the parser or the argv, replace the fixture with what the board actually printed, and say so
in the Results section. Do not reshape a capture to fit what is written here.

## What this verifies, and why it can't be verified any other way

| Requirement | What the fake `nmcli` could never tell you |
|---|---|
| R-NET-01, R-SEC-01 — access point with the published setup passphrase | A fake `nmcli` always reports success. It cannot tell you whether a real phone can complete a real WPA2 handshake against `yonder1234`. |
| R-NET-02 — DHCP for access-point clients | A fake `nmcli` cannot hand a real device a real lease. Nothing before this procedure has ever offered an IP address to anything. |
| R-NET-03, R-NET-04 — Wi-Fi client and Ethernet | The renderer has only ever been told "the command exited 0." It has never watched a real radio fail to associate, or a real cable fail to carry a DHCP offer. |
| R-CFG-03 — apply behind a confirmation timer, revert if unconfirmed | Every existing test drives the confirmation timer with a fake clock that jumps straight to "120 seconds later" (see `advance(ms)` in `packages/yonder-core/src/net/watchdog.test.ts` and the equivalent in `apply/engine.test.ts`). This is the first time the timer runs against the real one, for a real two minutes, while a real `nmcli` is told to build and tear down real connections. |
| R-NET-07 — access-point fallback | The fallback watchdog has only ever been asked "if you called `activeIpv4()` right now, what would you say?" against a canned string. It has never been asked that by a process that just rebooted, on hardware whose radio may or may not have finished initializing yet. This is the requirement M1a exists to satisfy, and Step 6 below is the whole point of this document. |

There is no web console yet — that's M1b. Everything here talks to `yonder-core` directly,
either through `nmcli` or through its Unix-socket HTTP API.

### Reference: paths, environment variables, and timers

The daemon (`packages/yonder-core/src/daemon/server.ts`) reads exactly four environment
variables, all in its `main()` function. Nothing else is configurable from the environment,
and the shipped `systemd/yonder-core.service` sets none of them — so a board running the
installed service always uses the right-hand column below.

| Variable | Default | What it is |
|---|---|---|
| `YONDER_SOCKET` | `/run/yonder/core.sock` | The Unix socket the HTTP API listens on |
| `YONDER_CONFIG` | `/etc/yonder/config.yaml` | The single source of truth for device state |
| `YONDER_JOURNAL` | `/var/lib/yonder/apply.json` | The pending-apply record `recover()` reads at startup |
| `YONDER_SECRETS` | `/etc/yonder/secrets.yaml` | The device's secrets, mode `0600`. Seeded with `ap_psk` only |

Three different timers matter below and it's easy to conflate them:

| Timer | Length | Where it comes from | Configurable? |
|---|---|---|---|
| Apply confirmation window | 120 s | `ApplyEngine`'s own hard-coded default (`timeoutMs` in `apply/engine.ts`) | No environment variable reaches it. Only code that constructs `ApplyEngine` directly (the test suite) can override it. |
| Render timeout, per renderer | 60 s | Same file, `renderTimeoutMs` | `ServerOptions.renderTimeoutMs` exists, but `main()` never sets it from the environment, so the shipped daemon always uses 60 s. |
| Access-point fallback | 90 s, measured from the moment the daemon process starts | `network.ap.fallback.timeout` in `config.yaml` (schema range 30–600 s) | Yes — it's a config value, not a build constant. |

## Prerequisites

- A Raspberry Pi running Raspberry Pi OS with NetworkManager as the network backend (the
  current default), and a Wi-Fi radio — built in or attached.
- Node.js 20 or newer reachable on `PATH` before you run the installer.
  `installer/roles/20-yonder-core.sh` calls a `require_node 20` check and deliberately
  aborts rather than build against anything older — `yonder-core` is ESM with NodeNext
  resolution and declares `engines.node >= 20` in its `package.json`. Raspberry Pi OS
  Bookworm's own `nodejs` package is major version 18, so `sudo ./installer/install.sh`
  stopping with `error: node 18 is too old; yonder-core needs node 20 or newer` is a real,
  expected outcome on a stock image, not a broken installer — you need a Node.js 20+
  runtime on `PATH` before re-running it.
- A second device with a Wi-Fi radio (laptop or phone) to join the access point from, and
  to run `ping`/scan/SSH against the board.
- Root on the board. The installer requires it, and the daemon runs as root with no
  `User=`/`Group=` in its unit (filed as known issue K-01 in `docs/known-issues.md`), so the
  socket ends up owned `root:root` mode `0660` — every `curl` against it needs `sudo` too.
- Physical access to the board (keyboard + HDMI, or a serial console), **or** a network path
  to it that is independent of the interfaces this procedure reconfigures.

> **This procedure will repeatedly and deliberately disrupt networking on the board.** Steps
> 5 and 6 exist specifically to break reachability and then prove it comes back. Do not run
> this over the only link you have to the board unless you can also reach it physically, or
> over an interface this procedure isn't touching. If your only path in right now is the
> board's own access point or its Wi-Fi client link, expect to be disconnected more than
> once, and make sure you have another way back in before Step 5.

## Step 1 — Capture real `nmcli` fixtures

On the board (replace `wlan0` if your radio has a different interface name), run each of
these individually:

```bash
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status
```

```bash
nmcli -t -f NAME,UUID,TYPE,DEVICE connection show
```

```bash
nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes
```

```bash
nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show
```

These four calls are the entire real interface between `yonder-core` and NetworkManager —
see `NmcliClient` in `packages/yonder-core/src/net/nmcli/client.ts`, which issues exactly
these four commands (`devices()`, `connections()`, `scan()`, `activeIpv4()`) and nowhere
else. Each has a fixture file, all four hand-written, all four parsed in
`packages/yonder-core/src/net/nmcli/parse.ts`:

| Command | Fixture file | Parser |
|---|---|---|
| `device status` | `fixtures/device-status.txt` | `parseTerse`, 4 fields |
| `connection show` | `fixtures/connection-list.txt` | `parseTerse`, 4 fields |
| `device wifi list` | `fixtures/wifi-scan.txt` | `parseTerse`, 3 fields |
| `device show` (`IP4.ADDRESS`) | `fixtures/device-show-ip4.txt` | `parseDeviceShow`, a field stream |

(Paths are relative to `packages/yonder-core/src/net/nmcli/`.)

**The fourth is the one to look at hardest.** `device show` is the only one of the four
whose output shape has never been seen — see the note at the top of this document. It is
also the call the fallback watchdog in Step 6 depends on, so a misreading of it is a device
that never raises its access point, or one that raises it on every boot forever. Three
things to check against `parseDeviceShow`:

- Field names are **section-qualified**: `GENERAL.DEVICE`, not the bare `DEVICE` that
  belongs to `device status`. If your `nmcli` rejects the field list outright, that is the
  finding.
- Output is a **stream** of `FIELD:value` lines — one line per property, per device — not
  one record per device. A device with no address should occupy one line; a device with two
  addresses, three.
- Addresses appear as `IP4.ADDRESS[1]` (indexed) or `IP4.ADDRESS`. Record which.
- What a device holding **no** address actually prints for `IP4.ADDRESS`, if anything at
  all — an omitted line, an empty value (`IP4.ADDRESS[1]:`), or a placeholder such as `--`
  or `(none)`. Nobody has observed this on real hardware. `parseDeviceShow` treats any value
  that does not itself look like an IPv4 address (with or without a `/prefix`) as "no
  address", precisely so a placeholder cannot be misread as one — but which form your
  NetworkManager build actually emits has never been confirmed. Record the exact text.

Replace all four fixture files with what you captured. Redact real SSIDs and connection
UUIDs if you want to — a UUID or an SSID string doesn't need to be genuine — but **preserve
the exact escaping and field structure**: `nmcli -t` escapes a literal colon or backslash
inside a value with a backslash, and both parsers walk the string character by character to
undo exactly that (see the comments in `parse.ts`). A redacted SSID like `Guest\:Wifi` has to
keep its backslash; collapsing it to `Guest:Wifi` changes the field count `parseTerse` sees.

**If your board's output disagrees with either parser — a different field count, a different
field name, a different shape — the parser is wrong, never the fixture.** Fix
`packages/yonder-core/src/net/nmcli/parse.ts` (and its tests in `parse.test.ts`) to handle
what your NetworkManager version actually emits. Do not truncate, reshape, or hand-edit the
captured output to make it fit the parser as it stands today — the entire point of this step
is to find out where a real `nmcli` disagrees with what the parser assumed.

Once the fixtures are in place, from the repository root:

```bash
npm test
```

Confirm it's still green before moving on — `parse.test.ts` reads all four fixture files
directly and asserts on their shape (see `packages/yonder-core/src/net/nmcli/parse.test.ts`).

### And confirm what `connection modify` will not accept

This one needs a connection to exist, so run it after Step 2 and come back here to record
the answer. `NmcliClient.addOrModify` creates a connection with `nmcli connection add
con-name … type … ifname … setting.property value …`, and updates one with
`nmcli connection modify … connection.interface-name … setting.property value …`. The
difference is deliberate: `type` and `ifname` are `connection add` common options, and a
connection's type cannot be changed at all.

```bash
sudo nmcli connection modify yonder-ap type wifi
```

**Expect this to fail.** Record the exact error. A success here would mean `modify` is more
permissive than the manual says, which is worth knowing but changes nothing — the code does
not send it either way.

```bash
sudo nmcli connection modify yonder-ap connection.interface-name wlan0
```

Expect this to succeed silently (substitute your radio's interface name). This is the form
the renderer actually sends on every render after the first, so a failure here is a real
defect in `addOrModify` — fix `packages/yonder-core/src/net/nmcli/client.ts`.

## Step 2 — Install, and watch the access point come up

```bash
sudo ./installer/install.sh
```

This runs every role under `installer/roles/` in order: `10-base.sh` installs
`network-manager` and `dnsmasq-base` — the second explicitly, because NetworkManager only
*Recommends* it and this installer passes `--no-install-recommends`, and without it
`ipv4.method shared` has no DHCP server to run — and creates `/etc/yonder` (mode `0750`),
`/var/lib/yonder`, and `/etc/NetworkManager/dnsmasq-shared.d`; `20-yonder-core.sh` installs Node dependencies,
builds `yonder-core` into `/opt/yonder/packages/yonder-core`, copies
`systemd/yonder-core.service` into place, seeds `/etc/yonder/config.yaml`, and runs
`systemctl daemon-reload`, `enable` and `restart`.

**The installer leaves the service running and the device configured.** There is nothing to
write by hand: `config/defaults/config.yaml` — generated from `DEFAULT_CONFIG` and identical
to the reference configuration in `docs/configuration.md` — is copied into place when, and
only when, no configuration exists. Re-running the installer on a board you have configured
leaves your file exactly as it is. The daemon seeds the same content itself if it ever
starts against a missing configuration, so a hand-installed board is covered too.

```bash
sudo systemctl status yonder-core
```

Expect `Active: active (running)`.

```bash
sudo cat /etc/yonder/config.yaml
```

Expect the shipped default: access point `yonder` enabled on `192.168.77.1/24`, no client
SSID, fallback enabled at 90 s.

```bash
sudo journalctl -u yonder-core -n 50 --no-pager
```

Expect this line, and expect it on every boot until you change the passphrase:

```
access point: using the published default passphrase; change it from the console
```

**The access point's WPA2 passphrase is `yonder1234`** — published, documented, the same on
every device, and never presented as a secret. It is
`DEFAULT_AP_PASSPHRASE` in `packages/yonder-core/src/net/profiles.ts`, and it is seeded into
`secrets.yaml` only when `ap_psk` is absent, so a passphrase you have changed is kept.
[ADR-0007](../adr/0007-credential-boundary.md) is why: a random per-device value could only
be read from this journal, and getting to this journal means already being on the device.

Nothing prints a secret. `editor_password` is **not** seeded at all — it does not exist
until an operator sets an administrator password from the console, which is M1b. The
shipped configuration says the same thing: `ui.editor.password` is `null`, not a reference
to a secret no device has.

```bash
sudo cat /etc/yonder/secrets.yaml
```

Expect exactly one entry, `ap_psk: yonder1234`.

```bash
sudo ls -l /run/yonder/core.sock
```

Expect a line beginning `srw-rw----` owned by `root root`.

> **The access point should already be on the air.** `startServer()` renders the
> configuration once at startup — after `engine.recover()` and before the socket binds — so
> a board nobody has ever posted an apply to still brings up its access point. That is
> R-CFG-08, and it is the whole point of a device you can reach without having configured
> it first. Expect the renderer's own lines in the journal immediately after the service
> starts:
>
> ```
> network: wifi=wlan0 ethernet=eth0
> network: bringing the access point up
> ```
>
> (exact interface names depend on your board; a missing radio prints `none` for that
> slot). **Confirm the SSID `yonder` is visible from your second device now, before going
> any further.** If it is not, stop here — nothing later in this document will work, and
> the failure is the one that matters most.
>
> A render failure at startup is logged and does not stop the socket binding, the same as a
> failed recovery. If the journal shows
> `could not render the current configuration, serving anyway: …`, the API is still up and
> Step 3 will still answer — record what it said.
>
> If you then wait 90 seconds: the fallback watchdog fires, finds only the access point's
> own address, and tries to raise the access point again. `FallbackWatchdog.check()`
> deliberately ignores the access-point subnet — "reachable" means some *other* interface
> holds an address — so on a board with nothing but its own access point up, this is
> expected and harmless:
> ```
> fallback: nothing reachable, bringing the access point up
> ```
> The connection already exists this time, so `nmcli connection up` on an already-active
> profile is what actually runs. Record whatever your NetworkManager says to that; this
> document has not run it.

## Step 3 — Talk to the daemon over the socket

`yonder-core` exposes exactly four routes over the Unix socket
(`packages/yonder-core/src/daemon/routes.ts`) — no others exist, and there is no TCP port
anywhere in M1a to reach it by IP.

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/config
```

Expect the seeded default configuration, as one line of compact JSON:

```
{"version":1,"network":{"ap":{"enabled":true,"ssid":"yonder","psk":{"secret":"ap_psk"},"address":"192.168.77.1/24","dhcp":{"start":"192.168.77.2","end":"192.168.77.50","lease":"12h"},"fallback":{"enabled":true,"timeout":90}},"client":{"ssid":null,"psk":null},"ethernet":{"dhcp":true},"priority":["ethernet","modem","wifi_client"]},"ui":{"port":3000,"theme":"day","editor":{"enabled":true,"password":null,"interfaces":["ethernet","wifi_client"]}},"system":{"hostname":"yonder","timezone":"UTC"}}
```

(Pipe any of these commands through `python3 -m json.tool` if you'd rather read it
formatted — Raspberry Pi OS ships Python 3 by default.)

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
```

Expect exactly:

```
{"state":"idle"}
```

`GET /status` returns an object with `state`, and `id`/`expiresAt`/`lastResult` only when
they apply — `JSON.stringify` drops `undefined` fields entirely rather than printing `null`,
which is why "idle" prints as a bare one-key object. `POST /apply` and `POST /confirm` are
exercised for real in the next three steps. Anything else — a typo'd path, the wrong method
— gets a plain 404:

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -o /dev/null -w '%{http_code}\n' http://localhost/nope
```

Expect `404`.

## Step 4 — Apply a configuration and confirm it

`POST /apply` takes a complete configuration (not a patch), validates it, writes it to
`/etc/yonder/config.yaml`, renders it through NetworkManager, and — only if the render
succeeds — starts the 120-second confirmation window described above. It returns the applied
change's `id` and the epoch-millisecond `expiresAt` you have until it reverts on its own.

The body below is identical to the seeded default except `system.hostname`, which the
network renderer never reads — a safe way to prove the whole pipeline end-to-end. The access
point, the Ethernet profile and the DHCP drop-in already exist by now: the startup render in
Step 2 created them. **What this step proves is the apply path itself** — validate, write,
render, start the confirmation window — over a device that is already up and reachable.

```bash
cat > ~/yonder-apply-1.json <<'EOF'
{
  "version": 1,
  "network": {
    "ap": {
      "enabled": true,
      "ssid": "yonder",
      "psk": { "secret": "ap_psk" },
      "address": "192.168.77.1/24",
      "dhcp": { "start": "192.168.77.2", "end": "192.168.77.50", "lease": "12h" },
      "fallback": { "enabled": true, "timeout": 90 }
    },
    "client": { "ssid": null, "psk": null },
    "ethernet": { "dhcp": true },
    "priority": ["ethernet", "modem", "wifi_client"]
  },
  "ui": {
    "port": 3000,
    "theme": "day",
    "editor": {
      "enabled": true,
      "password": null,
      "interfaces": ["ethernet", "wifi_client"]
    }
  },
  "system": { "hostname": "yonder-verified", "timezone": "UTC" }
}
EOF
```

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d @/home/$USER/yonder-apply-1.json http://localhost/apply
```

Expect a 200 response shaped like `{"id":"<a uuid>","expiresAt":<a number>}`. **Record the
`id` — you have 120 seconds, real time, to confirm it.**

```bash
sudo journalctl -u yonder-core -n 20 --no-pager
```

Expect the network renderer's own log lines again, for example:

```
network: wifi=wlan0 ethernet=eth0
```

`bringing the access point up` will **not** repeat: `render()` only calls `nmcli connection
up` when the access point's active state actually has to flip, and the startup render in
Step 2 already brought it up. Seeing only the interface line here is correct.

Now, from your second device, **within the two-minute window**:

- Scan for Wi-Fi networks and confirm the configured SSID (`yonder`, unless you changed it)
  is visible. It should already have been, since Step 2 — this re-checks it survived the
  apply.
- Join it with the published passphrase **`yonder1234`**.
- Confirm the address you were handed is inside `192.168.77.2`–`192.168.77.50` (the
  configured DHCP pool) — check your device's network details panel, or `ip addr` /
  `ipconfig`. **Joining but never being given an address is the signature of a missing
  `dnsmasq-base`**; check `dpkg -l dnsmasq-base` before looking anywhere else.
- From that same second device, confirm you can reach the board at its configured address:

  ```bash
  ping -c 4 192.168.77.1
  ```

  Expect 0% packet loss. (There is no web console to open here yet — M1a has no TCP
  listener at all — so a successful ping, and SSH if you have it enabled, is the
  reachability evidence.)
- Optionally, if SSH is enabled on the board:

  ```bash
  ssh <your-username>@192.168.77.1
  ```

Still inside the window, confirm the change. This can run from the board's own console or
from the SSH session you just opened over the access point — both reach the same socket:

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d '{"id":"PASTE-THE-ID-FROM-THE-APPLY-RESPONSE"}' http://localhost/confirm
```

Expect:

```
{"state":"confirmed","id":"<the same uuid>","lastResult":{"id":"<the same uuid>","outcome":"confirmed","at":<a number>}}
```

If you miss the window, that's not a failure — it's a live demonstration of Step 5 happening
by accident. `GET /status` will show `"state":"idle"` with `"lastResult":{"outcome":"reverted",...}`;
re-apply and move faster before continuing.

## Step 5 — Prove the rollback

This is the test that matters: not that an apply can succeed, but that an apply the operator
never confirms reverts on its own.

The change has to actually render — reach `pending` — rather than being rejected outright,
or there's no confirmation window to watch expire. A deliberately wrong Wi-Fi client
password does exactly that: `nmcli` will happily create a connection profile with any
pre-shared key, because it has no way to know the key is wrong until something tries to
associate with it. Because `network.client.ssid` is currently `null`, setting it now creates
a brand-new connection rather than changing one that's already active, which matters — see
the note at the end of this step.

`yonder-core` reads a configured password from `/etc/yonder/secrets.yaml` by name, and
refuses to apply a config that names a secret it can't find, so add one first:

```bash
sudo tee -a /etc/yonder/secrets.yaml > /dev/null <<'EOF'
verify_wrong_psk: this-is-not-the-real-password
EOF
```

```bash
sudo chmod 600 /etc/yonder/secrets.yaml
```

```bash
stat -c %a /etc/yonder/secrets.yaml
```

Expect `600` — confirm your editor or `tee` didn't widen it.

Now apply a config identical to Step 4's except `network.client`:

```bash
cat > ~/yonder-apply-2.json <<'EOF'
{
  "version": 1,
  "network": {
    "ap": {
      "enabled": true,
      "ssid": "yonder",
      "psk": { "secret": "ap_psk" },
      "address": "192.168.77.1/24",
      "dhcp": { "start": "192.168.77.2", "end": "192.168.77.50", "lease": "12h" },
      "fallback": { "enabled": true, "timeout": 90 }
    },
    "client": { "ssid": "verification-test", "psk": { "secret": "verify_wrong_psk" } },
    "ethernet": { "dhcp": true },
    "priority": ["ethernet", "modem", "wifi_client"]
  },
  "ui": {
    "port": 3000,
    "theme": "day",
    "editor": {
      "enabled": true,
      "password": null,
      "interfaces": ["ethernet", "wifi_client"]
    }
  },
  "system": { "hostname": "yonder-verified", "timezone": "UTC" }
}
EOF
```

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d @/home/$USER/yonder-apply-2.json http://localhost/apply
```

Expect the same `{"id":...,"expiresAt":...}` shape as Step 4 — this confirms the render
itself succeeded.

**Do not confirm this one.** Instead:

```bash
sudo journalctl -u yonder-core -f
```

Watch it. Within 120 seconds of the apply, expect the network renderer to run again,
unprompted, tearing back down what it just built:

```
network: wifi=wlan0 ethernet=eth0
network: removing yonder-wifi
```

(`yonder-wifi` is `CLIENT_CONNECTION` from `packages/yonder-core/src/net/profiles.ts`; it
disappears because the configuration being reverted to has no client SSID at all.)

Confirm the outcome explicitly:

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
```

Expect `"state":"idle"` with `"lastResult":{"id":"<the same id as the apply>","outcome":"reverted","at":<a number>}`.
Note there is no `state` value called `"reverted"` — the state returns to `idle`; it's the
`outcome` inside `lastResult` that records what happened.

```bash
sudo cat /etc/yonder/config.yaml
```

Expect `client: { ssid: null, psk: null }` again.

> **On the alternative in the task brief:** breaking reachability with an access-point
> address on an unreachable subnet, instead of a bad client password, is the other option
> named in `task-9-brief.md`. Read `NetworkRenderer.render()` in
> `packages/yonder-core/src/net/renderer.ts` before choosing it: the renderer only calls
> `nmcli connection up`/`down` on the access point when its active/enabled state actually
> flips (`apActive` is computed once, from `nmcli device status`, at the top of `render()`).
> If the access point is already up and stays enabled across the change — which it will be,
> after Step 4 — an address-only change goes through as `nmcli connection modify` alone,
> with nothing here telling NetworkManager to reactivate the connection on the new address.
> Whether that leaves the live access point quietly running on its old, working address is a
> real-NetworkManager question the unit tests never exercise — they only assert which
> `nmcli` subcommand was called, never what NetworkManager then does with it. Worth noting in
> the results section either way, but it means this alternative may not produce an
> observable break at all. The Wi-Fi-client-password path above doesn't have that ambiguity,
> because it's always a fresh `nmcli connection add`.

## Step 6 — Prove the fallback (R-NET-07)

> R-NET-07: *"If no configured network carries traffic within 90 seconds of `yonder-core`
> starting, bring up the access point regardless of configuration. Disabling this requires an explicitly named
> configuration key."* This is the requirement the M1a milestone exists to satisfy. It's
> implemented in `FallbackWatchdog` (`packages/yonder-core/src/net/watchdog.ts`).

The watchdog's timer is armed exactly once, at daemon start, and it is never re-armed by a
later apply or confirm — recorded as **K-11** in
[`docs/known-issues.md`](../known-issues.md). The only way to re-arm it is to start the
daemon again, which is exactly what a reboot does. That's why, alone among the steps in this
document, this one needs one.

> **Confirm this apply before you reboot — this is the step most likely to silently fail.**
> `ApplyEngine.recover()` runs at every startup and reverts any apply still sitting
> unconfirmed in its journal, whether the restart was a crash or a deliberate reboot — it's
> the same guarantee R-CFG-03 asks for. Reboot before confirming and the board comes back on
> the *previous*, good configuration: access point enabled, no phantom client SSID. The
> fallback watchdog will have nothing to do, there is no error message anywhere to explain
> why, and from the outside a `reverted` you see afterward is indistinguishable between "the
> fallback watchdog worked" and "you forgot to confirm and recovery quietly undid your setup."
> Do not skip the confirm.

1. Apply a configuration with a client SSID that doesn't exist near the board, and the
   access point disabled. You may also lower `fallback.timeout` toward the schema's 30-second
   minimum here to shorten the wait — the number is a policy default, not part of the
   mechanism under test, so testing at 30 s still exercises the same code as 90 s:

   ```bash
   cat > ~/yonder-apply-3.json <<'EOF'
   {
     "version": 1,
     "network": {
       "ap": {
         "enabled": false,
         "ssid": "yonder",
         "psk": { "secret": "ap_psk" },
         "address": "192.168.77.1/24",
         "dhcp": { "start": "192.168.77.2", "end": "192.168.77.50", "lease": "12h" },
         "fallback": { "enabled": true, "timeout": 90 }
       },
       "client": { "ssid": "this-network-does-not-exist", "psk": null },
       "ethernet": { "dhcp": true },
       "priority": ["ethernet", "modem", "wifi_client"]
     },
     "ui": {
       "port": 3000,
       "theme": "day",
       "editor": {
         "enabled": true,
         "password": null,
         "interfaces": ["ethernet", "wifi_client"]
       }
     },
     "system": { "hostname": "yonder-verified", "timezone": "UTC" }
   }
   EOF
   ```

   ```bash
   sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d @/home/$USER/yonder-apply-3.json http://localhost/apply
   ```

2. **Confirm it** (same as Step 4 — POST the `id` you were just given to `/confirm`), and
   verify:

   ```bash
   sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
   ```

   Expect `"state":"confirmed"`.

3. Unplug Ethernet, or otherwise make sure it isn't carrying traffic. `FallbackWatchdog.check()`
   treats any interface other than loopback and the access point's own subnet as proof the
   board is reachable (see `watchdog.ts`) — Ethernet included. A live Ethernet link makes the
   watchdog correctly decide not to raise the access point, which would look like a failed
   test but is in fact R-NET-07 working exactly as specified.

4. Reboot:

   ```bash
   sudo reboot
   ```

5. Reconnect (physically, or once the fallback access point appears — not before), and tail
   the journal as soon as you're back:

   ```bash
   sudo journalctl -u yonder-core -f
   ```

   Expect, in order:
   - `access point: using the published default passphrase; …` again, unless you changed the
     passphrase. It is printed on every boot while the default is still in force, not once.
   - No `seeded a default configuration …` line — `/etc/yonder/config.yaml` already exists.
   - The startup render's `network: wifi=… ethernet=…` line. **The configuration under test
     here has `ap.enabled: false`, so the startup render will not raise the access point** —
     it renders the configuration as written, which is exactly what makes the rest of this
     step a real test of the fallback rather than of the render.
   - `fallback: will check for a reachable interface in 90 s` (or however many seconds you
     configured) shortly after the service starts. **A second or two less is correct, not a
     bug**: the deadline is measured from when the process started, so whatever recovery and
     the start-up render have already spent comes out of the window rather than delaying it.
     Record the number you see — on a board where the start-up render stalls, it should be
     visibly smaller.
   - Nothing network-related for the rest of that window.
   - At the end of the window: `fallback: nothing reachable, bringing the access point up`.

6. From your second device: scan, confirm the SSID is visible again — it's the same SSID and
   passphrase as before, since neither was touched by this step — join it, and confirm you're
   back on the `192.168.77.0/24` network.

7. Worth confirming directly, for the results section below:

   ```bash
   sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/config
   ```

   This should still show the nonexistent client SSID and `"enabled":false` for the access
   point. The fallback watchdog calls `client.up(AP_CONNECTION)` — straight through to
   `nmcli` — and never touches `ApplyEngine` or `config.yaml` at all. The file on disk still
   says the access point should be off; NetworkManager is simply being told otherwise, this
   once. That's the access point as "a floor, not a mode," exactly as `docs/architecture.md`
   puts it, and it's worth confirming with your own eyes that the file and the running state
   can legitimately disagree here.

## Results

Fill in after running the steps above on real hardware.

| Field | Value |
|---|---|
| Board model | |
| `cat /etc/os-release` | |
| `uname -r` | |
| `nmcli -v` | |
| `NetworkManager --version` | |
| Wi-Fi adapter / driver | |
| Date tested | |

| Step | Pass / fail | Notes |
|---|---|---|
| 1 — Real fixtures captured, `npm test` green | | |
| 1 — `nmcli connection modify yonder-ap type wifi` rejected, `connection.interface-name` accepted | | |
| 2 — Install alone leaves the service running, the config seeded and the access point on the air | | |
| 3 — All four routes answer as documented | | |
| 4 — Apply, join over Wi-Fi, DHCP in pool, ping reaches the board, confirm | | |
| 5 — Unconfirmed apply reverts within the window | | |
| 6 — Fallback brings the access point up after reboot | | |

What behaved differently from the unit tests (there is almost certainly something — this
document flags a few candidates worth checking specifically):

- Did any captured record have a field count `parseTerse` didn't expect?
- Did `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` emit the field stream
  `parseDeviceShow` assumes — `GENERAL.DEVICE` lines, `IP4.ADDRESS[n]` lines — or something
  else?
- Did the access-point-address alternative in Step 5's closing note actually fail to break
  reachability, as the code reading there predicted?
- Any `nmcli`/NetworkManager version-specific quirks worth recording for the next board?

---

Once this section is filled in, the fixtures in
`packages/yonder-core/src/net/nmcli/fixtures/` are real captures rather than hand-written
ones, and `docs/known-issues.md` is updated if the board revealed anything new, commit with:

```bash
git add packages/yonder-core/src/net/nmcli/fixtures docs/hardware/verifying-m1a.md docs/known-issues.md
git commit -s -m "test(net): fixtures and verification from real hardware

Fixtures are now output captured from a board rather than written by hand.
Records the on-board procedure: apply, confirm, roll back an unconfirmed
change, and prove the access-point fallback brings a device back when
nothing else is reachable.

R-NET-07"
```
