# ADR-0004 — ZeroTier as the primary mesh VPN, Tailscale second

**Status:** accepted · **Date:** 2026-08-31

## Context

Yonder needs NAT traversal so an operator can reach an aircraft that sits behind a mobile
carrier's CGNAT. R-VPN-01 requires a primary mesh VPN; R-VPN-02 requires a second,
independent one. Neither names a product, deliberately — requirements that name tools go
stale when tools change licence, get acquired, or die.

The two credible candidates are ZeroTier and Tailscale. Both are widely deployed, both
handle CGNAT, both report whether a path is direct or relayed.

## Decision

**ZeroTier is the primary.** It is the one implemented first, the one documented in the
quick start, and the one the default configuration is written against.

**Tailscale is the supported second.** Fully implemented, not a stub, but it lands after
ZeroTier works.

## Rationale

Driven mainly by the headless device experience, which is where the two genuinely differ:

- **A network ID is a configuration value; an auth flow is not.** Joining a ZeroTier
  network means putting a 16-hex network ID in `config.yaml`. That composes with
  R-CFG-01 (one declarative file) and R-CFG-05 (headless setup from the boot partition).
  Tailscale needs an auth key or an interactive login, which is awkward to express as
  configuration and awkward to perform on an aircraft with no screen.
- **No account on the device.** A ZeroTier node joins a network someone else administers
  and is authorised from the controller side. Nothing about the aircraft is tied to an
  identity provider.
- **The control plane can be self-hosted.** A ZeroTier controller and private roots can be
  run by the operator, so a network can exist without depending on any company remaining
  in business. That sits well with our first principle.
- **Licence.** The ZeroTier client is MPL-2.0 — GPL-3.0 compatible and redistributable in
  a published image. Tailscale's client is BSD-3-Clause and equally fine, so this is a
  supporting point rather than the deciding one.

## Why Tailscale is second rather than dropped

- Its NAT traversal is, by reputation and in practice, the stronger of the two.
- Many operators already run a tailnet and would rather add an aircraft to it than stand
  up something new.
- Headscale is a fully open reimplementation of its control plane, for operators who want
  one.

## Honest caveat

Neither control plane is unambiguously open. ZeroTier's network controller lives in the
project's `nonfree/` directory — source-available, not OSI-licensed. Tailscale's
coordination server is closed, with Headscale as an independent open alternative. So the
"self-hostable" advantage is real but narrower than it first appears, and it is not the
reason for the decision. The reason is that a network ID fits in a config file and a login
does not.

## Consequences

- The default configuration ships `zerotier` present and disabled, with `network_id: null`.
- Quick-start documentation uses ZeroTier throughout.
- M1 implements ZeroTier first and Tailscale second; the milestone is not complete until
  both work (R-VPN-02).
- Neither is enabled by default (R-VPN-05). A device with no VPN configured must remain
  fully functional on a local network.
