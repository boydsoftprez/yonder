# M1b-2 Console Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the pages on the console that M1b-1 built the lock for — board status, a live activity log, day and night themes, and the one that closes M1: **scan for a Wi-Fi network from a browser on the access point, join it, and get the access point back by itself when the password was wrong.**

**Architecture:** Everything the pages show comes from the daemon over the Unix socket; the Node-RED side is two thin contrib packages and a `flows.json` that is wiring only (CLAUDE.md rule 2). Pages are Dashboard 2.x, per [ADR-0005](../../adr/0005-console-substrate.md). No new privilege: the console still runs as `yonder` and still holds no credential.

**Tech Stack:** Node 24 · TypeScript · Zod · vitest · Node-RED 5 · `@flowfuse/node-red-dashboard` 1.x · `node-red-node-test-helper` · POSIX `sh`

## Global Constraints

Carried unchanged from M1b-1 — re-read that plan's Global Constraints section and treat it as in force here. In addition:

- **`flows/flows.json` is wiring only.** No `function` node exists in the shipped profile; `settings.ts` already excludes it. Anything with a decision in it goes in a package.
- **Contrib packages are real npm packages** — unscoped `node-red-contrib-yonder-*`, with their own `package.json`, source files and tests run by `node-red-node-test-helper`. A node without tests will not be merged.
- **The console must stay usable on a link with hundreds of milliseconds of latency** (R-UI-06). No page may require a round trip per keystroke, and no poll may be tighter than 2 s.

## What already exists (M0 + M1a + M1b-1)

- `NmcliClient.scan(iface)` — **already implemented in M1a**, returns `AccessPointInfo[]`. This milestone exposes it; it does not build it.
- `src/console/{client,session,middleware,settings,renderer,wiring}.ts` — the gate, the generated `settings.js`, and `CONSOLE_FLOW_FILE = "flows.json"`, which this milestone finally populates.
- Daemon routes: `GET /console/state`, `POST /admin/password`, `POST /admin/verify`, `GET /status`, and behind the gate `GET /config`, `POST /apply`, `POST /confirm`.
- `ApplyEngine` with the confirmation timer, `FallbackWatchdog`, `NetworkRenderer`, `ConsoleRenderer`.
- `docs/known-issues.md` — **K-13 is narrowed by Task 5 of this plan, not closed.** K numbers are stable: struck through when closed, never reused.

---

## The decision this plan makes, because M1 cannot close without it

**On a single-radio board, joining a Wi-Fi network takes the access point down. That is physics, not a defect, and the console must say so before it happens rather than appear to hang.**

K-13 records that `desiredProfiles` hands one interface to both `apProfile` and `clientProfile` and lets NetworkManager decide. For M1's exit criterion that is not good enough, because the operator is *standing in* the failure: they submit Wi-Fi credentials over the access point, and the radio they are talking through is the radio being retuned.

What this milestone does about it:

1. **The renderer arbitrates instead of guessing** (Task 5). When one radio must serve both, the configured client wins and the access point is taken down deliberately, in that order, so the outcome is written down rather than inherited from NetworkManager's activation rules.
2. **The console warns before it applies, not after.** The Wi-Fi form tells the operator, in plain words, that the access point is about to disappear, where to look for the device, and what happens if the password was wrong.
3. **A radio-moving apply gets a longer confirmation window.** The default 90 s is budgeted for an operator who never lost their connection. This one has to reconnect to a different network and find the device, so the window for an apply that moves the radio is separately configurable and defaults to 300 s.
4. **The device becomes findable by name** (Task 6). `system.hostname` already exists and defaults to `yonder`; publishing it over mDNS is what makes "find me again afterwards" an instruction an operator can actually follow, with no router admin page and no IP scan.

**What this plan explicitly does not do:** run an access point and a client on one radio at the same time. Some chipsets support a second virtual interface and it is the eventual answer, but this repository has never observed it working on a real board, and CLAUDE.md's whole method is that unobserved hardware behaviour does not get written down as design. It stays K-13, narrowed.

**Consequence to state in the docs and the UI:** a successful join still needs confirming from the *new* network within the window, or it reverts. That is the rollback engine working as designed — the proof that a configuration is good is that the operator can still reach the device — and it is exactly why the window is being raised rather than removed.

---

## File Structure

```
packages/yonder-core/src/
├── system/
│   ├── facts.ts         pure: /proc + /sys text -> board facts
│   ├── read.ts          the injected reader that supplies that text
│   └── versions.ts      OS and Yonder versions
├── diag/
│   └── probe.ts         ping and reachability, over CommandRunner
└── log/
    └── activity.ts      a bounded ring buffer, and the route that serves it

packages/node-red-contrib-yonder-system/     board facts, activity log
packages/node-red-contrib-yonder-network/    config, scan, apply, confirm

flows/flows.json                             wiring only
```

---

## Task 1: board facts

**Requirements:** R-SYS-01, R-SYS-02

**Files:** Create `src/system/{facts,read,versions}.ts` and tests.

- [ ] `facts.ts` is **pure**: it takes the text of `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`, `/sys/class/thermal/thermal_zone0/temp` and `/proc/device-tree/model`, and returns a typed record. No file reads in this module.
- [ ] `read.ts` supplies that text through an injected reader, defaulting to the real paths. Every one of those paths may be **absent** — a board with no thermal zone, a device tree with no model — and an absent input must produce `null` for that field, never an exception and never a fabricated zero.
- [ ] `/proc/device-tree/model` is NUL-terminated. Strip it. A trailing NUL rendered into a browser is a bug nobody sees until it is in a screenshot.
- [ ] `versions.ts`: the Yonder version from the installed `package.json`, the OS from `/etc/os-release`. Both may be absent; both degrade to `null`.
- [ ] CPU temperature is millidegrees in that file. Convert once, here, and say so in a comment — a page showing `58000 °C` is the classic version of this mistake.

**Tests:** real captured fixtures, committed, in the M1a tradition — `parse.ts`'s fixtures were recorded from a board rather than written from a manual, and these should be too where a board's output is known. Cover: a missing thermal zone, a model string with its NUL, a `/proc/meminfo` from a 905 MB board, an uptime of less than a minute, and a load average with a process count field.

**Verify:** `npm test`

---

## Task 2: diagnostics

**Requirements:** R-DIA-01, R-DIA-02

**Files:** Create `src/diag/probe.ts` and tests.

- [ ] `ping(host, {count})` over the injected `CommandRunner`. **The host is operator input and goes on a command line** — validate it as a hostname or an IP and refuse anything else. Do not rely on the runner's argument array for safety; state the rule here, where the value arrives.
- [ ] Bound it: a count cap and a deadline, so a page cannot start a probe that never returns.
- [ ] `reachable()` — general internet reachability. Say in a comment what it actually tests, because "the internet is up" is not a thing that can be tested, and a function claiming to is a lie the next reader inherits.
- [ ] Failure is a result, not an exception: unreachable is the answer to the question, not an error.

**Tests:** stubbed runner. Malicious hosts (`8.8.8.8; rm -rf /`, `$(whoami)`, a 300-character name) are refused. A timeout produces a result. No test executes `ping`.

**Verify:** `npm test`

---

## Task 3: the activity log

**Requirements:** R-DIA-05

**Files:** Create `src/log/activity.ts` and tests. Modify `src/log.ts` so existing `log`/`warn` calls feed it.

- [ ] A **bounded** ring buffer — a fixed number of entries, each timestamped. On a device that runs for weeks an unbounded log is a memory leak with a nice name.
- [ ] It is fed by the existing `log()`/`warn()` calls, so the log shows what the daemon actually did rather than a second stream someone has to remember to write to.
- [ ] **It inherits the redaction, and there is a test proving it.** This buffer is served to a browser; `src/secrets/redact.ts` is the one list and this must use it. A new caller that logs a PSK must fail a test here, not surface in a screenshot.
- [ ] Entries carry a level so the page can distinguish a note from a fault.

**Tests:** the buffer discards oldest-first at capacity; a logged PSK is redacted in the buffer; timestamps are monotonic on the injected clock.

**Verify:** `npm test`

---

## Task 4: the routes the pages read

**Requirements:** R-SYS-01, R-SYS-02, R-DIA-01, R-DIA-02, R-DIA-05, R-NET-03

**Files:** Modify `src/daemon/routes.ts` and its tests.

- [ ] `GET /system` → board facts and versions.
- [ ] `GET /net/scan` → `NmcliClient.scan()` on the Wi-Fi interface. **Never returns a PSK** — it is a list of what is in the air.
- [ ] `POST /diag/ping` `{host, count}` → a probe result.
- [ ] `GET /diag/reachable` → reachability.
- [ ] `GET /log?since=` → activity entries.
- [ ] **All of these sit behind the administrator-password gate**, with the existing 403. None of them is needed to set a password, so none of them belongs in front of it (R-SEC-09).
- [ ] The generic 500 in the catch-all stays as it is. A scan failure must not return `nmcli`'s stderr — that is how an SSID or a driver path leaves the device.

**Tests:** each route 403s while unprovisioned; the scan response carries no secret; a ping with a bad host is 400; the catch-all still swallows a subprocess message.

**Verify:** `npm test`

---

## Task 5: arbitrate the radio, and widen the window that a radio move needs

**Requirements:** R-NET-01, R-NET-03, R-NET-07, R-CFG-03 · narrows K-13

**Files:** Modify `src/net/profiles.ts`, `src/net/renderer.ts`, `src/schema/config.ts`, and tests.

- [ ] `desiredProfiles` must stop handing one interface to two profiles in conflicting modes. When the board has a single Wi-Fi radio and a client SSID is configured, **the client wins and the access point is brought down deliberately**, in an order the renderer chooses rather than one NetworkManager falls into.
- [ ] The order matters and must be tested: the client profile is created and raised *before* the access point is taken down, so a board that fails to associate has not already thrown away the thing the operator is talking through. If association fails, the confirmation timer expires and the existing rollback restores the access point — and the fallback watchdog (R-NET-07) is the backstop under that.
- [ ] **The fallback watchdog must still win.** Nothing in this task may let a configuration reach a state where nothing is reachable and no access point comes up. That is R-NET-07 and it is load-bearing; add a test that a failed client association with the access point disabled still ends with the access point up.
- [ ] Schema: add a confirmation window for an apply that moves the radio. Default 300 s, range as the existing timeout allows. **It is a new key, so nothing retires** — but re-read `retired.ts`'s contract before touching the schema.
- [ ] The engine selects that window when, and only when, the apply changes which mode the Wi-Fi radio is in. A configuration change that does not touch the radio keeps the 90 s it has now.

**Tests:** single-radio with a client configured yields one profile on that interface, not two; the raise-then-lower order holds; a failed association with `ap.enabled=false` still ends with the access point raised; the widened window applies only to a radio move.

**Verify:** `npm test`

---

## Task 6: make the device findable by name

**Requirements:** R-CFG-08, and the operator instruction Task 8's page has to give

- [ ] Install and enable Avahi in the installer so `system.hostname` resolves as `<hostname>.local` on the network the board joins.
- [ ] Set the system hostname from `system.hostname` — it is in the schema, defaults to `yonder`, and is currently read by nothing.
- [ ] This is what makes "find me at yonder.local" a true statement rather than a hopeful one. **Verify it resolves, or do not tell the operator to use it** — a printed instruction that does not work is worse than no instruction, because it costs the operator the time to discover it is wrong.
- [ ] If it cannot be made to work reliably, say so in the page and give the fallback (the router's client list), rather than shipping the nicer sentence.

**Verify:** resolve `yonder.local` from this machine against a device on the same network, or record plainly that it was not verified.

---

## Task 7: the contrib packages

**Requirements:** CLAUDE.md rule 2, R-UI-05

**Files:** Create `packages/node-red-contrib-yonder-system/` and `packages/node-red-contrib-yonder-network/`, each a real package with tests.

- [ ] Each node is a thin adapter over `src/console/client.ts`: it calls a route and emits the result. **No parsing, no formatting and no policy in a node** — those live in `yonder-core`, where they are tested without Node-RED.
- [ ] `yonder-system`: a `yonder-status` node (board facts, polled, never tighter than 2 s) and a `yonder-activity` node (the log).
- [ ] `yonder-network`: `yonder-config` (read), `yonder-scan`, `yonder-apply`, `yonder-confirm`.
- [ ] **The command-state language, built once** (ADR-0005's stated consequence, R-UI-05). Pending, confirmed and rejected must look and behave identically everywhere. Define it here, as a shared module both packages emit, before there are many controls to retrofit. This is the one piece of this milestone that gets harder the longer it is left.
- [ ] A node whose daemon call fails emits a rejected state, never a silent nothing. An operator must never be left looking at a control that did something unknown.
- [ ] Tests with `node-red-node-test-helper`, against a stubbed client. No test opens a socket.

**Verify:** `npm test`

---

## Task 8: the pages

**Requirements:** R-UI-01, R-UI-02, R-UI-05, R-UI-06, R-UI-07, R-NET-03, R-CFG-03

**Files:** Create `flows/flows.json`. Modify the installer to place it.

- [ ] **Status** — board model, CPU load and temperature, memory, uptime, OS and Yonder versions (R-SYS-01, R-SYS-02).
- [ ] **Network** — current state, a scan that lists what is in the air, a form to join one, and the apply/confirm cycle shown honestly (R-NET-03, R-CFG-03).
- [ ] **Log** — the live activity log, timestamped (R-DIA-05).
- [ ] **Diagnostics** — ping a host, check reachability (R-DIA-01, R-DIA-02).
- [ ] **The Wi-Fi form states, before the operator submits**, that the access point is about to go away, where to find the device afterwards, how long they have to confirm, and that the access point returns by itself if the password was wrong. Plain words. This is the single most important piece of copy in the product, because it is the moment an operator most easily concludes the device is broken.
- [ ] **Day and night themes, operator-selectable, day by default, persisted in `ui.theme`** (R-UI-07). Never inferred from the browser or the host — the requirement is explicit and ADR-0005 says why: in direct sunlight a dark screen is a mirror.
- [ ] Every asset served from the device (R-UI-01). **Assert it as a test**, as M1b-1 does for `setup.html` — a Dashboard theme that pulls a webfont from a CDN is exactly the regression this catches, and it fails silently in a lab with internet and loudly in a field without.
- [ ] No poll tighter than 2 s (R-UI-06).
- [ ] `flows.json` contains **no `function` node**. `settings.ts` already excludes the type; add a test that reads the shipped flows and asserts none is present, so the rule is enforced against the artefact and not only against the runtime.

**Verify:** `npm test`, then load the flows in a real Node-RED and confirm every page renders.

---

## Task 9: installer and documentation

- [ ] `30-console.sh` places `flows/flows.json` and installs both contrib packages into the console's tree.
- [ ] Avahi from Task 6, and the hostname applied.
- [ ] `docs/known-issues.md` — **narrow K-13**, saying what now arbitrates and what is still unresolved (concurrent AP and client on one radio). Do not strike it through; it is not closed.
- [ ] `docs/configuration.md` — `ui.theme`, the new confirmation window, `system.hostname` now having an effect.
- [ ] `docs/requirements.md` — add an ID for anything built here without one. Do not stretch an existing ID to cover new behaviour.
- [ ] `docs/roadmap.md` — M1b-2 done. **Leave M1a's outstanding cold boot exactly as it reads**, and do not let this milestone's completion imply M1 is closed: M1 closes on hardware, not here.

---

## Exit criterion

On this machine: the console serves four pages behind the login, every asset local, no `function` node in the shipped flows, themes switchable and persisted, and a Wi-Fi scan returning what a stubbed nmcli reports. A radio-moving apply selects the longer window, and a failed association with the access point disabled still ends with the access point up.

**M1 itself closes on a board, not here** — flash a card built from this branch, power it on, join `yonder`, set a password, scan, join a network, and get the access point back by entering the wrong one. That run is what M1a still owes and what this milestone finally makes possible.
