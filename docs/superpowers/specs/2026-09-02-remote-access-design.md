# Remote access — design

**Milestone:** M2 · **Date:** 2026-09-02 · **Status:** agreed, not yet planned

[ADR-0004](../../adr/0004-zerotier-primary-mesh-vpn.md) settles that ZeroTier is the
primary mesh VPN and Tailscale the supported second. It does not settle how a join is
represented, how the clients get onto a board with no network, where a Tailscale key comes
from, or whether a join belongs behind the confirmation timer. This document settles those four
and where the result lands in the console, and records the evidence each was decided on.

Everything below was measured on a Debian 13 (trixie) arm64 board running
`zerotier-one 1.16.2` and `tailscale 1.94.2`, on 2026-09-02. Where a status word or a
number appears here, it was read off that board, not off a vendor's documentation.

---

## 1. Joined, waiting to be authorised

A ZeroTier device joins a network in seconds and then sits there until a human approves it
in the controller. That is neither a failure nor a success, and the console must not
pretend it is either.

### What the client actually reports

Joining a private network the controller knows about, with the device not yet authorised:

```
t+2s   9fef8a3bf9000001              02:9f:ef:73:00:73 REQUESTING_CONFIGURATION PRIVATE ztuqliuo7y -
t+4s   9fef8a3bf9000001              02:9f:ef:73:00:73 ACCESS_DENIED            PRIVATE ztuqliuo7y -
       ... unchanged at t+30s ...
```

Authorising the member, then polling:

```
t+2s   9fef8a3bf9000001 yonder-probe 02:9f:ef:73:00:73 OK                       PRIVATE ztuqliuo7y 10.147.20.26/24
```

Three facts follow, and all three shape the design:

- **`ACCESS_DENIED` is reached in about four seconds and is stable.** It is an exact,
  early, unambiguous signal that the controller was reached, knows the network ID, and is
  waiting for a person. It is the state to build the screen around.
- **Authorisation propagates in under two seconds.** Polling is sufficient. The operator
  never has to come back to the console and re-trigger anything.
- **The network's name is empty until the device is authorised** — `""` under
  `ACCESS_DENIED`, `yonder-probe` under `OK`. The console cannot name the network the
  device is waiting on, only its ID.

### What the console does

A state of its own — not a warning, not a fault, not a spinner. It carries the ten-hex
node address, because that is the single thing the operator must transfer to the
controller, and a copy control beside it:

```
remote · zerotier

  WAITING FOR YOU TO APPROVE IT

  this device   9fef8a3bf9      [copy]

  Approve this number on ZeroTier's website.
  The device will connect as soon as you do.
```

**Nothing times out and nothing is reverted while a device waits.** A week in this state is
a correct outcome, not a stall. See §4 — this is the same decision as the confirmation one,
seen from the other end.

### Before any of that: the operator has to enter the network ID

R-VPN-01 requires join, leave and status *from the interface*, and none of the states above
exist until somebody supplies a 16-hex network ID. The tab therefore has four states, not
one, and the waiting screen is the third of them.

```
NOT CONFIGURED
  network ID   [ 16 hex characters ]         [ JOIN ]
  Find this on your network's page in ZeroTier.

JOINING…
  network      9fef8a3bf9000001
  (see §1's give-up: this state is also where a wrong ID lands, silently)

WAITING FOR YOU TO APPROVE IT
  network      9fef8a3bf9000001
  this device  9fef8a3bf9        [copy]
  Approve this device on ZeroTier's website. It will
  connect the moment you do, and wait as long as it takes.
                                             [ leave ]

CONNECTED   10.147.20.26
  network      9fef8a3bf9000001
  this device  9fef8a3bf9        [copy]
                                             [ leave ]
```

`JOIN` is the tab's one primary action, and it exists only in the first state (R-UI-10).
Once joined there is no primary action at all — `copy` and `leave` are both secondary, and
`leave` is the destructive one, so it is never the biggest thing on the surface.

The field writes `remote.zerotier.network_id` and goes through apply and rollback like any
other configuration change (§4). Nothing is stored anywhere else: the ID is not a secret,
so unlike Tailscale's key it lives in `config.yaml` rather than `secrets.yaml`.

**The ID is validated for shape before it is applied: exactly 16 hexadecimal characters.**
That is worth doing precisely because of §1's give-up. A wrong ID produces no error from
the client at all — it sits in `JOINING` forever — so the last chance to catch a mistyped
one is before it is sent. Shape validation catches a dropped character, an extra one, and a
letter past `f`; it cannot catch a well-formed ID for a network that does not exist, and
that residue is what §1 records.

A device configured headlessly from the boot partition (R-CFG-05) arrives with the ID
already set and simply starts in `JOINING`. The field is then showing what is configured,
not an empty box.

### Tailscale is the same shape

`tailscale status --json` reports a `BackendState`, and it has the same three-part life
plus one extra step at the front, so one console component serves both clients:

| | ZeroTier `.status` | Tailscale `.BackendState` |
|---|---|---|
| nothing configured | *(no entry)* | `NoState` / `Stopped` |
| needs a key first | — | `NeedsLogin` |
| joining | `REQUESTING_CONFIGURATION` | `Starting` |
| **waiting for a human** | `ACCESS_DENIED` | `NeedsMachineAuth` |
| connected | `OK` | `Running` |

### What this gives up

**A mistyped network ID is indistinguishable from a controller that cannot be reached, and
both look like an ordinary join that has not finished yet.** Joining `1234567890abcdef` —
a network that does not exist — does *not* produce `NOT_FOUND`. It sits at
`REQUESTING_CONFIGURATION` and stays there:

```
t=20s: 1234567890abcdef  ee:52:44:1a:43:af REQUESTING_CONFIGURATION PRIVATE ztnksp3nl7 -
```

Only elapsed time separates "still handshaking" (normally two to four seconds) from "that
ID is wrong" and from "this board has no route out". The console shows `JOINING` for all
three and does not guess between them.

This is a deliberate give-up, taken to keep the waiting screen honest: a console that
cries "wrong network ID" at ten seconds would be wrong every time a board's uplink was
merely slow, and being wrong about that is worse than being quiet. It is recorded here
rather than left to be discovered. R-VPN-06 carries it.

---

## 2. Installing without a network

### Evidence

Neither client is in Debian. Both are published from the vendor's own apt repository, and
they are not remotely comparable in what they cost to carry:

| | `zerotier-one` 1.16.2 | `tailscale` 1.94.2 |
|---|---|---|
| `.deb` size | 2,806,628 B | 32,794,648 B |
| declared `Depends` | `adduser`, `libstdc++6 (>= 5)`, `openssl` | `iptables` |
| actually pulled in on a clean board | nothing — all three were present | `iptables`, `libip4tc2`, `libip6tc2` (~8.6 MB) |
| side effects | none | switches the system-wide `update-alternatives` for `iptables`, `ip6tables`, `arptables` and `ebtables` |

So the primary client is one small file that lands on a stock board with nothing else;
the second is a dependency tree plus a system-wide packet-filter change.

### Decision

**The payload carries ZeroTier. Tailscale is fetched over the network.**

`make-payload.sh` gains a ZeroTier step beside the Node one. Tailscale is installed by a
role that runs only when Tailscale is configured, and which requires a network — an
operator reaching for the second option has already chosen something less ordinary, and by
then the board has connectivity.

### How it is verified

The existing Node step pins a version, fetches the published checksum list, matches the
exact filename, verifies, and refuses to unpack on a mismatch. ZeroTier supports something
strictly better, because it signs its repository index. Both are used:

```
ZEROTIER_VERSION=1.16.2
ZEROTIER_SHA256=e6c71707d8db57dd9bc6d6a4d5d5b8343ad244f48ff1ebd288f5f588fbdb10a4
```

1. Verify the signature on `dists/trixie/InRelease` against ZeroTier's public key, carried
   in this repository.
2. Take the SHA256 of `main/binary-<arch>/Packages` from that verified index and check it.
3. Take the SHA256 of the `.deb` from that `Packages` file, matched on the exact filename.
4. Check the downloaded file against both the recorded constant and the value from the
   index. Refuse to stage it on any mismatch.

The two halves do different jobs and neither replaces the other. The recorded constant is
what a reviewer sees in a pull request when the version is bumped, and it is what makes two
payloads built a week apart identical — the reasoning already written into
`make-payload.sh` for Node. The signature is what catches the case a recorded constant
cannot: the download site itself being tampered with, since the constant would have been
read off that same site when it was written down.

Verified on the board, so this is known to work and not merely assumed:

```
gpgv: Signature made Wed 27 May 2026 17:21:34 BST
gpgv:                using RSA key 74A5E9C458E1A431F1DA57A71657198823E52A61
gpgv:                issuer "contact@zerotier.com"
gpgv: Good signature from "ZeroTier, Inc. (ZeroTier Support and Release Signing Key) <contact@zerotier.com>"
```

Key: RSA 4096, fingerprint `74A5 E9C4 58E1 A431 F1DA  57A7 1657 1988 23E5 2A61`, 3,175
bytes. It is committed to the repository, not fetched at build time — a key fetched from
the host it authenticates proves nothing.

The plain fingerprint check is not theatre. The first Tailscale fetch during this
investigation used a wrong pool path, received an HTML error page, and was caught
immediately:

```
tailscale_1.94.2_arm64.deb: FAILED
E: Invalid archive signature
```

### The service must not run until it is configured

**Installing the package is not neutral.** `zerotier-one` enables and starts itself, and
with *zero networks joined* the daemon already holds live sessions with ZeroTier's root
servers:

```
200 listpeers 778cde7190 103.195.103.66/9993;698;10706  26 PLANET
200 listpeers cafe04eba9 84.17.53.155/9993;-1;10619    114 PLANET
200 listpeers cafe80ed74 185.152.67.145/9993;-1;4973   727 PLANET
200 listpeers cafefd6717 79.127.159.187/9993;-1;4887   813 PLANET
```

An aircraft that talks continuously to a company's infrastructure because a package is
merely present contradicts the first thing this project claims about itself. So the
installer stops and disables the unit after installing it; `yonder-core` starts it on
apply, only when a network ID is configured, and stops it again on leave. That is what
R-VPN-05 has to mean in practice, and R-VPN-08 says so.

---

## 3. Tailscale keys

### Evidence

- A key is generated by an administrator at Tailscale's admin console, on the Keys page.
- An auth key lasts **90 days at most**, and a one-off key is revoked the moment it is
  used. It is spent at first join and is not what keeps the aircraft connected afterwards.
- What keeps the aircraft connected is the device's **own** key, and that expires after
  **180 days by default**, after which the device stops working until somebody
  reauthenticates it.
- **A device authenticated with a tagged key has key expiry disabled by default.**

That last point is the whole problem, solved at the moment the key is generated rather
than six months later in a field.

Measured behaviour of the client:

- A bad key fails synchronously and says so: `backend error: invalid key: API key does not
  exist`, exit status 1, and the backend stays at `NeedsLogin`. Nothing is left
  half-configured.
- `--auth-key` accepts a `file:` prefix — `--auth-key=file:/path/to/key`.
- `--timeout` **defaults to `0s`, which blocks forever.** A naive `tailscale up` inside an
  apply would hang the daemon.
- `tailscale status --json` is readable by an unprivileged user; mutating operations are
  refused with `Access denied: prefs write access denied`. `zerotier-cli`, by contrast,
  needs root — `authtoken.secret` is `0600 zerotier-one:zerotier-one`. This does not
  constrain the design: `yonder-core` runs as root already (its unit sets `Group=yonder`
  and no `User=`), and the console, which runs as `yonder`, reaches both only through the
  daemon.

### Decision

**The console tells the operator to generate a tagged key, and afterwards reports what the
device's access actually expires.**

```
remote · tailscale        NOT CONNECTED

  Needs a key from your Tailscale admin page:
     console.tailscale.com/admin/settings/keys

  Generate a TAGGED key. A tagged device never
  expires; an untagged one stops working after
  180 days, wherever the aircraft happens to be.

  key:  [ ................................ ]

---- once connected ----

remote · tailscale        CONNECTED  100.87.4.19
  access expires   never  (tagged)
```

One extra word in the instruction removes the 180-day trap. An operator who ignores the
advice still sees the date and can act on it, rather than discovering it in the field.

The admin host is named in one place in the code, not scattered through the interface: it
is a vendor URL and vendor URLs move. `console.tailscale.com/admin/settings/keys` answers
today; `login.tailscale.com` redirects to it.

The key is **not** rejected for being untagged. R-CFG-06 is explicit that a device is never
left unusable for want of a credential, the tag cannot be checked before the key is spent,
and refusing a key the operator deliberately chose is not Yonder's call.

### Handling

The schema already has the right shape (`docs/configuration.md`):

```yaml
remote:
  zerotier:  { enabled: false, network_id: null }
  tailscale: { enabled: false, auth_key: { secret: ts_authkey } }
```

The key lives in `/etc/yonder/secrets.yaml`, mode `0600`, and is handed to the client as
`--auth-key=file:…` — never on a command line, which any other process on the board can
read from `/proc`. `--timeout` is always set. The key is never logged, in line with the
redaction the network renderer already does.

When the device's access does expire, the console says so and names the date. **Yonder does
not reauthenticate by itself.** It has no valid key to do it with, and originating that
action is not its job.

---

## 4. A mesh join is confirmed by the device, immediately

### The question

R-CFG-11 exists because moving the radio costs the operator the console. A mesh join does
not obviously do anything of the kind, so the confirmation timer should not be inherited
without deciding.

### Evidence

Routes before joining anything:

```
default via 10.0.252.1 dev eth0 proto dhcp src 10.0.252.246 metric 100
10.0.252.0/24 dev eth0 proto kernel scope link src 10.0.252.246 metric 100
192.168.77.0/24 dev wlan0 proto kernel scope link src 192.168.77.1 metric 600
```

A network was then configured on a controller to push three routes, deliberately including
one overlapping the board's own LAN, and the device was joined and authorised:

| pushed by the controller | result |
|---|---|
| `10.147.21.0/24` — the mesh's own subnet | installed |
| `172.31.0.0/16 via 10.147.21.1` — somewhere unreachable otherwise | installed, metric 5000 |
| `10.0.252.0/25 via 10.147.21.1` — **overlapping the operator's own LAN** | **refused** |
| `10.99.99.0/24`, no gateway | not installed |

Routes after:

```
default via 10.0.252.1 dev eth0 proto dhcp src 10.0.252.246 metric 100
10.0.252.0/24 dev eth0 proto kernel scope link src 10.0.252.246 metric 100
10.147.21.0/24 dev ztuqliuo73 proto kernel scope link src 10.147.21.26
172.31.0.0/16 via 10.147.21.1 dev ztuqliuo73 proto static metric 5000
192.168.77.0/24 dev wlan0 proto kernel scope link src 192.168.77.1 metric 600
```

The default route, the LAN route and the access-point route were untouched throughout, and
the session driving the test never dropped. The client's own conflict guard refused the one
push that could have taken the console away. `allowDefault` is `false`, `allowGlobal` is
`false` and `allowManaged` is `true` by default; Yonder never turns `allowDefault` on.

**A mesh join only ever adds a path. It cannot remove the one the operator is using.**

### Decision

**The join goes through the ordinary apply path, and the device confirms it itself,
immediately.**

This needs no new concept. R-CFG-11 already says a change the device can verify for itself
is confirmed by the device; joining a Wi-Fi network is called out there as the case that
matters, and this is another case of the same rule. The device verifies the one thing it
genuinely can — the join was accepted and the client is running — which is true within
seconds.

```
apply
  │
  ├─ join accepted, service running?
  │     yes → confirmed by the device, at once
  │     no  → rolled back, reason shown
  │
  └─ approval by a human is NOT waited for
```

Three things fall out of it:

- A genuinely broken configuration — malformed network ID, client not installed, service
  refuses to start — still fails and rolls back like anything else. Dropping the timer
  altogether would have given that up too.
- There is no carve-out for a reviewer to discover later. One apply path, one rule.
- **It protects the screen in §1.** A real countdown would tear down "waiting for you to
  approve it" before the operator had finished walking to their laptop. Waiting for a human
  is the ordinary case here, not the rare one, and a window budgeted for a change somebody
  watched happen would revert a perfectly good configuration. §1 and §4 are the same
  decision seen from two ends.

R-VPN-07 carries this.

---

## 5. Requirements to add

Rule 3: these are added to `docs/requirements.md` in the same change that implements them.
IDs continue the R-VPN block, which currently ends at R-VPN-05.

| ID | Requirement | P |
|---|---|---|
| R-VPN-06 | **Joined but not yet authorised is a state in its own right, and the interface says so.** Where a mesh requires a person to approve a device, the interface names that state as neither a fault nor a connection, shows the identifier that must be approved with a means of copying it, and waits indefinitely. Nothing times out and nothing is reverted while a device waits to be approved: a week in this state is a correct outcome. What this gives up is telling a mistyped network ID apart from a controller that cannot be reached — the client reports both as an ordinary join in progress, forever, and the interface does not guess between them | 1 |
| R-VPN-07 | **A mesh join is confirmed by the device on the join being accepted, never on a person approving it.** It is a case of R-CFG-11: the device verifies what it can — that the client accepted the join and is running — and does so within seconds. Approval by a person is outside the device's control and is never waited on inside a confirmation window, because a window that expires while somebody walks to their laptop discards a working configuration. A join that fails for a reason the device *can* see — a malformed network ID, a client that is not installed, a service that will not start — fails the apply and reverts like any other change | 1 |
| R-VPN-08 | **The primary mesh client installs on a board with no network.** It is carried in the offline payload, pinned to a version and a fingerprint recorded in this repository, and verified against the publisher's signature — using a key committed here rather than fetched — before it is staged. The second mesh client, whose install pulls a dependency tree and changes system-wide packet-filter alternatives, is fetched over the network by a role that runs only when it is configured. **Installing a mesh client does not start one:** the unit is stopped and disabled at install and started only when a network is configured, so a device carries no connection to anyone's infrastructure until it is asked for one | 1 |
| R-VPN-09 | **Where a mesh needs a key the operator generates, the interface says where to get one and what kind to generate, and reports when the device's access expires.** The key is held in the secrets file and handed to the client as a file, never on a command line other processes can read. Once joined, the interface reports the expiry of the device's own access — including when there is none — so an aircraft cannot quietly lose remote access on a date nobody was told about. A key is never refused for being of the wrong kind (R-CFG-06) | 2 |

R-VPN-05 is unchanged but gains teeth from R-VPN-08's last sentence: "enable no VPN by
default" now means no client process running, not merely no network joined.

**One existing requirement gains a sentence rather than a new ID.** R-UI-12 says every page
is captured in both palettes and the build fails when a page changes shape unreviewed. A
tabbed page renders one tab, so "every page" stops meaning "everything the page can show"
(§6). R-UI-12's text is extended to say that a surface which hides part of itself is
captured in each of those parts. The ID does not change and nothing is renumbered.

No new ADR. ADR-0004 settles the ordering these sit under, and R-CFG-11 is written to
generalise; in this repository the reasoning for a decision like §4 belongs in the
requirement text, which is what R-CFG-10 and R-CFG-11 already do.

---

## 6. Where it goes in the console

**A tab on the Network page, named for the mesh it configures, and the page becomes
tabbed.** Not a page of its own — Dashboard 2.x cannot nest pages, so separate pages would
be flat siblings in the sidebar with nothing saying three of them are the same subject.
`ui-page` has no parent property (its whole configuration is `breakpoints`, `className`,
`disabled`, `icon`, `layout`, `name`, `order`, `path`, `theme`, `ui`, `visible`), and
`navigationStyle` on `ui-base` only chooses how the drawer behaves — `default`, `fixed`,
`icon`, `temporary`, `none`.

What does exist is the page's own `layout`. Set to **Tabs**, each `ui-group` becomes a tab
labelled with the group's name. `LayoutTabs` ships in the `@flowfuse/node-red-dashboard`
1.31.0 the payload pins.

```
Status   Network   Log   Diagnostics
         ───────

Network
┌────────────┬───────┬──────────┬──────────┐
│ INTERFACES │ WI-FI │ ZEROTIER │ ACTIVITY │
└────────────┴───────┴──────────┴──────────┘

(ZEROTIER selected)

  WAITING FOR YOU TO APPROVE IT

  this device   9fef8a3bf9      [copy]
```

### One tab per mesh, named for the mesh

**The tab is `ZeroTier`, not `Remote`.** Tailscale gets its own tab, `Tailscale`, when
Tailscale lands — the second half of M2 under R-VPN-02, not a placeholder shipped early
saying *not configured*.

The reason is that these are two different products with two different setup stories, and
nothing is gained by making the operator open a drawer called *Remote* to find out which
one they are looking at. The person on this tab is about to open ZeroTier's website and
approve an address; the person on the Tailscale tab is about to generate a key on a
different company's admin page. Naming the tab after the thing they are going to go and
use is the shortest path between the console and the task.

**The requirements stay product-neutral and the console does not.** R-VPN-06 says "where a
mesh requires a person to approve a device", never "ZeroTier", for the reason ADR-0004
gives: requirements that name tools go stale when tools change licence, get acquired, or
die. An interface has the opposite obligation. It is looked at by somebody holding a
particular product's admin page open in another window, and calling that product by its
name is how they know they are in the right place. If ZeroTier is ever replaced the tab is
renamed and no requirement moves.

It also improves the layout under R-UI-10. Sharing one surface, the two meshes had to
divide a single primary action between them; a tab each means each has its own — the
ZeroTier tab's is `Copy`, the Tailscale tab's is the key it takes.

### What the page holds by the end

```
Interfaces · Wi-Fi · ZeroTier · Tailscale · Cellular · Activity
             M1       M2 first   M2 second   M3         M1
```

Six tabs at the end of M3. That is a tab strip doing what a tab strip is for, and it is why
the stacked-groups layout was the wrong shape: the same six as stacked panels is a page
nobody can take in, and the same six as sidebar entries is a sidebar that says nothing
about which of them belong together.

### What the layout settles, and what it breaks

It settles the adjacency problem by separation rather than by rule. Wi-Fi's `JOIN` is the
one control in this console that can cost the operator the board — it is why R-CFG-11
exists — and a mesh join provably cannot (§4). On a tabbed page the two are never on
screen together, so they cannot be mistaken for each other.

R-UI-10 still applies, and the tabbed page makes its unit explicit: **only one tab renders
at a time, so the tab is the surface that may hold at most one primary action**, not the
page. Wi-Fi's `JOIN` is the primary action of the Wi-Fi tab; the ZeroTier tab has its own.

**It breaks the shape check, and fixing that is part of this work.**
`scripts/capture-pages.mjs` builds its list with
`flows.filter((n) => n.type === "ui-page")` and captures each page once. A tabbed page
renders one tab, so Wi-Fi, ZeroTier and Activity would never be captured, never be measured
against ADR-0009, and never fail a build when they changed. R-UI-12's coverage would
shrink to the first tab without anything saying so.

That is precisely the failure R-UI-12 was written for. The harness's own header records
why it exists: a Network page shipped wrong "because nothing in this repository had ever
looked at one". Recreating that on the ZeroTier tab, in the change that introduces the
ZeroTier tab, would be an unusually poor joke.

**So the harness walks the tabs.** For a page whose layout is `tabs` it captures each tab
in both palettes, named `network-<tab>.{day,night}`. It already presses a soft key after
capture, so driving a tab strip is within what it does rather than a new capability.

### One defect the layout uncovers

The tab strip was stood up against the real console and photographed in both palettes
before this was written. It works — `Interfaces`, `Wi-Fi`, `ZeroTier`, `Activity` — and in
day it sits correctly in the visual language: the labels have a light ground, and the
selected tab carries a faint chip and a dark underline.

**In night the tab strip is not readable, and the cause is structural rather than a
colour.** A tab has no surface of its own: the label is drawn straight onto the carbon
weave, so the texture runs through the letters, and the selected tab's chip is a
light-palette tint that disappears entirely against a dark panel. The underline that marks
the selection is a dark rule on a dark ground. Three separate things fail, and recolouring
the text fixes none of them properly — a lighter label on bare weave is still a label with
no ground.

The console already knows how to do this, one component over. A navigation item in the same
drawer, in the same palette, has a raised surface and a lit edge, and `STATUS` beside the
tab strip is perfectly legible in the same screenshot that makes `Interfaces` disappear.
Tabs never got the same treatment because no page has ever had a tab strip, so Vuetify's
own defaults survive into a theme that overrides everything else.

**Fixed here rather than queued.** `theme.ts` now gives a tab the seat a navigation item
already has: a ground in the panel material, a raised face when it is the one selected, and
a lit edge in the accent — with Vuetify's own slider removed, because the lit edge already
says it and the slider said it again in a colour nobody chose. The label is the same
letterspaced mono caps the drawer uses, so the two controls that both answer *which surface
am I looking at* are read the same way.

It belonged in this change rather than a follow-up: a control the operator cannot read at
night is a defect in the palette (R-UI-08), and ADR-0009 is explicit that night is not the
lesser mode. The shipped pages are unaffected — none of them has a tab strip yet, so the
rules are inert on them, and `verify-pages.sh` confirms every page in both palettes still
captures with no change of shape.

This is the argument for R-UI-12 in miniature, and for walking the tabs rather than
capturing the first one: the strip renders on every tab, so a check that only ever
photographed `Interfaces` would still have caught it — but nothing that only read the flows
would have, and nothing that only looked at day would have either.

### Cost

`docs/console/capture/network.{day,night}.png` and
`docs/console/shape/network.{day,night}.darwin.json` are replaced by a pair per tab. The
whole page changes shape, so this is a real review rather than a diff to wave through, and
the ADR-0009 rules must pass on every tab. `docs/console/accepted-violations.json` is empty
and may only shrink, so no tab may arrive owing anything.

---

## 7. Shape of the code

```
packages/yonder-core/src/remote/
├── zerotier/
│   ├── cli.ts          typed operations over the injected CommandRunner
│   ├── parse.ts        `zerotier-cli -j` and the terse `200 listnetworks` form
│   └── fixtures/       recorded real output, committed
├── tailscale/
│   ├── cli.ts          `up`, `down`, `status --json`
│   ├── parse.ts        BackendState and expiry
│   └── fixtures/       recorded real output, committed
├── state.ts            pure: client reports -> one shared join state
└── renderer.ts         RemoteRenderer implements Renderer

packages/node-red-contrib-yonder-remote/       nodes
packages/node-red-dashboard-2-yonder/          the waiting-for-approval instrument
flows/flows.json                               wiring only: the ZeroTier tab, and the
                                               Network page switched to a tabs layout
scripts/capture-pages.mjs                      walk the tabs of a tabbed page (§6)
```

This follows `src/net/` exactly, including the parts that matter most:

- **Nothing shells out except the renderer**, through the injected `CommandRunner`
  ([ADR-0006](../../adr/0006-nmcli-not-dbus.md)). No test executes `zerotier-cli` or
  `tailscale`.
- **`state.ts` is pure translation** — two clients' vocabularies into the one state the
  console renders — so it is where most of the logic and most of the tests live. The
  console never learns what `ACCESS_DENIED` means.
- **Fixtures are recorded real output**, as `src/net/nmcli/fixtures/` already are. The
  transcripts quoted throughout this document are the seed for them, including the
  awkward ones: the join that stays at `REQUESTING_CONFIGURATION` forever, the empty
  network name under `ACCESS_DENIED`, and the `backend error: invalid key` line.

Polling lives in `yonder-core`, which is root and can therefore read ZeroTier's local API
token. The console reaches it over the existing daemon socket and holds no privilege of its
own.

---

## Evidence

Board: Debian GNU/Linux 13 (trixie), aarch64, `zerotier-one 1.16.2`, `tailscale 1.94.2`,
2026-09-02. Both clients were installed for the investigation, driven through join,
unauthorised, authorised and leave, and the board was returned to its original three
routes with no networks joined and no controller networks defined.
