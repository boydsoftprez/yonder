# ADR-0006 — Drive NetworkManager through `nmcli`, not D-Bus

**Status:** accepted · **Date:** 2026-09-01

## Context

M1 introduces the first real renderer: the component that turns `network:` in
`config.yaml` into a working access point, Wi-Fi client and Ethernet connection.
NetworkManager offers two control surfaces — a D-Bus API, and the `nmcli` command.

[`architecture.md`](../architecture.md) states a general preference: talk to system services
over their real interfaces rather than shelling out and parsing text *where an interface
exists*. NetworkManager has one. This ADR records a deliberate exception and the reasoning,
so it is a decision rather than a drift.

## Decision

The network renderer drives NetworkManager by **executing `nmcli` with its terse,
machine-readable output mode** (`-t -f <fields>`), through an **injected command runner** so
that no test ever shells out.

## Rationale

- **The D-Bus surface is large and the useful part is small.** Doing this properly over
  D-Bus means modelling Settings, Connection, Device, ActiveConnection and AccessPoint
  objects and their signals. We need perhaps a dozen operations. The abstraction cost is not
  repaid.
- **`nmcli -t` is a supported machine interface, not screen-scraping.** Terse mode exists for
  scripting: stable field names, one record per line, documented escaping. Parsing it is not
  the fragile exercise that parsing human-readable output would be.
- **One dependency fewer on a 512 MB board.** A Node D-Bus client is another package, another
  failure mode, and another thing to keep working across two distributions.
- **Every action is reproducible by hand.** The renderer logs the exact command it ran. When
  a device is 3 km away on a cellular link, being able to read a log line and then type that
  same command over SSH is worth a great deal. A D-Bus call is not reproducible that way.
- **The seam is naturally testable.** The renderer takes a runner — `(argv: string[]) =>
  Promise<{code, stdout, stderr}>`. Tests inject a fake that asserts on argv and returns
  canned output, so the whole renderer is unit-testable with no NetworkManager present.

## Consequences

- **`nmcli` output parsing is a real surface and must be treated as one.** Terse mode escapes
  colons inside values with a backslash; the parser handles that, and it is tested against
  recorded real output rather than invented strings.
- **Field lists are pinned explicitly.** Every call names the fields it reads with `-f`, so
  a distribution shipping a different default field order cannot silently change what we
  parse.
- **Distribution differences are a real risk.** The two supported bases ship different
  NetworkManager versions. Recorded fixtures come from both, and the parser tests run
  against both.
- **Shelling out stays confined to renderers.** This is not a general licence. Everywhere
  else, if a service offers a real interface, use it.
- If the parsing surface ever becomes the source of recurring bugs, the injected runner is
  also the seam along which a D-Bus implementation could be substituted without touching
  the renderer's callers.
