# CLAUDE.md — working notes for Yonder

Read this before doing anything in this repository.

## What this is

**Yonder** — an open-source 4G/5G companion computer for long-range UAS. A Raspberry Pi or
Radxa board rides on the aircraft beside an ArduPilot flight controller and carries
telemetry and video over the cell network to a browser and to a ground station. No cloud,
no activation, no phone-home.

Status: **pre-alpha**. Design and requirements are settled. M0 is complete — the
configuration schema, the apply/rollback engine with its confirmation timer, per-device
secrets, the `yonder-core` daemon and the installer's role runner. M1, the first-boot
console, is next.

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
| `docs/requirements.md` | 156 numbered requirements. The definition of done |
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
