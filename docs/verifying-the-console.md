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
moves the console off 18881. `ping`, `nmcli`, `hostnamectl`, `rfkill` and `systemctl` are
stand-ins on `PATH`; the `nmcli` one reports a `wlan0` and a scan with a duplicated SSID, so
the folding in `scanForNetworks` has something real to fold.

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
surface it sits on (R-UI-10), no page scrolling sideways, no page rendering nothing at all.
These are relative comparisons within one rendering, so they hold on any machine.

**A shape manifest**, committed and diffed — every widget's geometry, so a page that moves
fails until somebody accepts it. Geometry rather than pixels, because *shape* is what the
requirement says and because a pixel diff between a laptop and a CI runner is a question
about font rasterisation rather than a check. References are named for the platform that
recorded them (`status.day.darwin.json`, `status.day.linux.json`) so every machine enforces
its own instead of one enforcing and the rest printing a note nobody reads.

**A picture**, in `docs/console/capture/`, written every run. The committed copy masks live
readings — a load average changes between two runs and would leave the file permanently
dirty — so what it records is the layout. The unmasked copy goes to `vendor/capture/`, which
CI uploads as an artifact.

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
