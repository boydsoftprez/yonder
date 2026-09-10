# Contributing to Yonder

## The one rule that matters

**Logic goes in node packages. Never in Node-RED function nodes.**

A `function` node is JavaScript typed into a box and serialised into `flows.json`
alongside every wire and pixel coordinate. A pull request against it is unreadable, so it
cannot be reviewed, so it cannot be merged. A project that cannot take pull requests is
not open source.

So:

- Behaviour goes in `packages/node-red-contrib-yonder-*` — ordinary npm packages with
  source files, tests and versions.
- Flows in `flows/` are **wiring only**: nodes and connections, no embedded code.
- A PR whose main change is a `flows.json` diff will be asked to move the logic into a
  node. This is not pedantry; it is the difference between a repo that survives and one
  that does not.

## Contributing code you have the right to contribute

Only submit work that is yours to give, or that carries a licence compatible with
GPL-3.0 and is attributed in the PR.

**Do not paste code from other projects or products into an issue or a pull request**,
whatever its licence, without saying where it came from. Reimplementations of
functionality you have seen elsewhere are welcome; copies are not. If you are unsure
whether something you are contributing is encumbered, say so before you open the PR — it
is far easier to sort out beforehand.

## Before you start

- For anything beyond a bug fix, open an issue first. The [roadmap](docs/roadmap.md) has
  an order, and work that jumps it may not land.
- Check [`docs/requirements.md`](docs/requirements.md). If you are implementing a
  requirement, reference its ID (`R-MAV-01`, `R-NET-07`, …) in the PR. If the thing you
  want to build has no requirement, propose one in the same PR.

## Development

```bash
npm install          # workspace install across packages/
npm test             # unit tests, all packages
npm run lint
```

Node packages are tested with `node-red-node-test-helper`. **A node without tests will not
be merged** — that is the whole reason logic lives in nodes.

## Commits and PRs

- Sign off every commit: `git commit -s`. We use the
  [DCO](https://developercertificate.org/). No CLA, no copyright assignment — this project
  will not be relicensed out from under you.
- One logical change per PR.
- If behaviour changes, update the docs in the same PR.

## Safety

This software talks to an aircraft. Two things are non-negotiable:

1. **We relay commands; we never originate them.** Yonder can set a flight mode, write an
   autopilot parameter and fire a payload output — all real commands that change how an
   aircraft flies. What it must never do is decide to send one on its own: no autonomy, no
   control loops, no automatic reaction to link loss or battery state. A PR that adds
   flight logic will be declined. See R-CMD-04 and R-CMD-05.
2. **No configuration change may make the device unreachable.** If your change touches
   networking, it must work with the AP-fallback and rollback machinery, not around it.

## Hardware you do not have

Most contributors have one board. That is fine — say in the PR what you tested on.
Board-specific preparation lives in the installer roles and the documented
hardware bring-up sources. Link the exact board/OS evidence so an owner can review it.


## Versions and user documentation

Use the shared monthly CalVer described in [versioning](docs/versioning.md).
`npm run version:set -- YYYY.M.RELEASE` updates first-party metadata;
`npm run version:check` verifies it. Keep the configuration schema version separate.

User-facing changes belong in the [user guide](docs/user-guide.md) and, when
setup changes, [getting started](docs/getting-started.md). Keep the README’s tested
hardware table tied to evidence. Screenshots must identify fixture or simulator
state and must not expose credentials.
