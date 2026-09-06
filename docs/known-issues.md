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

### K-30 · ~~`yonder-confirm` is registered and used by nothing~~ — CLOSED

R-CFG-11 removed the operator confirmation: joining a network takes the access point off
the air, so the console an operator would confirm from goes with it, and the device answers
the real question itself instead. The wiring that used `yonder-confirm` went with that
change and the node did not — `node-red-contrib-yonder-network` still registers it, and no
flow references it.

It is not harmless. A registered node that nothing uses is a node with no test exercising
it end to end, and the next person to need a confirmation step will find one that has not
been run since the flows stopped calling it. `scripts/verify-pages.sh` used to catch
exactly this and stopped naming it in the same change, so nothing was watching either.

**Closed in `00ba2ca`, by the second half of this entry's own guess.** The way out was a
real caller and not a deletion: an apply that does not move the radio still goes through the
engine's confirmation timer, and until R-UI-15 there was nowhere to see one except the page
the change was made on. Status now carries a `Change pending` banner — the countdown, what
is in force, and `CONFIRM` beside `REVERT NOW` — and `confirm-pending` in
`flows/flows.json` is a `yonder-confirm`. It gained a twin in the same change,
`yonder-revert`, because the banner offers both directions and a node with a mode would be a
wiring diagram that no longer says which one a wire performs.

`scripts/verify-pages.sh` names both again in the list of types the flows must use, so the
thing that stopped watching is watching.

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

### K-33 · Changing the palette does nothing until the page is reloaded

Pressing NIGHT reaches the device and takes effect: the daemon regenerates
`theme.css`, the choice is written to `config.yaml`, and the apply comes back
`confirmed` with no confirmation window (R-CFG-12). Watching the device from
outside the browser while an operator pressed the key showed the palette change
day → night within seconds.

**The open page does not change.** The stylesheet is fetched once, when the
page loads, and nothing re-fetches it when the palette changes. The URL carries
no cache-busting either, so an operator who presses the key sees their console
do nothing at all. The setting is not lost —
it appears on the next reload — but R-UI-05 says show the operator when a
control has taken effect, not merely that it was sent, and this shows them
nothing.

**Why nothing caught it.** `scripts/capture-pages.mjs` presses NIGHT and then
*navigates* to capture the night palette. A fresh page load is exactly what
hides this defect, so the gate that exists to look at both palettes cannot see
it. The same shape of blind spot produced the tab-strip defect fixed in
`d8dd994`: a check that only ever looks at a surface one way.

Not introduced by M2a. Found while proving M2a on a board, because that was the
first time anyone pressed the key and then kept looking at the same page.

**The mechanism described here has since changed, and the defect has not.**
This entry used to name a `ui-template` at `site:style` scope doing an
`@import`. That template is gone: R-UI-22 moved the stylesheet into a `<link>`
in the served document's head, so it now arrives with the first paint instead
of after the app boots. A `<link>` in the head is fetched exactly once too, so
an open page still does not follow a palette change. Whichever fix direction
below is taken, it now applies to that `<link>`.

**Fix direction:** make the palette's arrival at the page observable — a
cache-busted stylesheet URL the theme change updates, or have the console
re-request it — and give the capture gate a case that changes the palette
*without* reloading, or this returns.

### K-34 · ~~Every mesh join and leave failed on a board, and said the wrong thing about why~~ — CLOSED

`POST /remote/join` and `POST /remote/leave` failed deterministically when driven through
the daemon socket on a real board, while every reproduction of the same call by hand
succeeded. Both reported the same sentence:

```
systemctl disable zerotier-one failed: Synchronizing state of zerotier-one.service
with SysV service script with /usr/lib/systemd/systemd-sysv-install.
```

That sentence is a banner `systemctl` prints on a **successful** enable or disable of a
unit that also ships a SysV init script, which is why the reports read as nonsense and why
several days went into hunting a fault in `systemRunner` that was not there.

**What was actually happening.** `yonder-core.service` runs under `ProtectSystem=strict`
with `ReadWritePaths=/etc/yonder /var/lib/yonder`, so the rest of `/etc` is read-only in
the daemon's own mount namespace. `systemctl enable`/`disable` does its unit-file symlink
work in PID 1 over D-Bus, which the sandbox does not touch — but its SysV compatibility
step runs **client-side**, in the calling process. The ZeroTier package ships
`/etc/init.d/zerotier-one`, so `systemctl` also ran `/usr/lib/systemd/systemd-sysv-install`
→ `update-rc.d`, which tried to write the `/etc/rc?.d` symlinks and got EROFS:

```
Synchronizing state of zerotier-one.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.
Executing: /usr/lib/systemd/systemd-sysv-install disable zerotier-one
update-rc.d: error: Read-only file system
```

exit 1. `disable` failed every leave; `enable` failed every join that had to create those
links. Reproduced in a transient unit given nothing but the same two sandbox settings, so
it is the sandbox and not the daemon.

**Why nothing caught it, and why the reports misled.** `said()` in
`src/remote/renderer.ts` reported the **first** line of a command's output. The banner is
line one and the reason is line three, so the one line that named the cause was thrown
away at the point of failure. A diagnostic that keeps the noise and drops the reason is
worse than none: it sent every reader to reproduce a command that works.

Closed with `SYSTEMCTL_SKIP_SYSV=1` on the two `systemctl` calls that change unit files —
Yonder does not manage SysV runlevels, this board boots systemd, and the generator that
would make something of an init.d script skips one that has a unit of its own — so the
step is skipped rather than the sandbox widened. `CommandRunner` grew an optional `env`,
merged *over* the daemon's environment rather than replacing it. `said()` now reports
every line. Both are pinned by tests in `src/remote/renderer.test.ts` and
`src/net/runner.test.ts` that fail against the old code, so this no longer needs a board
to see. R-VPN-01, R-VPN-07.

### K-35 · `yonder-core` binds its socket only after its first render

The daemon renders the whole configuration before it starts listening, so
`/run/yonder/core.sock` does not exist until that render finishes. A render that
takes a while therefore produces a device that systemd reports as healthy and
that nothing can talk to:

```
core: active
socket: ls: cannot access '/run/yonder/core.sock': No such file or directory
journal: nmcli connection up yonder-wifi
```

Seen on a board whose configured Wi-Fi network was out of range: the client
association blocks for about twenty-five seconds, and for all of it
`systemctl is-active yonder-core` says `active` while the console gets
connection refused and shows *the device's configuration service is not
answering*.

The ordering is not accidental — rendering first means a device comes up
already in the state its configuration describes, rather than serving a console
that briefly disagrees with the hardware. But it makes the socket's arrival
depend on the slowest thing in the render, and the slowest thing in the render
is a radio that may be somewhere else entirely.

Worse on the boot where it matters most: the boot after an operator moved the
aircraft, which is exactly when the radio situation has changed and when they
most want the console to answer.

**Fix direction:** bind the socket first and serve a state that says a render is
in progress. The apply engine already distinguishes `applying` from `idle`, so
the interface has somewhere to put that.

### K-36 · The access point is dropped before the client is raised

R-NET-12 is explicit that a client is raised *before* the access point is
dropped, "because the operator submitting those credentials is reaching the
device through the radio being retuned". A board does it the other way round:

```
network: taking the access point down
nmcli connection down yonder-ap
network: bringing the wifi client up
nmcli connection up yonder-wifi
```

With a client that associates, the gap is short and nobody notices. With one
that cannot — an SSID out of range, a changed passphrase — the access point is
down for the whole association attempt, about twenty-five seconds, and then the
apply fails and it comes back. An operator connected over that access point is
disconnected by every attempt, including the attempt to fix the setting that is
causing it.

Found while pressing Join on a console reached over the very radio being
retuned, which is the case R-NET-12's sentence was written about.

### K-37 · ~~A Wi-Fi network that is not in range fails every apply~~ — CLOSED

**Status:** Closed · **Requirement:** R-NET-15

The network renderer runs before the others, so an SSID it cannot associate with
fails the whole apply — including applies with nothing to do with Wi-Fi:

```
POST /remote/join failed: nmcli exited 4: Error: Connection activation failed:
The Wi-Fi network could not be found
```

That request was a mesh join. The board was reachable on Ethernet, serving its
access point, and perfectly healthy; it simply could not be configured at all,
because one stanza of its configuration named a network that had moved out of
range.

The irony is the sharp end of it: the change being refused was the one that
would have given the operator a second way in. A device is least configurable
exactly when its network situation has changed, which is when configuring it
matters.

Note this is not the same as R-NET-07's fallback, which works: the access point
does come back. The device stays *reachable*. What it stops being is
*changeable*.

**One compound of this was closed first.** The network renderer arbitrates the
radio and then re-dials the modem, and the two shared a failure path:
`settleRadio` threw, so `redialModem` never ran. On a board with an out-of-range
network configured that happened on *every* render, so a corrected APN was
written into the modem's profile and never dialled — correcting a mistyped APN,
the recovery action M3a is built around, could not be carried out at all. The
radio step still runs first, for the reason it always did (its failure is what
raises the access point, and R-NET-07 rests on that), but its error is held, the
re-dial runs, and the radio's error is then thrown. A re-dial that also fails is
logged rather than allowed to displace it. Pinned by tests in
`packages/yonder-core/src/net/renderer.test.ts` that fail against the old code.
R-CEL-09, R-NET-07.

**What that first fix did not touch: the render itself still failed.** Every
apply on a board whose configured network had moved out of range still rolled
back, because `settleRadio` rethrew once it had raised the access point again —
a rethrow its own doc comment defended as correct. It measurably was not. An
operator out of range of `Boyd_AP`, meaning to fly on cellular alone, entered a
correct APN and pressed CONNECT; the render threw on the radio, the apply
engine rolled the whole configuration back, and `yonder-modem` was removed.
**The operator lost their cellular configuration to this and reported it as
"the settings did not survive a power cycle"; they had, in fact, never been
written at all.** Confirmed on the board throughout: `wlan0` was `connected` to
`yonder-ap` — the access point had come back up, exactly as R-NET-07 requires —
and the device was reachable the entire time. There was never anything for the
rollback to protect.

**Closed by R-NET-15.** `settleRadio` now decides the render's outcome on
reachability rather than on whether the client associated: if the access point
was never taken down, or raising it again succeeds, the failure is logged in
plain language — that the client did not come up, that the access point is on
the air, and that the change has been kept — and the render returns normally.
Every other subsystem in the same apply stands, including a corrected APN,
which is dialled immediately after. This is R-NET-12's own promise finally
satisfied rather than fought: the access point returning when a change leaves
the radio on no network is treated as the outcome it always claimed to be,
instead of one the renderer failed anyway. Nothing here classifies the failure
by parsing nmcli's error text; a wrong pre-shared key is treated exactly like
an out-of-range SSID, because both are the same fact about the world and not
about the device. Only when the access point itself cannot be confirmed up does
the render still fail, exactly as before. Pinned by tests in
`packages/yonder-core/src/net/renderer.test.ts` that fail against the old code.

### K-38 · A console deploy serves `Cannot GET /` for about half a minute

`installer/roles/30-console.sh` replaces the console tree in place. Between
removing the old dashboard package and the console restarting on the new one,
every request gets a 200 with `Cannot GET /`:

```
16:36:45  Error: ENOENT ... @flowfuse/node-red-dashboard/dist/index.html
16:37:10  [ui-base:Yonder] Dashboard 2.0 (v1.31.0) started at /dashboard
16:37:10  Started flows
```

An operator refreshing during that window sees a bare error page from a device
that was working a moment ago, with nothing to say it is mid-upgrade. It
recovers by itself and needs no action, which is precisely why it is worth
fixing: the failure teaches the operator to distrust a console that was never
broken.

**Fix direction:** stage the new tree beside the old one and swap it in, so the
window is a restart rather than a rebuild.

### K-39 · `docs/configuration.md` promises boot-partition configuration that does not exist

`docs/configuration.md:12` states, in the present tense:

> Drop a `config.yaml` on the boot partition. It is read on first boot and moved
> into place.

Nothing implements this. R-CFG-05 is real and scheduled — `docs/roadmap.md:276`
puts it in M8 — but no code reads `/boot/firmware/config.yaml` today, so an
operator following the documentation gets a device that ignores the file.

Found while trying to use it: an SD card was out of a board precisely because
the board was unreachable, which is the exact situation the feature exists for,
and it was not there.

This is the second documentation divergence of the same kind — the first was a
`remote.tailscale` example that the strict schema rejected, fixed in `f4469ef`.
Both were written as descriptions of a finished system rather than of the one
that exists.

### K-40 · The Pi 4's hardware JPEG decoder advertises MJPEG and cannot be started

`/dev/video10` (`bcm2835-codec-decode`) lists `MJPG` on its output side, so `v4l2jpegdec`
negotiates against it happily. Streaming never starts. The pipeline stalls indefinitely —
not slowly, permanently — and the kernel logs
`bcm2835_codec_start_streaming: Failed enabling i/p port, ret -3` followed by a warning
trace.

This matters because USB cameras hand us compressed frames and nothing else worth flying
with: at 1080p this camera offers MJPEG at 90 fps and raw at 5. Decoding those JPEGs in
software is roughly 50% of one core at 1080p30, and it is the **entire** cost of the video
pipeline — the hardware H.264 encoder beside it adds four points. So the whole of M4's CPU
budget is a workaround for this.

Characterised in [`hardware/usb-camera-on-a-pi-4.md`](hardware/usb-camera-on-a-pi-4.md), so
that nobody looks at that 50% and reaches for the hardware decoder again: it is not a
resolution limit (640×480 fails identically), not a missing parser (`jpegparse` in front
fails faster, with `Internal data stream error`), and not a GStreamer fault — the element
issues the ioctls correctly and the driver cannot enable the port.

Not ours to fix, and not worth working around further. It is recorded because it is
invisible from the outside: the capability is advertised, so every reasonable person will
try it once. Revisit only if a kernel update changes the behaviour, and re-run the
reproduction in that note rather than assuming.

### K-41 · The development board browns out, and nothing in Yonder says so

`vcgencmd get_throttled` on the Raspberry Pi 4 dev board returns `0x50000` — bit 16,
under-voltage has occurred, and bit 18, throttling has occurred — with three undervoltage
events logged in the first two minutes of a boot. The board carries a powered hub, an ELP
USB camera, a Quectel EC25 and, briefly, a DJI camera. The EC25 pulls hard on transmit.

It presents as spontaneous reboots. The board restarted at least twice during the M4
brainstorming session and each time came back on a different address, which cost real time
to chase and was initially mistaken for a wedged pipeline. The kernel also failed to read
the DJI's USB descriptor four times and power-cycled the port twice before enumerating it
on the eleventh attempt — what a marginal supply looks like from the bus side.

Two separate things, and only the second is Yonder's:

- **The bench supply is inadequate.** Not a defect in this repository. Recorded because
  every measurement in
  [`hardware/usb-camera-on-a-pi-4.md`](hardware/usb-camera-on-a-pi-4.md) was taken on a
  board that was browning out, so those numbers are a floor rather than a clean reading,
  and they should be retaken on a supply that holds.
- **Yonder reports CPU temperature and says nothing about supply voltage.** R-SYS-01 covers
  model, load, temperature, memory and uptime. The register that would have explained all
  of the above is one call away and nothing reads it. On a desk a brownout is an
  annoyance; in an airframe it is a reboot in flight, and it presents to the operator as an
  aircraft that went quiet with nothing in any log to say why.

Closed by **R-SYS-09**, added in M4 — encoding video is what pushes the draw up, so M4 is
the milestone that provokes the fault it needs to report.

---

---

### K-42 · ~~The fallback watchdog accepts an address as proof of reachability~~ — CLOSED

**Status:** Closed · **Requirement:** R-NET-07, R-CEL-09

`FallbackWatchdog.check()` asks whether any interface other than the access point holds an
IPv4 address. R-NET-07's own text says "carries traffic"; the implementation weakened it
deliberately, because a connected but idle Ethernet link carries none and is perfectly
reachable, and its comment says so.

Cellular breaks that reasoning. A modem with a wrong APN registers, attaches, takes an
address and installs a route while completing no request — measured, and recorded in the
M3 design's §2. That satisfies this check. A device configured that way from the boot
partition, with no other path, never raises its access point and is unreachable until
somebody pulls the card. Rule 6.

**Closed by:** this commit (Task 8 of the M3a plan), which adds the optional `carrying`
check to `FallbackWatchdogOptions` and requires it — when wired in — to agree before
`check()` treats an address as reachability. Absent, behaviour is unchanged: an address
alone is still accepted, so a daemon assembled without a reach monitor does not become one
that raises its access point on a working device.

---

### K-43 · ~~The modem's interface name is remembered for the life of the daemon~~ — CLOSED

**Status:** Closed · **Requirement:** R-CEL-09, R-CEL-13, R-NET-14

`modemInterface` in `packages/yonder-core/src/daemon/server.ts` caches the net port
ModemManager reports — `if (modemNet !== null) return modemNet;` — because a modem's port
layout is a property of the modem. It is not a property of the *slot*. Once a modem has
been seen, `pathDevices` goes on being handed `wwan0` whatever ModemManager and
NetworkManager now say, so `/reach/state` keeps reporting a cellular path on an interface
that has been unplugged, and the Cellular tab draws a green `READY` lamp over the words
"No modem found".

Visible in `docs/console/capture/network-cellular-without-modem.*.png`, which is why those
two pictures are read with this entry beside them. On a board that never had a modem — the
hardware this was found on — the tab reads `NO MODEM` correctly, so it is a defect about
hardware being *removed* rather than about hardware being absent.

R-NET-14 did not close it, and deliberately. `pathsDown` names a path down only when
NetworkManager lists its interface in a state it knows to be not-up; when a modem is
unplugged neither `wwan0` nor `cdc-wdm0` is listed at all, so nothing has been established
and nothing is claimed. Fixing this means deciding what a daemon should do when the
hardware under a cached reading disappears — re-read on every call, invalidate on a
ModemManager signal, or expire the cache — and that changes reach behaviour, which is a
decision of its own rather than a consequence of this one.

**Closed by:** this commit, which takes the first of those three and states it as R-CEL-13.
`ModemNetPort` in `net/modem/netport.ts` asks ModemManager both questions on every reading
and remembers nothing in order to skip one — not that a modem exists, and not its port
layout either, because those object paths are numbered per run of the service and a stick
swapped across a ModemManager restart would inherit the departed one's port.

Reach behaviour moves in one direction only, and it is the direction rule 6 allows. A path
with no interface is reported `absent`, and an absent path is neither probed nor stood
down — so the old behaviour was *inventing* failure evidence against a `wwan0` that was not
there. `carrying` is a question about paths holding addresses, which a departed modem does
not hold either way, so the fallback watchdog's answer cannot move at all. What is kept is
only the answer to a reading that *did not happen*: a failed or late one falls back to the
last interface actually observed, never to the control port, because probing `cdc-wdm0`
fails on a perfectly good link and three of those stand a working modem down. The reading
is bounded at `MODEM_READ_DEADLINE_MS` for the reason `net/deadline.ts` was written: a
wedged ModemManager answers nothing at all, and asking it on every reading rather than once
is what made that worth bounding.

---

### K-44 · ~~The boot race that deleted the cellular profile~~ — CLOSED

**Status:** Closed · **Requirement:** R-NET-16

Measured on a board: the operator power-cycled a Raspberry Pi with a working cellular
link and correct settings in `/etc/yonder/config.yaml`. Cellular did not come back. It
stayed down until they re-entered the settings by hand from the console.

The boot, from `journalctl -b -u yonder-core -u ModemManager`:

```
15:10:56  systemd: Starting ModemManager.service
15:11:01  yonder-node: network: wifi=wlan0 ethernet=eth0
15:11:01  yonder-node: network: removing yonder-modem        <-- the defect
15:11:02  ModemManager: [modem0] state changed (unknown -> disabled)
15:11:02  ModemManager: [modem0] state changed (disabled -> enabling -> enabled)
15:11:03  ModemManager: [modem0] 3GPP registration state changed (idle -> home)
15:11:03  ModemManager: [modem0] 3GPP packet service state changed (detached -> attached)
...
15:13:15  yonder-node: network: wifi=wlan0 ethernet=eth0     <-- operator re-applies
15:13:16  ModemManager: [modem0] state changed (registered -> connecting)
15:13:17  ModemManager: [modem0] state changed (connecting -> connected)
```

`yonder-core` rendered one second before ModemManager finished probing the modem. A
Quectel EC25 on USB takes several seconds to enumerate and be probed; the daemon does not
wait for it and should not have to.

Verified on the same board afterwards: `nmcli -t -f NAME,TYPE,AUTOCONNECT connection
show` gave `yonder-modem:gsm:yes`, and `connection.autoconnect-retries` was `-1`.
NetworkManager would have dialled the modem by itself at 15:11:03 had the profile still
existed. Nothing else was wrong — the SIM, the APN, the signal and the daemon were all
fine. There is no periodic re-render in this daemon — `setInterval` appears nowhere in
`yonder-core/src` — so once the profile was deleted at boot, nothing restored it until a
human applied a configuration change.

`packages/yonder-core/src/net/renderer.ts` conflated two different questions: *is this
profile wanted*, a question about the operator's configuration, and *can this profile be
generated right now*, a question about hardware. `render()` read "wanted" straight off
`desiredProfiles`'s own output, which gates every profile on a device being present this
instant — so "no modem plugged in this millisecond" was read as "the operator does not
want cellular", and the render deleted their profile. The same hazard reached every
connection this renderer owns, not only the modem — the modem is only where it was
measured, being the one interface that appears seconds after the others.

**Closed by:** this commit, which adds R-NET-16 and gives `render()`'s removal loop a
"wanted" set built from `configuredConnections`, a new function in `net/profiles.ts` that
answers from `config.yaml` alone and takes no `Interfaces` argument to read a device list
from at all. `desiredProfiles` keeps deciding what gets *generated*, still correctly
gated on the interfaces a render can see — only *removal* changed. A profile whose device
is missing is now left exactly as it stands, and NetworkManager's own
`connection.autoconnect yes` with unlimited `connection.autoconnect-retries` — already set
by `modemProfile` for R-CEL-06 — does the rest once the device appears. No wait, no
retry, no timer: the fix is that the daemon stops deleting the profile, not that it tries
to time the deletion any better.

**One gap remains, and this does not close it.** If the modem profile has *never* been
created — a board whose modem was not visible for a single render while cellular was
enabled — nothing generates it until a render happens with the modem present. That is a
real but smaller hole than the one above: it needs a first apply rather than surviving a
reboot, and it is left for a future change.

---

### K-45 · `revert()` does not reboot, and `architecture.md` says it does

`docs/architecture.md` step 5 of the apply cycle reads **"If the timer expires unconfirmed,
revert to last-known-good and reboot."** The engine does not reboot.
`packages/yonder-core/src/apply/engine.ts` `revert()` writes the previous configuration
back, clears the journal, drops to `idle` and re-runs `renderAll(previous)`; `grep -rn
reboot packages/yonder-core/src` finds nothing anywhere in the apply path.

Which of the two is wrong is a real question, not a typo. Re-rendering is the gentler
behaviour and is what the renderers are built for — `settleRadio` skips steps already in the
wanted state, so nothing bounces. But R-NET-07 and R-CFG-03 promise the device comes back by
itself, and a renderer that cannot undo what it did — a driver wedged, a `wpa_supplicant`
in a bad state — leaves a board that a reboot would have recovered and a re-render does not.

Recorded rather than fixed because the answer is a decision. Found while writing the camera
view design, which had leaned on the documented behaviour rather than the shipped one.

---

### K-46 · ~~The camera falls off the USB bus every few minutes~~ — CLOSED

**Status:** Closed · **Requirement:** R-CAM-19

The development board's ELP global-shutter camera disconnected and
re-enumerated repeatedly — eight times in one 43-minute session, four times in
the first nine minutes of another. Every drop was a clean `USB disconnect`
followed about a quarter of a second later by a clean re-enumeration of the
same device. Occasionally a re-enumeration failed outright and the port
latched off with `unable to enumerate USB device`, which needed a reboot.

It was diagnosed wrongly three times, and each wrong answer was plausible:

- **A failing supply.** The board *was* browning out, on GPIO header power left
  over from the Pocket 2 bench work — `get_throttled` reported under-voltage
  live, 48 enumeration failures, and the modem going down beside the camera.
  Moving to a USB-C supply fixed that and gave the board its first
  `throttled=0x0` reading. The camera kept dropping.
- **A hub.** Two devices died 400 ms apart, which looks like shared power
  collapsing — but the hub they share is the Pi 4's own internal one, so there
  was nothing to bypass.
- **A cable or connector.** The signature fits: instant clean disconnect,
  instant clean return, irregular intervals, healthy supply. Reseating it,
  changing ports and swapping the cable all appeared to help and none did.

**The cause is runtime USB power management.** The kernel suspends an idle USB
device two seconds after its last access, and a camera nobody is streaming
from is idle nearly always. On one boot the camera's port had spent **31% of
its life suspended**, cycling in and out; a resume that fails is reported as a
disconnect. The evidence that settles it sat on the same hub throughout: the
EC25 modem's port carries `power/control=on`, has never spent a millisecond
suspended, and has never once dropped. Same hub, same supply, same board.

Tested by writing `on` to the camera port's `power/control`. Its
suspended-time counter froze at that instant — 87 204 ms, unchanged ever since
— confirming the mechanism was off rather than merely quiet.

| | before | after |
|---|---|---|
| watched | 9 minutes | 93 minutes |
| drops | 4 | 0 |
| port suspended | 31% of its life | never again |

The prior rate was about one drop every two minutes, so ninety-three minutes
clean is roughly forty-five expected drops that did not happen. That is the
whole of the evidence and it is enough; it is recorded as an interval rather
than as *the drops stopped* because this fault's history is of plausible
answers that a few quiet minutes appeared to confirm, and two of them survived
longer than this before failing.

Two things worth keeping from how long this took. Every wrong diagnosis was
confirmed by a real fault it happened to explain — the brownout was genuine and
worth fixing on its own. And the asymmetry that solved it was visible from the
first `lsusb`: one device on that hub was dropping and the other never was.

**Closed by:** `installer/roles/15-usb-power.sh`, which writes a udev rule
holding USB video devices out of runtime suspend, matched on the video
interface class rather than on the vendor id of the camera this was found on.

**What is proved, and what is not.** The mechanism is proved: writing `on` to
the port's `power/control` by hand froze its suspended-time counter and bought
the interval in the table above. The *rule* is not. No board has ever run
`installer/roles/15-usb-power.sh`; the development board today has no
`/etc/udev/rules.d/50-yonder-usb-video-power.rules` and every device on it
still reads `power/control = auto`, the runtime write having gone with the
reboot that followed it. Nothing has yet matched a camera on the interface
class and set it at plug-in time, which is the one thing the rule does that
the hand-write did not.

**The rule as first written did nothing at all, and neither did the install.**
Two faults, found on 2026-09-06 by asking the board which of its sysfs nodes
carries which attribute rather than by reading the rule again:

- `bInterfaceClass` exists only on a `usb_interface` node; `power/control`
  exists only on the `usb_device` above it. A rule naming both on one node
  matches nothing. No node on the board carries both — checked, not assumed.
  The rule now matches the interface and writes through `../` to the device.
- `udevadm trigger` sends `change` unless told otherwise, and these are `add`
  rules. The install reloaded the rules and applied them to nothing, so a
  camera already plugged in when the installer ran stayed on `auto` — which is
  every install that matters. The trigger now names `--action=add`.

Both are fixed and the corrected rule is proved on the board against a real
UVC camera — a device `uvcvideo` has bound and `v4l2-ctl` reads formats and
controls from. Its parent went from `power/control=auto` to `on` when the rule
was installed and the `add` path was run, while the hub and both host
controllers correctly stayed on `auto`. `udevadm verify` passes the old rule
and the new one alike, so nothing but sysfs would have caught either fault.

**The `add` rule is now proved against a real camera plugged in after boot.**
2026-09-06: the operator attached the ELP global-shutter camera to a running
board, and `/sys/bus/usb/devices/1-1.1/power/control` read `on` without anyone
touching it — while the hub above it and both host controllers stayed `auto`.
That is the claim this entry said it was owed: a device arriving after boot is
caught by the rule, not merely by an install-time trigger.

**One claim is still owed:** that the setting survives the re-enumeration this
fault consists of. The rule fires on `add`, and a re-enumeration is an `add`,
so it should — but "should" is what the first version of this rule had going
for it too. It needs a drop to happen with the rule in place and the interval
measured afterwards, and no drop has happened since it was installed.

---

### K-47 · The capture gate rewrites every committed day-palette image from a run that checks no credential

**Status:** Open · **Requirements:** R-SEC-10, R-UI-12

`scripts/verify-pages.sh:826` presses the `NIGHT` key through a real browser,
which is the gate's one end-to-end proof that a soft key on this console does
anything at all when pressed:

```sh
node "$REPO/scripts/capture-pages.mjs" \
    --base-url "http://127.0.0.1:$PORT" --password "$PASSWORD" \
    --palette day --artifacts "$REPO/vendor/capture" \
    --press NIGHT >/dev/null 2>&1 || true
```

Three things about that invocation are wrong together, and none of them is
wrong alone.

**It captures every page while it is there.** `--press` is applied *after* the
capture loop (`capture-pages.mjs:313`, `:882`) and there is no `--only`, so this
run photographs all eleven pages — `Camera · setup` among them — and writes each
into `docs/console/capture/` unconditionally (`capture-pages.mjs:641`). It runs
*after* the guarded `capture day`, so the day-palette bytes that end up
committed are this run's, not the checked run's.

**Both R-SEC-10 guards are inert on that path.** It passes neither `--secrets`
nor `--synthetic-cameras`. Without `--secrets`, `deviceSecret()` returns `null`
and the page-HTML credential check is skipped; the guard written to complain
about exactly this — *"`--synthetic-cameras` without `--secrets`: nothing
checked the real credential"* — is gated on `syntheticCameras !== undefined` and
therefore does not fire either. So **committed images can currently be rewritten
by a path that performs no credential check at all**, which is the part that
matters: `Camera · setup` is the page that carries a resolved RTSP password
(R-VID-15), and R-UI-12 commits it.

**And whatever it would have said is discarded.** `>/dev/null 2>&1 || true`
throws away both the output and the exit status, so a failure on this run is
indistinguishable from a pass. The `|| true` is deliberate — the *next* check is
`wait_for_theme night`, which is the assertion this invocation exists to set up
— but it swallows the capture's own verdict with it.

**This is the third instance of the same defect in the same file.** The script's
own comment at `verify-pages.sh:1236` records finding and fixing it twice
before: *"`--secrets`, because these runs write committed images too …
`deviceSecret()` answers `null` without it, which switches off both R-SEC-10
guards … Sixteen images went into `docs/console/capture/` from this function
with neither guard running."* Two invocations were fixed; this one was not
looked at, because it is not in that function and its purpose is a key press
rather than a capture.

**It is one mechanism behind the capture drift** that four separate
runs have recorded as noise — `camera-live-tablet.day.fold.png` and
`status-pending-radio.day.png` after Task 28; `status.night.png`,
`status-psk-changed.night.png`, `camera-live-notebook.day.png` and
`status-pending-radio.night.png` during Task 29 and its review. Six distinct
pages whose shape references never moved and whose bytes did. This entry
accounts for the day-palette base captures: they are rewritten last by a run
whose output nobody reads.

**A first diagnosis of a second mechanism was wrong, and is recorded here so it
is not reached for again.** `camera-live-notebook.day.png` came back byte-
different with identical text and geometry and the whole page uniformly washed
out, and this entry claimed a screenshot taken over a half-written `theme.css`.
It cannot be that. `reach_theme` does only grep the file on disk, but the writer
is atomic — `ConsoleRenderer` goes through `writeFileDurable`
(`fs/durable.ts:32-56`: write `.tmp`, `fsyncSync`, `renameSync`) — so no reader
can see a partial stylesheet and a grep match means the whole file is in place.
The ordering is wrong too: the fold captures do not run straight after
`reach_theme day`. `capture_state`, `capture_without_modem`, `capture_unplugged`,
`capture_status_pending` and `capture_pending_radio` all run first, and both
drifted images came from the *end* of that block — a palette not yet applied
would drift the earliest captures, not the last.

**What is real and adjacent: nothing asserts the palette a page rendered in.**
`capture-pages.mjs` treats `--palette` as a filename label and an expectation
filter, and each invocation is a fresh browser launch. No capture checks that
the page in front of it is actually drawn in the palette its filename claims,
so a run against the wrong one produces a correctly named file with the wrong
picture in it and nothing says a word. That belongs with the fix above: both
are the gate writing a committed artefact from a state nobody checked.

**Not fixed here, deliberately.** It is the gate's own defect and wants its own
change rather than a fix smuggled into a console commit — and the fix has to
answer a question this entry does not: whether the press run should capture at
all (`--only` on one page, or a `--no-capture`), or should simply be given
`--secrets` and `--synthetic-cameras` like its neighbours. In this harness the
daemon is always `scripts/synthetic-daemon.mjs`, so what renders is always the
fixture's `FIXTURE-NOT-A-REAL-PASSWORD` — the hole is that nothing checks, not
that anything has leaked. Every committed capture has been read by eye and by
the guarded run and carries the fixture value.

Found by review during Task 29 (`75f8c46`).

### K-48 · ~~An applied bitrate never reaches the running encoder~~ — CLOSED

**Status:** Closed · **Requirements:** R-VID-07, R-UI-05, R-CFG-03

Found by the operator on the development board, then reproduced at the daemon.

Change a camera's bitrate on Setup, Apply, confirm. `config.yaml` takes the new
value and the confirmation reports `confirmed`. **The running pipeline keeps the
old one.** Measured: config at `bitrate_kbps: 2000` and
`preview.bitrate_kbps: 1350`, while `gst-launch-1.0` was still running

```
extra-controls=controls,video_bitrate=100000
extra-controls=controls,video_bitrate=100000,h264_i_frame_period=15
```

— 100 kb/s on both branches. The pid did not change over the following twenty
seconds and the daemon logged no restart. A manual `POST /cameras/cam0/run
{"action":"stop"}` then `start` picked the new values up immediately:
`video_bitrate=2000000` and `1350000`.

`video/pipeline.ts:170` bakes the rate into the launch line, so today the only
way a new rate can reach the encoder is a respawn. Nothing performs one on an
apply. Until that changes an apply is silently a no-op for the picture, which
is worse than refusing the change.

**Update — the channel is built and it cannot reach today's pipeline.** Plan
Task 30 (`6e1d4e2`) implemented `EncoderChannel` and its supervisor hop. On this
board every retune now answers

> *cam0's pipeline has no control channel: it was started by a program that
> takes no instruction once it is running.*

which is honest, and still not the fix. The reason is worth recording because
it was missed when Task 1's result was accepted: **the spike proved the encoder,
not the runner.** `scripts/spikes/retune-bitrate.py` holds the pipeline itself —
`Gst.parse_launch`, then `enc.set_property("extra-controls", s)` on the live
element — and that handle exists only inside a program that owns the pipeline.
The daemon runs `gst-launch-1.0`, a command-line tool with no property
interface, no socket and no stdin protocol; and `v4l2h264enc`'s controls are
per-open-handle, so no outside process can reach the encoder either. Both facts
had to hold for the retune to work and only one was checked.

**Closed by respawn-on-apply** (`506bbe5`), not by the runtime channel. A
renderer composes the launch line each camera's new configuration implies,
compares it against the line that camera's pipeline is actually running
(`supervisor.argv(id)`), and restarts only where they differ. It never needs to
know which fields matter, so it survives the ffmpeg pivot untouched — and it is
the mechanism the console spec's own control table already named: *"the current
implementation respawns"* for bitrate, *"Pipeline respawn on Apply"* for
resolution.

**Proved on the board**, 2026-09-06:

| | pid | main | preview |
|---|---|---|---|
| before | 1656195 | 1.0 Mb/s | 1.35 Mb/s |
| apply 2600, confirm | 1657114 | **2.6 Mb/s** | 1.35 Mb/s |

The pid moved, the main rate is what was applied, the preview kept its own
value, and the daemon logged *"cam0's settings changed, so its pipeline was
restarted"*.

**And the rollback, which is the half that matters:** applied 4800 without
confirming — pid 1658398 at 4.8 Mb/s — then reverted, and the pipeline came
back at 2.6 Mb/s on pid 1658901. A change that is reverted takes the picture
back with it, which is R-CFG-03 reaching the aircraft rather than only the
file.

The cost is a visible break in the picture on a change the operator deliberately
applied. K-53 remains open for the no-break path, and is now a refinement rather
than a defect.

**One gap left open, deliberately** (found by the implementer, not a test): a
camera in spawn backoff is not reached. `argv()` answers null both for a camera
the operator stopped and for the 1–30 s gap between a failed spawn and its
retry, so an apply — or a rollback — landing in that gap does not move it.
Telling those two apart needs the supervisor to distinguish *stopped* from
*between attempts*, which `argv()` deliberately does not.

**Update — the respawn is built, and it is the sanctioned path.** A live
retune is blocked for as long as `gst-launch-1.0` carries the pipeline, and
the GStreamer composer is being replaced by ffmpeg anyway
(`docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md`), so a
control host built now would be thrown away. The spec's own control table
already says what happens meanwhile — *the current implementation respawns*
for a fixed bitrate, *pipeline respawn on Apply* for a resolution — and a
respawn survives that pivot untouched.

`video/renderer.ts` is that respawn, as a `Renderer`. For each configured
camera it composes the line the applied configuration implies and compares it,
token for token, against the line `supervisor.argv(id)` says the running
pipeline was actually started with. Differ, `stop()` then `start()`; same,
nothing at all. Being a renderer is what buys the confirmation window and the
rollback: a bitrate the operator does not confirm takes the pipeline back with
it, which is R-CFG-03 applied to the picture. It knows which fields matter by
not knowing — nothing in it reads a field name — so a field added to the
launch line is carried with no edit there.

**Two things it does not do, both deliberate.** It never starts a camera that
is not running: Start and Stop survive no apply (R-CTL-01), and a
configuration change must not put a camera on the air that the operator took
off it. And it reaches no camera it cannot see running — `argv()` is null for a
stopped camera and **also null in the gap between a failed spawn and its
retry**, so a camera that is in backoff when an apply lands keeps climbing the
old ladder, and a rollback arriving in that gap does not bring it back. That
window is one backoff step wide (1 s to 30 s) and closing it needs the
supervisor to distinguish *the operator stopped this* from *this is between
attempts*, which `argv()` deliberately does not.

**Not yet proven on the board.** What closes this entry is the measurement
that opened it, run again: change a bitrate on Setup, apply, confirm, and read
`video_bitrate=` out of the running `gst-launch-1.0` command line.

### K-49 · Adaptive is offered, nothing implements it, and choosing it freezes the rate

**Status:** Open · **Requirements:** R-UI-20, R-VID-07

The stream and preview both offer **Fixed / Adaptive**. Selecting Adaptive
makes the bitrate bar read-only — correctly, since in Adaptive the rate is not
the operator's to set — but no rate controller exists to move it (plan Task 31).
The rate therefore stays at whatever value it last held, and no control on the
page can change it.

The development board was found in exactly that state: `stream.mode: adaptive`,
`preview.mode: adaptive`, both at `bitrate_kbps: 100`, with
`preview.floor_kbps: 300`. **The applied rate was below the camera's own
declared floor** and nothing on the page could raise it, which is why every
setting appeared to make no difference to the picture.

Two faults, and they are separable:

- A capability nothing implements is being drawn as a working choice. This
  project has a vocabulary for exactly this (§4's four states): until Task 31
  lands, Adaptive is *advertised* — the control stays, marked inoperative, with
  the reason — not a selectable mode.
- Validation accepted a bitrate below the floor declared beside it. A draft
  whose fields contradict each other is refused with the field named
  (`validateDraft`); this pair is not among the contradictions it checks.

### K-50 · An apply can be left pending for ever, and two routes disagree about it

**Status:** Open · **Requirements:** R-CFG-03, R-UI-05

`POST /cameras/cam0/outputs/rtsp {"enabled": false}` answered

```
{"id": "b23b9f8b-059b-445c-be92-92deb1409f27", "expiresAt": null}
```

`expiresAt: null` — no confirmation window, so nothing reverts it. Every later
apply was then refused with `an apply is already pending; confirm or wait for it
to revert`, while `POST /confirm` with that id answered `nothing is pending
confirmation`. The board could not be configured at all until the state cleared
on its own.

The two answers cannot both be right, and the operator sees the first: a
console that says a change is waiting, with no way to confirm it and nothing
that will time it out. R-CFG-03's whole point is that a change either confirms
or reverts; a third state where it does neither is the one an operator cannot
get out of.

### K-51 · A camera reads *running* while its pipeline is emitting nothing

**Status:** Open · **Requirements:** R-CAM-12, R-UI-05, R-VID-07

Found on the development board while the operator was watching the console.

The camera gadget stopped answering UVC negotiation:

```
uvcvideo 1-1.3:1.1: Failed to set UVC probe control : -75 (exp. 26).
uvcvideo 1-1.3:1.1: Failed to set UVC probe control : -32 (exp. 26).
uvcvideo 1-1.3:1.1: Failed to query (GET_MIN) UVC probe control : 19 (exp. 26).
```

and `v4l2-ctl --stream-mmap` answered `VIDIOC_STREAMON returned -1 (Connection
timed out)`. The device was wedged — three `reset high-speed USB device`
events preceded it, and `power/control` was `on` throughout, so this is not
K-46's autosuspend fault returning.

**What the console said about it: `{"state": "running", "restarts": 0}`.** The
supervisor had a live `gst-launch-1.0` process, so it reported the camera as
running. That process had accumulated **zero CPU time in 58 seconds** at 0.3%,
because `STREAMON` never succeeded and no frame was ever encoded. A working
pipeline on this board sits at 31–41% CPU.

So the one question an operator asks — *is my camera working* — was answered
`running` for a minute while nothing left the aircraft. A process that is alive
is not a pipeline that is delivering, and only the second is worth reporting.
Frames or bytes observed leaving the encoder is the measurement; the presence
of a pid is not.

Recovered by unbinding and rebinding the device
(`/sys/bus/usb/drivers/usb/{unbind,bind}`), stopping the camera first so
nothing held the node. Nothing in Yonder does that today, and R-CAM-19 is about
keeping an attached camera attached — this is the neighbouring case where the
device is attached, enumerated, and not answering.

**Second, smaller gap, same session:** after the pipeline was restarted the
operator had to reload the browser page to see the picture again. `YonderPicture`
draws `RECONNECTING · ATTEMPT n`, so it knows the stream went away, but the
WebRTC session did not recover on its own once the publisher returned.

### K-52 · The ground station's stream has no resolution or frame-rate control

**Status:** Open · **Requirements:** R-CAM-14, R-VID-07, R-UI-20

Found by the operator on the board: the preview has **Size** and **Rate**
pickers; the stream to the ground station has neither. Its resolution and frame
rate are whatever `config.yaml` was flashed with, and nothing on the console can
change them.

**It is specified.** The spec's control inventory (§7) carries the row:

| Control | Kind | Model / config | Mechanism | Proven |
|---|---|---|---|---|
| Resolution | pick | `width`/`height`/`framerate` (exist), options from the probe's formats | Pipeline respawn on Apply | yes |

— options drawn from what the probe actually reported, and the *Proven* column
says the mechanism already works.

**Both ends exist and the control between them does not.** The deck stages
thirteen paths and every one is a preview or a bitrate setting: `name`,
`streamMode`, `streamFloor`, `streamCeiling`, `streamBitrate`, `previewMode`,
`previewSize`, `previewRate`, `previewLadderTop`, `previewLadderBottom`,
`previewFloor`, `previewCeiling`, `previewBitrate`. Nothing stages `width`,
`height` or `framerate`. The daemon accepts all three — its own refusal names
them: *"name one of: width, height, framerate, bitrate_kbps, enabled,
autostart, preview_bitrate_kbps"*. `probeCamera()` has carried the format list
since Task 3, and the page draws it as `CAPTURE FORMATS 10` — a count, with no
way to see which ten or choose among them.

**How it was lost.** Task 28's implementer listed *"`YonderDeck` still has no
Resolution picker"* among its own concerns; it was recorded as deferred in the
plan's ledger and no task picked it up. The plan has no step that adds it, so
the omission survived a task review, two fix rounds and two scoped re-reviews —
none of which was looking for a control that was never written.

The asymmetry the operator sees is not a decision anybody made. It is a control
that fell out, and the reason it stayed out is that a deferred concern with no
owner is indistinguishable from a closed one.

**Two smaller cases of the same shape, worth doing together:**

- `CAPTURE FORMATS 10` states a number and not the formats. R-CAM-14 is about
  offering exactly what the device reported; a count offers nothing.
- The spec's *Live-view resolution (Pocket 2)* row is marked *"yes — the
  handlers are stubs"*. When the Pocket 2 returns to the bench that row needs
  the same picker, against `formats` in its `not-offered` state until it
  answers.

**What it needs:** the picker, fed from the probe's own format list; the three
paths staged into the draft like every other Setup edit; and the respawn on
Apply the spec names — which stays a respawn even after the runtime bitrate
channel (K-48, plan Task 30) lands, because a size or frame-rate change is not
something `extra-controls` can retune.

### K-53 · The video pipeline is run by a program that cannot be spoken to

**Status:** Open · **Requirements:** R-VID-07, R-VID-09

`video/pipeline.ts` composes a GStreamer launch line and `systemSpawner` hands
it to **`gst-launch-1.0`**. That tool plays a pipeline and then answers nothing:
no property interface, no control socket, no stdin protocol. `v4l2h264enc`'s
controls are per-open-handle, so no process outside the pipeline can reach the
encoder either.

Everything that wants to change a running pipeline therefore cannot:

- **A bitrate retune** (K-48). The channel exists and is tested; it answers
  *no control channel* on real hardware.
- **A preview-branch reconfigure** — size or frame rate for the browser alone,
  without disturbing the main stream or a board recording (§8.1).
- **Timestamp continuity as an observation.** The `Ack` reports `continuous`,
  and today it can only be inferred from pid and restart count. The spike
  measured it properly with an `identity` pad probe, from inside.
- **The rate controller** (plan Task 31), whose whole subject is moving a rate
  on a live pipeline.

**Task 1 proved the encoder, not the runner, and that distinction was missed.**
`scripts/spikes/retune-bitrate.py` calls `Gst.parse_launch`, keeps the pipeline
object, and sets `extra-controls` on the live element. Two things had to be true
for a runtime retune to reach production — that the codec honours it, and that
the daemon's runner can address it — and only the first was tested. The spike
was accepted as settling the question for the branch.

**What closes it:** a small pipeline host that replaces `gst-launch-1.0` in
`systemSpawner`. It reads the same argv `compose()` already emits, plays it
through `Gst.parse_launch`, and answers an NDJSON protocol on stdin — the one
`EncoderChannel` already speaks and has tests for. It taps `identity` for pts
continuity so `continuous` is measured rather than inferred, and restarts the
preview branch alone where a reconfigure needs it. The spike is most of its
guts.

It costs `python3-gi` and `gir1.2-gstreamer-1.0` in the installer and the
offline payload, and it replaces the one part of the video path that is known
to work on hardware — so it wants its own task, its own board proof, and a
fallback to the current spawner if the host is absent. It is in no task's file
list in the plan today.

**Sequencing:** plan Task 31 (the rate controller) measures thresholds on a
throttled link and has nothing to measure until a pipeline answers. This should
land before it.

### K-54 · A detected camera cannot be configured from the console

**Status:** Open · **Requirements:** R-UI-03, R-CAM-12

Found by the operator: he attached a second camera, the Cameras page showed it,
and there was no way to do anything with it.

The board detects it correctly. `GET /cameras` returns the row:

```
id=None   name='Global Shutter Camera: Global S'   bus='usb · /dev/video2'   state='Not configured'
```

`id` is `null` by design — `CameraRow`'s own doc says a null id means *detected
on a socket nothing is configured for*, and `cameraIndex()` composes
`state: "Not configured"` for exactly that case. So the model knows precisely
what has happened and says so.

**The page has one soft key: `SWEEP AGAIN`.** Spec §5 names three things the
Cameras page must do — *"Rows open their camera; Detect again; Add by
address"*. The first two exist. The third was never built, and **no task in the
implementation plan owns it**.

There may be two missing actions rather than one, and they should not be
conflated:

- **Add by address** is what §5 names, and it reads as adding a network camera
  by URL — a camera the board cannot detect at all.
- **Adopting a detected camera** is what the operator actually hit: the board
  has already found it, already knows its `by-path` socket, and needs only to
  write a configuration entry for it. Nothing specifies this, and it is the
  commoner case by far — it is what happens every time somebody plugs a camera
  into a flying aircraft's spare port.

The second is cheap: the socket, the card name and the format list are all in
hand at the moment the row is drawn. It wants a name and an id, and both have
sensible defaults (`R-UI-27`'s `Cam N`, and the card name).

**How it was missed** is the same as K-52's, and that is now three of these:
both ends of the feature exist and the control between them was never written,
so no review found it — a task review reads a diff, and nothing in any diff is
missing. Only somebody using the console finds an action that is not there.
