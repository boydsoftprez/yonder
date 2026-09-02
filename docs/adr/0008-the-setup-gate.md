# ADR-0008 — The setup gate is enforced by absence, not by hiding

**Status:** accepted · **Date:** 2026-09-01 · **Implements:** R-SEC-09, R-SEC-11, R-SEC-12 ·
**Builds on:**
[ADR-0007](0007-credential-boundary.md)

## Context

[ADR-0007](0007-credential-boundary.md) moved the credential boundary from the access point
to the console: the setup access point carries a published passphrase, and the console
requires an administrator password the operator sets at first use. R-SEC-09 states the
consequence — *until an administrator password has been set, the console offers no function
but setting one. No configuration read, no command, no status beyond what that step needs.*

There is an easy reading of that requirement and a correct one.

The easy reading is a console that renders a setup screen and hides everything else. The
pages exist, the routes are mounted, the daemon answers them, and a conditional somewhere in
the interface decides not to show the navigation. That satisfies a screenshot. It does not
satisfy R-SEC-09: anyone within radio range of a device that has just been powered on can
join the published access point and ask those routes directly, and they will answer.

## Decision

**In setup mode the routes are absent, not hidden.** Three layers, each of which is
sufficient on its own, arranged so that no single conditional is load-bearing:

| | Unprovisioned | Provisioned |
|---|---|---|
| Flows loaded | none — an empty `setup-flows.json` | `flows.json` |
| Editor (`httpAdminRoot`) | `false` — not mounted at all | `/editor`, behind `adminAuth` |
| What the console serves | one page, one `POST`, and 404 for everything else | the console, behind a session |
| `GET /config` on the socket | **403** | 200 |

With no flows there is no node, so there is no function to call. With `httpAdminRoot: false`
Node-RED mounts no admin application, so there is no editor to reach. And the middleware in
front of everything answers 404 to every path but `/` — not a redirect to a login page,
because there is no login page and nothing to log in to.

**The socket is the boundary, not the console.** `GET /config`, `POST /apply` and
`POST /confirm` refuse with 403 until a password exists. The console cannot reach them in
setup mode anyway; that is not a reason to leave them open, because a boundary that depends
on the caller being polite is not one.

**The console holds no credential.** It runs as the unprivileged `yonder` user;
`secrets.yaml` is `0600 root`. It therefore *cannot* read the password hash, which is the
desired state rather than a limitation. Authentication is a question it asks the daemon over
the Unix socket, and both the console's own login and the flow editor's `adminAuth` go
through that one route. A compromise of the console yields nothing to crack offline.

**Everything fails closed.** A daemon that is down, slow, or returning something that is not
an answer produces a failed login, never a successful one. A daemon that cannot read
`secrets.yaml` at all reports *cannot tell*, and the routes treat that exactly as they treat
"not provisioned": refuse. The safe direction when this device does not know whether it has
a lock on it is to behave as though it has one nobody can open.

**Setting the password is one way.** `POST /admin/password` succeeds once and answers 409
afterwards. A device that lets an unauthenticated caller *replace* the administrator password
has no lock at all — whoever reached the console second would simply overwrite the first
operator's and take the device. Changing a password you already know is a different,
authenticated operation, and it does not exist yet.

## Rationale

**A property you can test is worth more than a property you can describe.** "The routes are
not mounted" is a 404 in a test. "The navigation is hidden" is a screenshot and a habit. The
tests for this milestone assert the status code.

**Absence survives refactoring.** A conditional that hides a page is one edit away from being
inverted, and the edit looks harmless. A flows file with nothing in it cannot be made to serve
a page by accident.

**One credential, one checker.** The console's login and the editor's login ask the same
daemon the same question over the same socket. Two implementations of "is this the
password" is how one of them ends up weaker than the other.

## Consequences

- **The console is restarted when it is provisioned.** `settings.js` is generated, and which
  of the two shapes it takes is decided when it is written, not per request. Setting a
  password therefore rewrites it and restarts the console — after the browser has its "the
  password is set" page, because the restart kills the process writing that page.
- **Sessions do not survive a console restart.** The signing key is minted per process and
  the session set is in memory, so a configuration change logs everyone out. That is the
  right trade for a device whose console restarts when its configuration changes, and it
  means there is no session secret at rest for someone with the SD card to find. Recorded as
  **K-18**.
- **The session cookie is not `Secure`.** The setup access point is plain HTTP — there is no
  certificate a device with no name and no internet connection could present — and a `Secure`
  cookie over plain HTTP is simply never sent, so setting it would produce a console that
  accepts a password and then behaves as though nobody had logged in. `HttpOnly` and
  `SameSite=Strict` are set and do work. Anyone already inside the access point's radio range
  can read the cookie off the air. TLS is R-SEC-08 and a later milestone. Recorded as
  **K-20**.
- **The window ADR-0007 named is still open**, and this ADR does not close it: between
  power-on and the operator setting a password, anyone in radio range could join and set it
  first. It is a minute or two with the operator standing beside the board, and it is the
  same trade every consumer router makes. What has changed is only that the window now ends
  in something worth defending.
- **A forgotten password is a reflash.** There is no recovery path from the console, because
  a recovery path reachable without the password is the password. Recovering it needs the
  card: remove `admin_password` from `/etc/yonder/secrets.yaml` and restart `yonder-core`.
  The setup page says so, in those words, before the password is set.
- **The daemon must be running for anyone to log in.** That is what fail-closed costs, and it
  is the correct direction: the alternative is a console that lets people in when the thing
  holding the credential is not answering.

## The one thing in front of the gate, and what it cost

`GET /status` sits deliberately *outside* the administrator-password gate. It is the only
route that does. A board whose `secrets.yaml` cannot be read has no credential to check a
password against, so every gated route must refuse — and if the route that explains *why*
also refuses, the device can only answer `403` to a fault the operator has to be standing
next to it to fix. R-SEC-09 has been amended to state that carve-out rather than leave the
code arguing with the requirement.

Leaving it open cost something, and the cost is worth recording because it was invisible
until someone went looking. `ApplyStatus.degraded` carried the message of whatever error
stopped the renderer set being built — and the thing that stops it is a malformed
`secrets.yaml`. The YAML parser reports a syntax error by quoting the offending lines
straight back:

    Tabs are not allowed as indentation at line 2, column 1:

    ap_psk: <the access-point passphrase, in full>
    	admin_password: <the stored hash, in full>

So a stray tab in that file turned the one deliberately ungated route into an
unauthenticated credential dump over the access point, and put the same lines in the
journal on the way past. Both halves of R-SEC-10 — "an error message", "an API response" —
in a single character of whitespace.

The fix is at the capture point, which is what R-SEC-10 asks for: `SecretStore` now refuses
a file it cannot parse with a message that keeps the line and column and discards the
parser's reason, because the reason is inseparable from the quoted line that carries it.
Nothing above that call can reintroduce the leak, and no future route has to remember to
strip anything.

**The general lesson, which outlives this ADR:** a route is not safe because of what it was
designed to return. It is safe because of what everything upstream of it can be made to put
there. `degraded` was specified as a short human-readable reason and became a file
transcript, and the route in front of the gate was chosen before anyone asked what could
reach that field.

## Not decided here

What the console *contains* once it is unlocked. This ADR is about the lock. The pages behind
it — status, network, themes, the activity log — are M1b-2 and choose nothing that this
records.
