# CLAUDE.md — working notes for Yonder

Read this before doing anything in this repository.

## What this is

**Yonder** — an open-source 4G/5G companion computer for long-range UAS. A Raspberry Pi or
Radxa board rides on the aircraft beside an ArduPilot flight controller and carries
telemetry and video over the cell network to a browser and to a ground station. No cloud,
no activation, no phone-home.

Status: **pre-alpha**. Design and requirements are settled.

- **M0 — done.** The configuration schema, the apply/rollback engine with its confirmation
  timer, per-device secrets, the `yonder-core` daemon and the installer's role runner.
- **M1 — the network layer and the console are built**, and their mechanisms have each been
  seen working on a Raspberry Pi 4. **M1a is not finished**: a cold flash of a card built
  from this branch, powered on and left alone, has still not happened. See the
  [roadmap](docs/roadmap.md).
- **M2a — ZeroTier — done and proven on hardware.** Installed from the offline payload with
  no network, joined from the console, and the console reached over the mesh from a machine
  sharing no local network with the board.
- **M2b — Tailscale — not started.**

Using it on hardware is where the defects came from: see
[known-issues.md](docs/known-issues.md), particularly K-35 to K-39, all found by a person
pressing buttons on a real board rather than by a test.

## Rules that are not negotiable

### 1. This repository is self-contained.

`docs/requirements.md` is the definition of what Yonder must do, written in Yonder's own
voice. It is deliberately self-sufficient: **everything needed to build Yonder is in this
repository.**

- Do not add references to local paths, directories or files outside this repository.
- Do not describe Yonder by comparison to other products, and do not import terminology
  or framing from outside. State what Yonder does, positively.
- If something seems to be missing, add a requirement. Do not reach elsewhere for it.

`.gitignore` carries entries for scratch directories and image files. Do not remove them.

### 2. Logic lives in node packages, never in Node-RED function nodes.

A `function` node is JavaScript serialised into `flows.json` alongside wire coordinates. A
pull request against it is unreadable, so it cannot be reviewed, so it cannot be merged.

- Behaviour goes in `packages/node-red-contrib-yonder-*` — real npm packages, real source
  files, real tests. **Presentation too:** instruments are Vue components in
  `node-red-dashboard-2-yonder`, never markup pasted into a `ui-template`.
- Files in `flows/` are **wiring only**.
- `functionExternalModules` is off and the `function` node type is not enabled in the
  shipped profile.

This single rule is what makes the project contributable. See
[ADR-0001](docs/adr/0001-node-red-as-core.md).

### 3. Requirements first.

Every change traces to an ID in `docs/requirements.md` (`R-MAV-01`, `R-NET-07`, …). If the
thing you want to build has no requirement, add one in the same change. IDs are stable —
never reuse or renumber. Mark superseded requirements *withdrawn*, never delete them
(`R-PAR-05` is the worked example).

### 4. Yonder relays commands. It never originates them.

Yonder *does* command the aircraft — flight mode, parameter writes, payload outputs. What
it must never do is decide to send one: no autonomy, no control loops, no automatic
reaction to link loss or battery state. The autopilot owns all of that. See `R-CMD-04` and
`R-CMD-05`, and never weaken them.

### 5. Sign everything.

Commits and tags are GPG-signed. `commit.gpgsign` and `tag.gpgsign` are set in this repo.
Never commit with `--no-gpg-sign`, and never suggest it as a workaround if signing fails —
fix the signing instead.

### 6. Nothing may make the device unreachable.

Any change touching networking or configuration must work *with* the rollback engine and
the access-point fallback, not around it. `R-NET-07` and `R-CFG-03` are load-bearing.

### 7. The blueprint is the blueprint.

`docs/console/design/instrument-library/` holds the approved renders of every
console surface. **If a surface is drawn there, it should work.** If an element
in the blueprint needs another feature built to enable it, building that feature
is what is expected — not a narrower reading of the surface.

`docs/console/design/blueprint-manifest.md` lists every element of every
surface, and is the checkable form of that. A surface is finished when its
manifest is satisfied or each gap is deferred **with a named owner**. A deferred
item with no owner is indistinguishable from a closed one, and that is how three
controls went missing: the ground station's resolution picker, the action that
configures a detected camera, and the Cameras page's encode-headroom panel.

**A review reads a diff, and nothing in a diff is missing.** So a review of a
console surface must also read the blueprint render and the current capture
together, and answer *what is absent*. That question is not optional, and it is
the one the operator kept having to ask.

### 8. Conflicts are the operator's to decide, not yours.

The rules in this file always apply and are never absolutes. Where one collides
with the blueprint, a requirement, the substrate's limits or another rule, **stop
and put the choice to the operator, at the moment you meet it.** Present both
sides and your reading; do not resolve it and report a conclusion.

This is a correction, written down because it was got wrong: several such calls
were made unilaterally — whether a requirement was satisfied by a weaker
reading, whether a gate rule was stricter than its specification, whether a task
was blocked, whether a known defect could stay unfixed. Each was defensible and
none was ours to make.

## Settled — do not relitigate

| Decision | Where |
|---|---|
| Node-RED is the core, logic in custom nodes | [ADR-0001](docs/adr/0001-node-red-as-core.md) |
| GPL-3.0, DCO sign-off, no CLA | [ADR-0002](docs/adr/0002-licence-gplv3.md) |
| mediamtx for all media serving, not Janus | [ADR-0003](docs/adr/0003-mediamtx-not-janus.md) |
| ZeroTier primary, Tailscale second | [ADR-0004](docs/adr/0004-zerotier-primary-mesh-vpn.md) |
| Console visual language: a glass display in a carbon panel | [ADR-0009](docs/adr/0009-console-visual-language.md) |

Reopen only with new evidence, and say what changed.

## Where things are

| | |
|---|---|
| `docs/requirements.md` | 220 numbered requirements. The definition of done |
| `docs/architecture.md` | What runs and why; config model; rollback; security commitments |
| `docs/roadmap.md` | M0–M9, each with its requirement IDs and an exit criterion |
| `docs/configuration.md` | `config.yaml` reference |
| `docs/adr/` | Decision records |
| `packages/` | Node packages — where logic and presentation live |
| `flows/` | Shipped flows — wiring only |
| `installer/` | `install.sh` is the single source of truth; images are built from it |

## Conventions

- Node packages are published **unscoped** as `node-red-contrib-yonder-*` so Node-RED's
  palette manager finds them. `yonder-core` is a plain library. **One exception:**
  Dashboard 2.x discovers third-party widgets by the package name
  `node-red-dashboard-2-*`, so the instrument library is `node-red-dashboard-2-yonder`.
  The convention's purpose — a name the host discovers — is served by a different
  discoverer ([ADR-0009](docs/adr/0009-console-visual-language.md)).
- Config lives at `/etc/yonder/config.yaml`; secrets at `/etc/yonder/secrets.yaml`, mode
  `0600`, never in an image or a support bundle.
- One declarative file is the only writer. Everything else — mavlink-router config,
  NetworkManager keyfiles, mediamtx config — is generated from it.
- A node without tests will not be merged. `node-red-node-test-helper` runs them in CI.
- Commit messages: imperative mood, reference the requirement ID where one applies.
