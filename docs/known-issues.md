# Known issues

Real defects and gaps, recorded rather than forgotten. Each says what breaks and when it
starts to matter. Fix them when they become load-bearing, not before — but do not
rediscover them.

Nothing here is a requirement. Requirements live in [`requirements.md`](requirements.md).

**K numbers are stable.** A closed issue keeps its number and is struck through rather than
deleted, because source comments cite these. Never reuse a number — K-14 was briefly reused
for a second issue, and four comments in `src/apply/` were left pointing at the wrong entry.
It happened again when two branches ran in parallel and both reached for K-26; the later one
became K-28 and K-29, because the earlier number was already cited.

---

## Must be resolved during M1

### K-01 · ~~The daemon socket is unreachable by the console~~ — CLOSED

The unit set no `User=` or `Group=`, so the daemon ran as root and the socket was created
`root:root` mode `0660`, inside a `/run/yonder` that was `0750` root. The design says
filesystem ownership is the access control for the configuration API, and nothing expressed
that model: a console running as anything but root could not open the socket at all.

Closed in M1b-1. `systemd/yonder-core.service` carries `Group=yonder` — no `User=`, because
the daemon drives NetworkManager and stays root — so systemd creates `/run/yonder` as
`root:yonder 0750` and the socket the daemon binds inherits that group; the existing
`chmodSync(socketPath, 0o660)` in `src/daemon/server.ts` makes it group-writable.
`installer/roles/10-base.sh` creates the system user and group, and
`assert_unit_accounts` in `installer/lib/common.sh` refuses to enable a unit naming an
account that does not exist — a `Group=` with no group is `status=217/USER` on every start,
which for this daemon is a board with no network at all.

Nothing chowns from code: the unit is the one place this is expressed.

### K-02 · ~~`apply()` has no render timeout~~ — CLOSED

The apply reservation was held for the whole duration of `renderAll`. A renderer that threw
was handled; a renderer that **never settled** pinned the engine in `applying` permanently,
and every later apply was refused with "an apply is already pending". Harmless while there
were no renderers; M1 added the first real one, and a network apply can hang on a wedged
`nmcli` or a driver that never returns.

Closed in `b736d2f`: `renderAll` runs under `renderTimeoutMs`, and exceeding it fails the
apply and rolls the configuration back. What that fix could not do — undo the part of the
render that had already happened, or stop the abandoned renderer still running — is
**K-10**, which is the entry code touching this path should cite.

### K-03 · ~~`SecretStore` trusts the shape of `secrets.yaml`~~ — CLOSED

The constructor cast the parsed YAML `as Bag` without checking it was a flat map of strings.
Safe while `flush()` was the only writer, and not safe once `resolve()` fed a renderer: a
hand-edited nested value would interpolate into a NetworkManager keyfile as
`[object Object]`, producing a broken access point with no error anywhere.

Closed by parsing the document in the constructor rather than asserting its type. A
malformed `secrets.yaml` now throws where it can be reported — which is why `startServer`
guards `buildRenderers` and serves in a degraded state rather than exiting.

---

## General

### K-04 · Test files are never type-checked
`packages/yonder-core/tsconfig.json`

`tsconfig.json` excludes `*.test.ts`, and `npm run lint` uses that config. `vitest` strips
types via esbuild without checking them. So **no CI step type-checks test code at all** — the
gap is total, not partial. A separate `tsconfig.lint.json` without the exclude fixes it while
keeping tests out of `dist/`.

### K-05 · Development dependency advisories
`npm audit` reports several transitive advisories through the pinned `vitest ^2.1.0`
(esbuild/vite). All development-only and outside the runtime dependency closure; the
esbuild advisory needs a dev server this project never runs. Resolve with a deliberate
vitest major bump, and add `npm audit --omit=dev` to CI so the closure that actually flies
is the one being checked.

### K-06 · No request body size limit
`src/daemon/server.ts`

Request bodies accumulate unbounded; 5 MB goes through without complaint. Low severity
behind a root-only socket, but an OOM kill of the configuration daemon on a 512 MB board is
a safety event, not an inconvenience.

### K-07 · The socket has no lock
`src/daemon/server.ts`

Startup unconditionally unlinks any existing socket, including one held by a live second
instance — which would silently steal the configuration API from a running daemon.

### K-08 · `--only` with an unknown role name succeeds silently
`installer/install.sh`

A name matching no role skips every role and exits 0 reporting "done".
`--only 20-yonder-core.sh` (extension included) installs nothing and claims success.

### K-09 · Smaller edges
- `Journal.write` does not clean up its temp file on the error path, unlike `saveConfig` and
  `SecretStore.flush`. Self-heals on the next write.
- `saveConfig` reports "cannot write" when only the post-rename directory fsync failed —
  i.e. after the data actually landed. The message is wrong about what happened.
- The installer copies `*.test.ts` to the target. Excluded from the build, so dead weight
  rather than a defect.
- `require_node` errors under `set -e` if `node -p` ever emits non-numeric output.
- `writeFileDurable`'s leading unlink of the temp path defeats the `wx` exclusivity it
  documents, if two writers ever race the same path. Related to K-07.

### K-10 · A render timeout rolls the configuration back but not the system
`src/apply/engine.ts`

When a renderer exceeds `renderTimeoutMs`, `apply()` restores `config.yaml` to the previous
configuration and then **deliberately skips the rollback re-render** — a renderer that has
just timed out is presumed still wedged, and retrying it would hold the apply reservation
for a second full timeout before failing again the same way.

The consequence is that the file on disk and the running system can disagree. The renderer
may have applied part of the change before it stalled: a NetworkManager connection modified,
a drop-in written, a profile brought up. Nothing undoes that. `config.yaml` says one thing,
`nmcli` says another, and `GET /config` reports the file.

Bounded in practice — the access-point fallback still raises the access point if the board
ends up unreachable, so this is a divergence rather than a lockout. It starts to matter when
the console shows a configuration the board is not actually running, which is the moment
somebody trusts the screen over the radio. The fix is a renderer that can report what it
managed to do before it stalled, or a reconciling render on the next start; the startup
render added for R-CFG-08 already narrows the window to "until the daemon next restarts".

**And the abandoned work keeps running.** `withTimeout` rejects on the deadline but has no
way to cancel what it was waiting for: the renderer's promise is simply dropped. So after a
render timeout the network renderer carries on issuing `nmcli` commands, while `finish()`
has already released the apply reservation — which means a second apply can be accepted and
start rendering *concurrently with the first one that never stopped*. Two renders
interleaving their `nmcli` calls can leave a connection carrying half of each configuration,
which is a worse divergence than the one above and harder to read from the outside. The
reservation is what normally makes that impossible; a timeout is the one path that gets
past it. Fixing this properly means a renderer that takes an AbortSignal and honours it,
which is the same change as reporting partial work, so the two are one piece of work.

### K-11 · The fallback watchdog fires once per daemon start, and never again
`src/net/watchdog.ts`, `src/daemon/server.ts`

`FallbackWatchdog.start()` sets a single timer and `fire()` clears it. It is armed once, in
`startServer()`, and nothing re-arms it — not an apply, not a confirm, not a revert. After
that one check the guarantee is spent for the life of the process.

R-NET-07 is written about the window after `yonder-core` starts, so this satisfies it as
worded. What it does not cover is
the case the requirement exists for: an operator applies a change that takes the board off
the air *after* the window has already elapsed. The apply confirmation timer catches the
unconfirmed case, but a change that is confirmed — or one whose damage appears later than
the render — leaves no watchdog behind it. It starts to matter with M1b, where a console
makes applying changes routine and a device may run for days between restarts. The fix is to
re-arm on every apply and confirm, which is small; it is recorded rather than done because
M1a's exit criterion is the boot path.

### K-12 · The loopback clause in the fallback's reachability check is redundant
`src/net/watchdog.ts`

`check()` filters on both `a.device !== "lo"` and `!a.address.startsWith("127.")`. The second
subsumes the first for every case that can actually occur: loopback is 127.0.0.0/8 by
definition, and an interface literally named `lo` holding a non-127 address is not a
configuration this code will meet. Harmless, and it costs a reader a moment working out
which of the two is load-bearing.

Left as it is deliberately: this is the reachability probe behind R-NET-07, the one
guarantee M1a exists to satisfy, and it is safer belt-and-braces than clever. Worth
collapsing to the address test alone the next time this function is touched for a reason,
not on its own.

### K-13 · One radio, arbitrated — but still one radio
`src/net/profiles.ts`, `src/net/renderer.ts`

**Narrowed in M1b-2, not closed.**

*What it used to say:* `desiredProfiles` handed `ifaces.wifi` to both `apProfile` and
`clientProfile`, and nothing decided which won. The access point was `autoconnect no` and
raised deliberately while the client was `autoconnect yes`, which made "whichever was
activated last" *likely* — a guess written down rather than a design. On the milestone that
put a Wi-Fi form in front of an operator that was not good enough, because the operator is
standing in the failure: they submit credentials over the access point, and the access point
is on the radio being retuned.

*What now decides.* `radioPlan` (R-NET-12) is a pure function of the configuration and
returns an ordered list of activations. Where a client SSID is configured the client wins,
and the plan is **raise the client, then take the access point down** — in that order, so a
board that never associates has not already thrown away the thing the operator is reading
the page on. If the client activation fails and nothing else is on the air, the renderer
raises the access point itself, regardless of what `ap.enabled` says: R-NET-07 is about
reachability, and the fallback watchdog cannot be relied on for this because it fires once
per daemon start and may have spent its shot hours earlier (K-11).

The access point's *profile* is still written in client mode, and deliberately. Deleting it
is the tidier-looking change and it is the one that breaks R-NET-07 — `nmcli connection up
yonder-ap` against a profile nothing created is K-16, a device unreachable until a power
cycle. Only the activation is arbitrated.

**What is still open, and why this keeps its number.**

- **A second virtual interface has never been tried here.** Some chipsets support an access
  point and a client on one radio at once, and that is the eventual answer. This repository
  has not observed it working on a board, and unobserved hardware behaviour does not get
  written down as design. Until it is, joining a network costs the access point.
- **Scanning while the radio is serving the access point is unobserved.** `GET /net/scan` on
  a single-radio board is the ordinary case — the operator is scanning over the very access
  point they are connected through — and whether NetworkManager scans in AP mode, returns a
  stale cache, or refuses outright has not been seen. `scanForNetworks` says so in a comment.
  It is the first thing the hardware run should look at.
- **`network.priority` is still read by nothing.** The ordered egress preference is parsed by
  the schema and carried in every config file; R-NET-06 asks for routing metrics generated
  from it and no code generates any. That belongs to the milestone that does multi-interface
  egress, where a modem, Ethernet and Wi-Fi have to be ranked for real. A configuration key
  that does nothing is worse than an absent one — it invites an operator to set it and expect
  an effect.

### K-14 · ~~A device with an invalid configuration was reachable but not repairable~~ — CLOSED

`apply()` snapshotted the configuration on disk before writing the new one, so a device
whose `config.yaml` no longer validated refused **every** apply, including a good one. The
socket bound, so the device could be reached and diagnosed, but not fixed — only a card
reader or an SSH session could repair it.

Closed in `d53b3cb`: an apply whose snapshot cannot be read falls back to the posted
configuration as the rollback target rather than refusing. Retained here, and not deleted,
because `src/apply/engine.ts` and `src/apply/journal.ts` still cite K-14 when explaining
why that fallback exists.

### K-15 · The access point's DHCP range is not configurable
`src/schema/config.ts`, `src/net/profiles.ts`

`config.network.ap.dhcp` — `start`, `end`, `lease` — has been **removed**. It was written to
`/etc/NetworkManager/dnsmasq-shared.d/yonder.conf`, and that drop-in *is* read; it simply
never won. NetworkManager's `shared` method starts its own dnsmasq and passes it a range on
the command line, which takes precedence over a `dhcp-range` in a conf-dir file:

```
/usr/sbin/dnsmasq … --dhcp-range=192.168.77.10,192.168.77.254,3600 \
                    --conf-dir=/etc/NetworkManager/dnsmasq-shared.d
```

A client that joined a real board was handed `192.168.77.154` — inside NetworkManager's
range, outside the configured `.2`–`.50`. So the setting decided nothing and the file it
wrote was actively misleading, which is worse than an absent key: it invites an operator to
set a pool and expect an effect. Removed rather than documented as inert.

**What is still true** is what R-NET-02 now says: clients of the access point get addresses,
inside the access point's own subnet, because NetworkManager derives that range from
`ipv4.addresses`. Moving `network.ap.address` to another subnet moves the range with it.
That also retired the cross-field check the schema used to carry — a pool cannot be left
behind in an old subnet when there is no pool to leave behind.

**What it would cost to bring back.** Not a drop-in — that has been tried and this entry is
the result. It needs Yonder to run its own dnsmasq: the access point's connection set to a
static address rather than `shared`, our own dnsmasq bound to the wifi interface with our
own pool, our own NAT and forwarding rules to replace what `shared` was doing, a unit to
supervise it, and a restart on every apply that changes the pool. That is a second network
daemon to own on a 512 MB board, and its failure mode is a client that never gets an
address on a device whose only way in is that access point — the exact shape of
unreachability R-NET-07 exists to catch. A configurable pool is a nice-to-have and does not
buy that. Revisit only with a reason that does.

**The upgrade consequence is closed, and it cost a board to find.** A Raspberry Pi seeded by
an earlier build was upgraded past the removal and still carried the `dhcp:` block. The
schema is strict, so every read of its `config.yaml` failed: the network was never rendered,
the fallback watchdog could not read the file either and ran on defaults, and the board was
reachable only because it happened to have an Ethernet cable in it. On an aircraft that is a
card reader. `network.ap.dhcp` is now the first entry in `src/schema/retired.ts` — an
enumerated list of keys this project has removed — so a file carrying it loads: the key is
dropped, the drop is logged naming the key, and the file itself is left alone until
something saves the configuration. R-CFG-09 states the obligation; the loader, the apply
engine and a daemon start-up test gate it. A key nobody retired is still rejected exactly as
before, so a misspelling still fails loudly.

**What that does not close.** The blast radius of an unloadable configuration is smaller —
a file that was invalid *only* because of a retired key is not invalid at all any more — but
nothing about a genuinely invalid one has changed. `apply()` still cannot snapshot a
`config.yaml` it cannot load, so it still substitutes the shipped default as that apply's
rollback target and says so through `previousIsDefault`. An operator who hand-edits a real
mistake into the file still loses their own configuration as a rollback target until they
fix it.

### K-16 · The radio wait gives up once, and the fallback cannot make the profile it needs
`src/net/renderer.ts`, `src/daemon/server.ts`

`waitForRadio()` runs once and is bounded at 30 s. If NetworkManager has not registered
`wlan0` at all by then, the render it triggers never happens, and a render is the only thing
that writes the `yonder-ap` profile. A radio that appears at, say, 35 s is therefore never
rendered against. At 90 s the fallback watchdog fires and runs its only action —
`nmcli connection up yonder-ap` — against a profile that does not exist. It logs
`unknown connection`, and never tries again. **The device is unreachable until a power
cycle**, which on an aircraft means fetching it back.

K-11 covers "the watchdog fires once". This is the other half: the one shot can fail against
something that was never created, and the two together are the failure R-NET-07 exists to
prevent, reached by a route R-NET-07's own wording does not describe.

**Re-arming the watchdog does not fix it, and the obvious version of that change is an exact
no-op.** Re-arming once when `waitForRadio` resolves recomputes the same deadline: `since` is
`startedAt`, so a watchdog re-armed at t=30 s with a 90 s window is armed for t=90 s, which
is when the first one was already going to fire. Re-arming with a *fresh* window only moves
the same command later — the action is still `up yonder-ap`, and the profile is still absent,
because nothing between the two attempts rendered. Both were prototyped against a board whose
radio appears at 35 s: profile absent, activations accepted 0, in every arrangement.

What would close it is a re-render, not a re-arm. Two candidates, both bigger than they look:
render once more when the wait's bound expires rather than only when it succeeds; or let the
fallback's action render before it activates. The second puts a renderer — and up to a full
`renderTimeoutMs` — inside the one path that must always work, which is the trade K-10
already describes going wrong. It belongs with the re-arm-on-apply work in K-11, done
together and deliberately, rather than as a change to M1a's central guarantee made on the way
to merging it.

### K-17 · `radioSettled` is a resolved promise for the whole of start-up
`src/daemon/server.ts`

`radioSettled` is initialised to `Promise.resolve()` and only assigned the real promise after
`renderCurrent()` and `listen()` have both returned. The fallback watchdog is armed before
either. So for the whole of start-up, the `await radioSettled` in the watchdog's `apUp` is a
no-op against a promise that was never about the radio.

The comment on `apUp` says the fallback's action must not run while the render that creates
its profile is still in flight. On a board where recovery and the start-up render are slow
enough that the deadline lands before `listen()` returns, it does exactly that: `apUp` runs
concurrently with an in-flight render, which is what the await was added to prevent. Narrow —
it needs the deadline to land inside start-up, so `network.ap.fallback.timeout` at its 30 s
minimum on a slow board — and it fails in the same direction as K-16, toward an activation
that fails rather than a wrong one that succeeds. Recorded, not fixed: the assignment cannot
simply move earlier without moving the wait itself in front of `listen()`, which is the
ordering `server.ts` argues against at length and for good reasons.

### K-18 · Console sessions do not survive a console restart
`src/console/session.ts`

The session signing key is minted per process and the live-session set is in memory, so
every console restart logs everyone out — and the console is restarted whenever the
configuration is applied, because `settings.js` is generated from it.

This is deliberate ([ADR-0008](adr/0008-the-setup-gate.md)): there is then no session secret
at rest, so someone who takes the SD card cannot forge a session, and a device that restarts
its console on configuration change has no long-lived state to keep consistent. It is
recorded because it is a real thing an operator will notice — apply a network change and you
are asked to sign in again — and because the obvious fix is worse than it looks. Persisting
the key means writing a credential to the card; persisting the sessions means writing a list
of live tokens. Both are new things to protect for the sake of not retyping a password.

If it becomes load-bearing, the shape to reach for is a key derived from the administrator
password hash rather than one stored beside it, so that a card carries nothing a password
does not already unlock.

### K-19 · A failing renderer stops the ones behind it, including the console
`src/apply/engine.ts`, `src/daemon/server.ts`

`renderAll` runs renderers in sequence and stops at the first failure. The network renderer
is first and the console renderer is second, deliberately — a console failure then rolls back
onto a network that was working, rather than one that was never rendered
([ADR-0008](adr/0008-the-setup-gate.md)) — but the consequence in the other direction is that
a board whose NetworkManager is wedged never renders its console either. The start-up
`renderCurrent()` writes no `settings.js` at all on such a board.

Found by writing `scripts/verify-console.sh`, which has no NetworkManager: the daemon logged
`could not render the current configuration, serving anyway` and the console had nothing to
start from. On a real device the installer has already generated a `settings.js`, so this
costs an *update* to that file rather than its existence.

Setting the administrator password is unaffected: that path calls the console renderer
directly rather than through the apply engine, precisely so provisioning cannot be blocked by
the network being broken.

Not fixed, because both obvious fixes are worse. Continuing past a failed renderer would make
`POST /apply` report success having done part of the work, which is the silent-success failure
the degraded check in `ApplyEngine` exists to prevent. Reordering puts the console in front of
the network, which is the ordering rule 6 argues against.

### K-20 · The session cookie cannot be `Secure`, because the access point is plain HTTP
`src/console/middleware.ts`

The console's session cookie is `HttpOnly` and `SameSite=Strict` and is deliberately **not**
`Secure`. There is no certificate a device with no name and no internet connection could
present, so the access point is plain HTTP — and a `Secure` cookie over plain HTTP is never
sent by the browser at all. Setting it would produce a console that accepts a password and
then behaves as though nobody had signed in.

What it costs: anyone already inside the access point's radio range can read the session
cookie off the air, and replay it until the console restarts. They are inside a network whose
passphrase is published (ADR-0007), so they could reach the login page anyway; what the cookie
gains them is skipping it.

Closing it is R-SEC-08 — TLS for the web interface — which needs a certificate story for a
device with no name, and is a later milestone. When it lands, `Secure` goes on the cookie in
the same change.

### K-21 · The console's state directory sits inside the daemon's
`systemd/yonder-console.service`, `installer/roles/10-base.sh`

`yonder-core.service` declares `StateDirectory=yonder` and `yonder-console.service` declares
`StateDirectory=yonder/console`, so one service's state directory is nested inside the
other's. systemd sets ownership on the directories it manages, and the exact behaviour for a
*nested* directory owned by a different account — in particular whether the outer service's
start can reassert ownership over the inner one — has not been checked against a real
systemd. If it does, the console would keep read access and lose write access to its own
`userDir` until its next start.

Three things make this unlikely to bite and none of them proves it does not: the installer
sets `yonder:yonder` on `/var/lib/yonder/console` explicitly, the console unit re-declares it
so its own start re-establishes it, and the console starts after the daemon on every boot.
The case not covered is `yonder-core` being restarted while the console is running.

This has not been observed. It is recorded because it was reasoned about and not tested, and
the first hardware boot is where it would show up — as Node-RED failing to write its own
state, with a permissions error and no obvious cause. Moving the console to
`/var/lib/yonder-console` removes the question entirely and is the fix if it does.

### K-24 · The hostname is set but `/etc/hosts` is not, so every `sudo` does a failed lookup
`src/system/hostname.ts`, `systemd/yonder-core.service`

`HostnameRenderer` runs `hostnamectl set-hostname`, which on Debian does not touch
`/etc/hosts`. That file still carries `127.0.1.1 raspberrypi` from the image, so the moment
the hostname becomes `yonder` nothing resolves it, and every `sudo` on the board prints

    sudo: unable to resolve host yonder: Name or service not known

after a DNS timeout. Observed on the first board this project installed on.

Cosmetic in effect and irritating in practice — it slows every privileged command — but the
fix is not free. `yonder-core.service` is `ProtectSystem=strict` with
`ReadWritePaths=/etc/yonder /var/lib/yonder`, so the daemon cannot write `/etc/hosts` either.
Closing this means a targeted `ReadWritePaths=/etc/hosts`, a pure function that rewrites only
the `127.0.1.1` line, and tests for both — which is why it is here rather than folded into
the change that found it. `assert_daemon_can_write` must be given `/etc/hosts` at the same
time, or the fix reproduces K-19 in a new place.

### K-25 · A control keeps showing a value the device rolled back
`flows/flows.json`, `src/console/renderer.ts`

Change the theme and let the confirmation window expire. The apply reverts — `lastResult.outcome`
is `reverted`, the configuration says `day` again, and the renderer rewrites the palette, so the
page even goes back to the day colours. **The dropdown still reads Night.**

Observed on hardware: `--yonder-theme` resolved to `"day"` while the control's value was `Night`.

Nothing tells a page that an apply it started has resolved. The console is deliberately *not*
restarted for a palette change — that is what keeps an operator signed in through a rollback — so
the widget keeps whatever it last held. The gap is that a rollback is exactly the moment the
operator most needs the interface to be honest about what the device is doing, and instead the one
control they touched is the one telling them the wrong thing.

The fix is a way for a page to learn that an apply reached a terminal state and re-read the
configuration. That is a real piece of work — the apply engine has the state and `GET /status`
already reports it, but no page subscribes to anything today. It belongs with whatever milestone
makes the console reactive rather than poll-and-hope, and it should be built once for every
control rather than patched onto the theme dropdown.

### K-26 · ~~The scan list looks tappable and is not~~ — CLOSED

"Networks in range" was a `ui-table` with `selectionType: "none"` and no output wire, beside a
join form whose SSID field was free text. The scan told you the name and then asked you to type
it back. Reported from a phone on the access point: scan, tap a network, nothing happens.

It was filed here as a design matter and that was wrong. The reason to scan is not knowing the
name, so a scan you have to transcribe is the feature defeating itself — and the device most
likely to be holding this page is a phone, where a mistyped SSID costs five minutes of no access
point while a doomed apply rolls back.

The obvious fix was unavailable: `ui-form` cannot be pre-filled from a message — `beforeSend`
handles `ui_update` for `label`, `options` and `dropdownOptions` only, and `passthru` is forced
off — so a tappable table could not have filled the box. What a form *does* accept is
`ui_update.dropdownOptions`.

Closed in `eb8ac49`'s successor: the SSID field is a dropdown, `ssidOptions` in
`src/net/scan.ts` turns a scan into its options, and `yonder-scan` gained a second output that
carries them. One scan feeds both the table and the dropdown, because on a single-radio board a
scan retunes the radio the operator is connected through (K-13) and doing it twice for one button
is doing it once too often.

The table stays, and stays unclickable: it is the readable list, with signal strengths, that tells
you which of two identically-named networks you are standing next to.

### K-22 · The diagnostics probe refuses IPv6 addresses
`src/diag/probe.ts`

`isProbeHost` accepts an IPv4 address or a DNS hostname and nothing else, so
`ping 2001:db8::1` from the diagnostics page is refused as "not a host name or an IPv4
address". On an IPv6-only cellular network — which exists, and which is exactly the network
this device is most likely to be on — that makes the ping tool useless for the addresses
that matter.

Deliberate rather than overlooked. The value goes on a command line, and the rule that
stops `-i0.001` being read as a flag is the same rule that rejects a colon; a validator
loosened to admit IPv6 without someone having thought carefully about IPv6 is how the thing
it was written to stop gets through. Closing it means an IPv6 literal test worth trusting,
`ping -6`, and a board to try it on.

### K-23 · An operator's own flows are replaced on every install
`installer/roles/30-console.sh`

`flows.json` is copied from the repository over whatever is on the device, every time the
installer runs. That is right for a shipped artefact — an upgrade that installed new nodes
and left the old pages behind would be an upgrade that did nothing visible — and it is the
same treatment `settings.js` gets, which is rewritten on every apply.

What it costs is that the flow editor is not a place to keep work. An operator who builds
something in it loses it at the next install, with no warning beyond a line in the
installer's output. The shape of a fix is a separate flow file for an operator's own flows,
which Node-RED does not offer directly, or a deliberate "keep mine" prompt the installer
cannot ask on an unattended image build.

### K-28 · ~~The instrument widgets have never been rendered by Dashboard~~ — CLOSED

`node-red-dashboard-2-yonder` ships five widgets — gauge, tape, annunciator, data bar and
soft keys — and **not one of them has been drawn by Dashboard 2.x.** What is verified is
the half that runs in Node-RED: the nodes register, they read their editor forms, they
register with their group, and a malformed field makes a node error rather than a throw
(21 tests). What is *not* verified is everything on the page.

Specifically unproven:

- That the `node-red-dashboard-2` manifest is discovered at all. Dashboard finds
  third-party widgets by the package name `node-red-dashboard-2-*` and reads `output` and
  `component` from that block; the package is named for it and the manifest is written to
  the documented shape, but nothing here has watched Dashboard load one.
- That `vue` and `vuex` resolve to Dashboard's own copies at runtime. Both are external in
  the bundle, so a mismatch shows up as a component that mounts and reads an empty store —
  drawing an empty instrument on a page where everything else works.
- That the injected `$socket` and `$dataTracker` behave as the components assume, and that
  `widget-action` from the soft keys arrives as a node output.
- That the CSS folded into each bundle survives Dashboard's own styling, and that the
  `--yonder-*` custom properties from the generated stylesheet reach a scoped component.

The rendering was checked in a browser against a standalone reproduction of the same
markup and CSS, which is why the layout and the palette are worth anything at all — but a
reproduction is not the runtime, and this entry exists so nobody mistakes one for the
other.

**Closed.** The pages were rebuilt on the instrument library and the capture gate now
photographs every widget in both palettes on every run. Getting there took four separate
failures, none of which any test in this repository could have found, and all four are worth
recording because each produced *a page that rendered nothing and said nothing about why*:

1. **Every added node had no `z`.** `ui-page` is a config node and carries none, so reading
   one to find the tab id yielded `undefined`. Node-RED never instantiates a node that is on
   no tab — no error, no warning, no "unknown type". `flows.test.ts` now asserts it.
2. **Dashboard discovers a widget package from the *user directory's* `package.json`**, by
   dependency name, resolving it at `<userDir>/node_modules/<name>`. A package present in
   the console tree's `node_modules` — which is where Node-RED finds the *nodes* — is
   invisible to that scan. The installer now writes that manifest.
3. **The bundles were built into `dist/`.** Node-RED serves a package's static assets from
   `<module>/resources`, which is the URL Dashboard asks for, so every widget instantiated
   and the browser quietly collected 404s.
4. **The UMD global was wrong.** Dashboard resolves `window[widgetType][componentName]`; a
   bundle exposing the component as its own global fails a check *inside Dashboard's own
   bundle* and surfaces as `TypeError: Chaining cycle detected for promise` — an error that
   names nothing and blames nobody.

Two more only a picture could have caught: `vuex` as a UMD external resolves to `undefined`
because Dashboard puts no `Vuex` on the page (the store is reached through `$store`), and
`theme.ts` defined none of the instrument tokens, so both palettes fell back to the
components' night defaults — a **dark instrument on a day board**, which is the exact failure
R-UI-07 exists to prevent and the one nobody notices in a lab at night.

### K-29 · ~~The pages violate the language they are now measured against~~ — CLOSED

The capture gate found six violations of ADR-0009 on its first run, and they are recorded in
`docs/console/accepted-violations.json` so that new ones fail while these do not:

- **Four actions spanning 100% of their surface** — `Refresh`, `Scan for networks`, `Yes, I
  can still reach it`, `Check reachability`, each 588 px of 588 px. R-UI-10. This is not a
  styling slip: a stock `ui-button` is a whole row of its group and cannot be smaller than
  one, so no stylesheet reaches it.
- ~~**Two forms clipping their own content**~~ — **fixed.** The join form hid 72% of 172 px
  in 48 px and the ping form 57% of 112 px in 48 px, so on the join form the operator saw the
  SSID field and neither the Join nor the Clear button — immediately after reading the warning
  that pressing Join would take the page away.

  The K-13 fix had been named after *prose*, so it covered markdown widgets and stopped;
  forms had the identical problem for the identical reason. `theme.ts` now unclips **any
  widget whose height is a function of its content rather than of its shape**, and the form's
  own inner box as well — the widget growing does nothing if what is inside it still scrolls,
  and only one of those two is visible in a stylesheet diff. `theme.test.ts` asserts it per
  widget type, because one assertion over a combined selector would pass while a type was
  quietly dropped from it. The join form now renders at 588×172 and the ping form at 588×112.

- ~~**Four actions spanning 100% of their surface**~~ — **fixed.** Not a styling slip and no
  stylesheet reached them: a stock `ui-button` is a whole row of its group and cannot be
  smaller than one. All four are now keys on a soft-key rail, and `flows.test.ts` asserts
  that no `ui-button` comes back.

**Closed.** `docs/console/accepted-violations.json` is empty, which is what closes this: the
gate has no accepted violation left to hide behind. One defect the rebuild exposed and fixed
on the way: a reading of `null` became `Number(null)` — zero, and finite — so a board with no
thermal sensor drew **0.0 °C**, which says *cold* rather than *not there*. `facts.ts` is
explicit that absent is null and never zero; the components were the other end of that rule
and had it wrong.

### K-30 · `yonder-confirm` is registered and used by nothing

R-CFG-11 removed the operator confirmation: joining a network takes the access point off
the air, so the console an operator would confirm from goes with it, and the device answers
the real question itself instead. The wiring that used `yonder-confirm` went with that
change and the node did not — `node-red-contrib-yonder-network` still registers it, and no
flow references it.

It is not harmless. A registered node that nothing uses is a node with no test exercising
it end to end, and the next person to need a confirmation step will find one that has not
been run since the flows stopped calling it. `scripts/verify-pages.sh` used to catch
exactly this and stopped naming it in the same change, so nothing was watching either.

**Closes when** either the node is removed with its route, or something uses it again — an
apply that does not move the radio still goes through the engine's confirmation timer, so
there may be a real caller here rather than a deletion.

### K-31 · The network dropdown's label is red before anything is scanned

`join-ssid` is a required `ui-dropdown` with no options until a scan fills it, and Vuetify
paints an empty required select in its error colour. So a page an operator has only just
opened labels "Network" in red — shouting about a list they have not asked for yet, in the
one place the console should look calm.

The generated stylesheet quietens the field outline and the helper text; the *label* still
comes through red, because Vuetify resolves it from `--v-theme-error` rather than from a
class the theme can reach, and setting that variable per widget needs the palette to carry
RGB triplets it does not have.

**The worse half of this is fixed.** The message also *escaped its widget* — a 48px box
with 70px of content — and the password field, four pixels below, was painted over the top
of it. The theme now sizes a dropdown to its content the way it already did for prose and
forms, and the capture gate looks for content that spills as well as content that hides,
which it did not before. That was found by eye on a running console, which is the check
the gate is meant to make unnecessary.

What is left is cosmetic. **Closes when** either the palette gains the triplets Vuetify
wants, or the dropdown stops being `required` until a scan has run — arguably the truer
fix, since before a scan there is nothing to require.

### K-32 · ~~Choosing a palette applied, then undid itself~~ — CLOSED

R-CFG-11 removed the operator confirmation, because joining a network takes the access
point off the air and the console you would confirm from goes with it. The device verifies
a *radio move* for itself and confirms on that evidence.

Nothing else was verified by anything. A theme change does not move the radio, so it went
pending and the timer reverted it two minutes later — and there was no longer any control
on the console able to confirm it. An operator chose a palette, watched it take, and
watched it undo itself. Reported by eye; nothing in the suite could see it, because every
test that confirmed an apply called `confirm()` directly.

Closed by R-CFG-12. The confirmation window is the price of R-CFG-03's guarantee that a
device comes back by itself, and a change that touches nothing reachable has nothing to
guarantee. `affectsReachability` compares the whole document with only the interface's
appearance removed — *everything is reachable until proven otherwise* — so a field added
to the schema later is load-bearing by default rather than silently exempt. Getting that
bias backwards costs a device nobody can reach; getting it this way costs a palette that
reverts, and only one of those is recoverable from a chair.

The harness saw it too, once it stopped hiding: `verify-pages.sh` restored the default
palette with `|| true` after capturing, so a run that failed to restore reported nothing
and left a held console in the night palette.
