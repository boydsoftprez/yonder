# Verifying the console without hardware

The console spine — the setup gate, the login gate, the generated `settings.js`, the
credential the daemon owns — is covered by unit tests, and every one of those tests runs
against a fake. A fake daemon, a fake `nmcli`, a stubbed transport. That is the right way to
test each part, and it proves nothing at all about whether the parts *fit*.

`scripts/verify-console.sh` is what proves that. It starts the real daemon on a real Unix
socket, starts a real Node-RED against a generated `settings.js`, and asks the pair
questions with `curl`.

```sh
npm run build
./installer/make-payload.sh --arch linux-arm64     # once, for vendor/console
./scripts/verify-console.sh
```

Everything it creates lives in one temporary directory and is removed on exit; `KEEP=1`
leaves it behind. `PORT=` moves the console off 18880.

**What it does not prove.** Nothing about systemd, a board, NetworkManager or a radio.
`systemctl`, `nmcli` and `rfkill` are stand-ins on `PATH` — the `systemctl` one records what
it was asked to restart, which is how the script can assert that setting a password made the
daemon ask for the console back. Real units, real ordering and a real cold boot are the
separate hardware test, and this milestone has not had one.

## What it checks

<!-- yonder:console-verified -->

| | |
|---|---|
| Ran on | macOS 26.6.2, Node v25.9.0, curl 8.7.1 |
| Node-RED | 5.0.6 |
| Dashboard | `@flowfuse/node-red-dashboard` 1.31.0 |
| Result | **51 passed, 0 failed** |
| Date | 2026-09-01 |

- A daemon starting from a clean root seeds a configuration, generates a setup-mode
  `settings.js` from it, and asks for the console to restart — and never asks for anything
  about `yonder-core`.
- The setup console serves `/` and answers **404** to `/editor`, `/dashboard`, `/ui`,
  `/config`, `/status`, `/settings`, `/admin/verify`, `/login` and `/flows`. That is
  R-SEC-09 as a status code rather than as a hidden menu item.
- `GET /config` on the socket is **403** while unprovisioned and **200** after — the socket
  is the boundary, not the console.
- A four-character password is refused with the rule and nothing is set; a good one is
  accepted once, and a second attempt is **409**.
- The daemon then rewrites `settings.js` — `provisioned: true`, `httpAdminRoot: "/editor"`,
  `flowFile: "flows.json"` — and asks for the console back, *after* the browser has its
  page.
- The restarted console serves a login page, refuses the wrong password with no cookie,
  accepts the right one with an `HttpOnly` session cookie, and lets a signed-in request
  past.
- The flow editor issues no token for the wrong password, none for a username it does not
  know, and one for the right password — all decided by the daemon, over the socket.
- **With the daemon stopped, the right password fails and sets no cookie.** That is the
  fail-closed property, end to end.

## R-SEC-10, checked rather than asserted

Everything both services printed goes to one file for the length of the run. The last thing
the script does is look for the password in it:

```
grep -c verify-console-Zx9Qw4Tm .../journal.log
0
```

It also greps every file under the temporary root, so a password written to a *file* rather
than a log would fail too. `secrets.yaml` is checked to hold a `scrypt$…` hash, which is the
only place anything derived from the password may be.

An assertion nobody can check is not an assertion. The command and its empty output are
above; re-run the script and it prints them again.

## Transcript

```
== a daemon and a console from a clean root
  ok    the daemon bound …/run/yonder/core.sock
  ok    it generated settings.js
  ok    settings.js is in setup mode
  ok    the flow editor is not mounted
  ok    it took the port from the configuration
  ok    it restarted the console and nothing else
  ok    it never touched yonder-core

== setup mode: one page, and nothing else
  ok    GET / is the setup page (200)
  ok    the setup page is the setup page
  ok    it says the passphrase is published, not secret
  ok    GET /editor is 404 (404)
  ok    GET /editor/ is 404 (404)
  ok    GET /dashboard is 404 (404)
  ok    GET /ui is 404 (404)
  ok    GET /config is 404 (404)
  ok    GET /status is 404 (404)
  ok    GET /settings is 404 (404)
  ok    GET /admin/verify is 404 (404)
  ok    GET /login is 404 (404)
  ok    GET /flows is 404 (404)

== the socket refuses configuration while unprovisioned
  ok    GET /config on the socket is 403 (403)
  ok    GET /status on the socket still answers (200)

== setting the password
  ok    a 4-character password is refused (400)
  ok    the refusal says the rule
  ok    and nothing was set ({"provisioned":false})
  ok    a good password is accepted (200)
  ok    the page says the console is restarting
  ok    the daemon now says provisioned ({"provisioned":true})
  ok    a second attempt is refused (409)

== the daemon rewrites the console and asks for it back
  ok    settings.js is now provisioned
  ok    the flow editor is now mounted
  ok    it uses the real flows file
  ok    the console was asked to restart twice: once at start-up, once now (2)
  ok    and still never touched yonder-core

== the socket opens once there is a password
  ok    GET /config on the socket is 200 (200)

== restarting the console into its provisioned shape
  ok    GET / is now a login page
  ok    the wrong password fails (401)
  ok    a failed sign-in set no cookie
  ok    the right password is accepted (303)
  ok    it set a session cookie
  ok    the cookie is HttpOnly
  ok    a signed-in request goes past the gate

== the flow editor asks for credentials
  ok    GET /editor/ is mounted and answers (200)
  ok    the editor issues no token for the wrong password
  ok    and issues one for the right password
  ok    and none for a username it does not know

== the console fails closed when the daemon is not there
  ok    the right password fails while the daemon is down (401)
  ok    and set no cookie

== R-SEC-10: the password is nowhere in the journal
  grep -c verify-console-Zx9Qw4Tm …/journal.log
  0
  ok    the password appears nowhere in what either service printed (0)
  ok    and in no file under the temporary root
  ok    secrets.yaml holds a scrypt hash

== result
  51 passed, 0 failed
```

## What this run found

Two things, both of which would otherwise have been found on a board:

- **The start-up render is sequential and stops at the first failure.** With no
  NetworkManager, the network renderer threw and the console renderer never ran, so no
  `settings.js` was written at all. On a device that is correct — the console is rendered
  behind a network that has settled — but it means a board whose NetworkManager is wedged
  gets no console configuration from the start-up render either. Setting a password still
  works, because that path calls the console renderer directly rather than through the apply
  engine. Recorded as **K-19**.
- **Node-RED's editor refuses a bad password with 403, not 400.** Harmless, and the reason
  the script asserts on whether a token comes back rather than on a status code Node-RED
  owns.

---

## Verifying the pages

`scripts/verify-console.sh` proves the spine. `scripts/verify-pages.sh` proves the other
half: the shipped `flows/flows.json` loaded by a real Node-RED with the real Dashboard, with
both contrib packages installed, in front of the real daemon.

```sh
npm run build
./installer/make-payload.sh --arch linux-arm64     # once, for vendor/console
./scripts/verify-pages.sh
```

Same conventions: one temporary directory, removed on exit unless `KEEP=1`, and `PORT=`
moves the console off 18881. `ping`, `nmcli`, `mmcli`, `curl`, `hostnamectl`, `rfkill` and
`systemctl` are stand-ins on `PATH`; the `nmcli` one reports a wired port, a radio and a
modem control port, and a scan with a duplicated SSID so the folding in `scanForNetworks`
has something real to fold. The `mmcli` one replays the fixtures `yonder-core`'s own parser
tests are written against — a real EC25 on a live SIM — so the Cellular tab is captured
showing what a board actually reported rather than a panel of em dashes. It answers a
**second board** as well: a file holds 1 or 0 and is read on every call, and with 0 there
are no modems at all, which is the board `Reachable by` on Status has to be photographed
on. The config the
daemon is given is the shipped default with the modem turned on, because with it off the
daemon reports the cellular path absent and neither cellular page can be captured at all.

The rest of `network.modem` is **configured** rather than left at its defaults, because
R-UI-17 made it visible: the Cellular tab's four boxes are seeded from that section, so a
capture taken against `apn: null` would photograph the defect it was taken to prove fixed.
The APN is the value the bearer fixture is dialled on — the ordinary state of a working
device, where the form and the fact cell above it agree — and the dial number is
deliberately left unset, because an empty box beside two filled ones is what *not
configured* has to look like. The password is a reference into a `secrets.yaml` the gate
writes before starting the daemon, so the box can be photographed saying a credential is
on file; the value behind that reference is then grepped for in the journal, in every route
the console serves, in the dashboard it hands a browser, and in every file under the
temporary root but `secrets.yaml` itself (R-SEC-10).

The `curl` stand-in is the one the gate *drives*. It is what `commandProbe` runs to find out
whether a path carries traffic, and it answers whatever the gate last wrote to a file — read
on every call — which is how the `Way out` rows are photographed in each of the states a probe
can put them in. Nothing else probes: no interface holds an address in this harness, so
`ReachWatch` finds no path in use and every probe in the run is one the gate asked for through
`POST /reach/test`. That is what makes the states reproducible instead of a race with a
five-second timer.

It checks that the daemon's five page routes answer over the socket and that the scan carries
no key; that Node-RED starts the shipped flows with **no error at all** and no unregistered
node type; that every widget found its group, page and dashboard; and that the dashboard and
its generated palette are both behind the login while `settings.js` is not served at all.

**What it found on its first run**, and what no unit test could have:

- **A config node whose id was also a node type.** `ui-base` had the id `ui-base`. Node-RED's
  config-node dependency scan compares every string property of a config node against the ids
  of the others — and a node's own `type` is one of those properties — so it read the node as
  depending on itself: `Circular config node dependency detected: ui-base`, followed by
  twenty-odd `No group configured` lines and four pages with nothing on them. The ids are now
  `dashboard` and `palette`, and `flows.test.ts` asserts the shape of that mistake so it
  cannot come back.
- **`httpStatic` is mounted *behind* `httpNodeAuth`, not in front of it.** `red.js` applies
  the node-root auth at line 428 and the static mounts at 438, so the generated `theme.css` is
  gated exactly like the dashboard it styles. That is the right place for it — the login page
  carries its own inline CSS — but it was assumed the other way round and the assumption was
  wrong.

**What it still does not prove.** Whether a widget is usable on a tablet in sunlight, or
anything at all about hardware. Every claim about a real board remains unverified.

## The capture gate

Since R-UI-12, the same run drives a real browser over every page in both palettes. It was
added because of a specific failure: the Network page's *"Read this before you join a
network"* — the warning that says the access point is about to disappear and that there are
five minutes to confirm — shipped as 706 px of text in a 372 px widget, with 39% of it behind
an inner scrollbar that nothing indicated was there. Every check above this line passed on
that build. Nothing in this repository had ever looked at a page.

It does three separate things.

**Rules that fail on their own.** Nothing clipped inside a box, no action spanning the
surface it sits on (R-UI-10), no page scrolling sideways, no control whose text cannot be
read against what is behind it (R-UI-16), no page rendering nothing at all. These are
relative comparisons within one rendering, so they hold on any machine.

The legibility rule is the one a picture could not make. An operator reported that in the
night palette the text in the entry fields was *"not able to be read by human eyes"*, and
every check above had passed: the shape was unchanged and the committed capture showed the
words — at 1.05:1 against their own recess, which is a picture of the defect that looks like
a picture of an empty field. So it is measured rather than looked at: each control's own
computed colour is composited over everything painted behind it, with alpha and the
accumulated `opacity` of its ancestors folded in, and anything under 4.5:1 fails. Folding
opacity in is the point — what made those labels unreadable was the interface framework
drawing black at 60%, which a rule reading `color` alone would have called black and passed
in the day palette for the same reason it failed at night.

**A shape manifest**, committed and diffed — every widget's geometry, so a page that moves
fails until somebody accepts it. Geometry rather than pixels, because *shape* is what the
requirement says and because a pixel diff between a laptop and a CI runner is a question
about font rasterisation rather than a check. References are named for the platform that
recorded them (`status.day.darwin.json`, `status.day.linux.json`) so every machine enforces
its own instead of one enforcing and the rest printing a note nobody reads.

The manifest also carries **the words of anything wearing `yonder-fixed`**, and it has to.
Geometry alone could not tell four of the state captures apart from their bases: an
annunciator is `inline-flex` inside a grid-fixed wrapper and a qualifier wraps to one line
in every state, so no box moves, and four committed references came out byte-identical to
the pages they were meant to distinguish. `yonder-fixed` is the one declaration on this
console that a value is the same on every run, which is exactly the licence needed to freeze
its text; nothing else's text is recorded, because a load average in a reference would leave
it dirty for ever.

On CI the check is `git status --porcelain docs/console/shape`, not `git diff`. Every
committed reference is a `.darwin.json` and the runner is Linux, so the gate takes its
*record* branch and writes `.linux.json` files that are **untracked** — which `git diff`
does not see, and did not, on every run since the job was written.

**A picture**, in `docs/console/capture/`, written every run. The committed copy masks live
readings — a load average changes between two runs and would leave the file permanently
dirty — so what it records is the layout. The unmasked copy goes to `vendor/capture/`, which
CI uploads as an artifact.

**And a page in more than one state, where it has them.** R-UI-12 says a surface that hides
part of itself is captured in each of those parts. A tabbed page hides its other tabs, which
is why there is one capture per tab; a panel drawn from live state hides its other states the
same way. The `Way out` rows have four — a path that is reaching something, one that reached
nothing when it was last tested, one nothing has looked at, and one whose interface is down.
What separates them is **the sentence**, not the geometry: nothing on that panel moves
between the four, so each row wears `yonder-fixed`, which both unmasks it in the committed
picture and puts its words in the shape manifest. Without that the states were three grey
rectangles apiece and four identical references — and the exact sentence R-NET-14 was
written to abolish was invisible in every one of them. The base
capture is the untested state, which is what a board that has just come up shows; the others
are driven and captured under names of their own. The last of them is a different *board*
rather than a different reading — a wired port with nothing plugged into it — and it is
driven the way the no-modem board is, by a file the `nmcli` stand-in reads on every call.
That row used to read "Up, and not yet tested — nothing has established that it reaches
anything" about an `eth0` NetworkManager had in `unavailable` with no carrier and no
address (R-NET-14).

```
network-interfaces.day.png                  every path up, and untested
network-interfaces-not-reaching.day.png     every path probed, and reaching nothing
network-interfaces-reaching.day.png         every path probed, and reaching something
network-interfaces-down.day.png             the wired port down, and saying so
```

**Status has four shapes.** Two of them are two different boards: `Reachable by` is gauges
over a labelled strip, and on a board with no modem the gauges are *absent* — a gauge with
no needle reads as a fault, and there being no modem is not one. That capture is driven by
taking the modem out of the harness rather than by sending an empty reading, so what is
photographed is the panel degrading rather than a panel with a hole in it.

The third is the same board holding a configuration change nobody has confirmed (R-UI-15).
The gate applies one, does not confirm it, photographs the banner with a real countdown on
it, and then **presses `REVERT NOW`** and asserts the device put the previous configuration
back — which is the only end-to-end proof that either key on that panel reaches the device.
A banner that renders correctly and whose keys do nothing is the failure `--press NIGHT` was
added for.

The banner is on **every** surface, which is what R-UI-15 asks for and what it did not have:
one copy per page, and on the Network page one copy per tab, because Dashboard's tabs layout
renders one `ui-group` per tab — a group there would be a tab that *appears*, which an
operator on another tab would never see. A grid page's whole group is hidden between
changes; a tab's four widgets are hidden by id instead. In the same pending window the gate
photographs the **Cellular tab**, because that is the surface the requirement was failing on:
an operator who fixed an APN there, watched the modem redial and stayed put had no countdown
in front of them and no key to press.

```
status-pending.day.png                      the banner on a page whose groups are a grid
network-cellular-pending.day.png            the same change, on a tab
```

The fourth is `If you lose this console` in its other state (R-UI-18). That panel prints the
access-point passphrase **only while it is the published default** — ADR-0007 makes that
value deliberately public, and it is the only thing that makes a locked-out operator's way
back in usable at all — and says it has been changed once the operator has set their own.
Every other picture in the run is of the first state, so the second is captured under a name
of its own. There is no route that changes that passphrase yet, so the gate does what an
operator would have to do today: stops the daemon, edits `secrets.yaml`, starts it again.
Around that capture it greps the journal, `GET /config`, `GET /status`, **the value the
widget that draws it is actually handed**, and every file under the temporary root for the
value it set — which is the same claim made against the modem credential, applied to the
other secret this device holds. The widget value rather than the dashboard: what the browser
is served at `/dashboard` is the application shell, and every value reaches it afterwards
over socket.io, so grepping the shell could not fail for the only way a credential would get
there. Dashboard's own `_debug/datastore/<widget id>` is that value.

```
status.day.png                              a board with a modem in it
status-without-modem.day.png                the same board with nothing in the slot
status-pending.day.png                      the same board, holding an unconfirmed change
status-psk-changed.day.png                  the same board, on a passphrase the operator set
```

The countdown is masked in the committed picture and only there: it is the one annunciator
caption on this console that is a *reading*, so without masking that file would differ by a
second or two on every run. The widget says so about itself with `className: "yonder-live"`,
which is what the mask list matches — the lamp and its box are untouched, and the unmasked
copy under `vendor/capture/` carries the digits. The *caption* goes whole, the word with the
digits: the annunciator draws both in one element and there is no smaller one to mask. The
two lines under it wear `yonder-fixed`, so what the banner is about is still readable.

`className: "yonder-fixed"` is the mirror of that. `If you lose this console` wears it, and
so does every row of `Way out`. Data-bar cells and text values are masked as *kinds*,
because most of them carry readings; those two panels carry none — an SSID, an address, a
hostname and either the published passphrase or the sentence that stands in for a changed
one; an interface name from a device list and one of five fixed sentences. Masked, each
panel's states were the same picture, which is most of the reason for taking the second one.

`capture-pages.mjs --only <page> --as <name>` is what takes one of them, so a state capture
is held to exactly the rules and the shape reference every other page is. The shape manifest
is what proves the degradation rather than the picture: the two gauges appear in the
without-modem reference carrying `d-none` and a zero box, and the panel is 120 px shorter.

```
./scripts/verify-pages.sh                    # capture, and gate
ACCEPT_SHAPE=1 ./scripts/verify-pages.sh     # adopt a deliberate change
```

Without playwright installed the run says so loudly and skips, rather than passing quietly:

```
npm install --save-dev playwright && npx playwright install --with-deps chromium
```

### The debt list

`docs/console/accepted-violations.json` holds the violations the pages M1b shipped already
have — four actions spanning their surface, two forms clipping their own content — each with
a reason. Without it the gate would have failed on everything from its first run and been
turned off within a week.

It can only shrink. A finding that is not on it fails the build, and an entry on it that no
longer matches anything **also** fails, with *this is fixed, delete the line* — because a
debt list nobody prunes stops being a list of debts and becomes a list of excuses.

**What the gate found on its first run**, and what no unit test could have:

- **Four actions at 588 px of 588 px.** `Refresh`, `Scan for networks`, `Yes, I can still
  reach it` and `Check reachability` each fill 100% of the surface they sit on. This is
  R-UI-10 stated as a measurement rather than an opinion, and it is the mechanical
  consequence of a stock widget being a whole row of its group — see
  [ADR-0009](adr/0009-console-visual-language.md).
- **Two forms clipping their own content.** The join form is 172 px of content in 48 px, 72%
  hidden; the ping form is 112 px in 48 px, 57% hidden. Exactly the K-13 defect, in a widget
  type nobody had thought to check: `theme.ts` unclips markdown, and a form has the same
  problem for the same reason.

**What it still does not prove.** That a reading is legible in sunlight, that a target is
big enough for a gloved finger, or that any of it works on a board. A headless browser at
1280×900 is not a tablet on a wing.
