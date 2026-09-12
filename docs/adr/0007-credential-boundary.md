# ADR-0007 — The credential boundary is the console, not the access point

**Status:** accepted · **Date:** 2026-09-01 · **Amends:** R-SEC-01

## Context

M0 and M1a generate a per-device access-point passphrase on first boot and print it to
standard output, which goes to the journal.

That is circular. **To read the journal you must be on the device; to reach the device you
must have the passphrase.** A published image would therefore ship a credential no operator
could ever retrieve. The only recovery would be to power down, pull the card, and read a
file on the boot partition — for a step that every single user hits, every single time.

Security the legitimate operator cannot get past is not security. It is a defect, and the
predictable response is that everyone finds a way to switch it off.

## Decision

**The setup access point carries a published default passphrase.** It is documented, it is
the same on every device, and it is never presented as a secret.

**The console requires an administrator password set by the operator at first use**, and
offers nothing whatsoever until it is set.

First contact with a new device is therefore:

1. Flash, insert, power on.
2. Join the `yonder` access point with the published passphrase.
3. Open the console. It offers exactly one thing: set an administrator password.
4. Everything else unlocks once that is done.

## Rationale

- **The passphrase was guarding the wrong thing.** The console is what can set a flight
  mode, write an autopilot parameter and fire a payload relay. That is the boundary worth
  defending, and it is where the credential now sits.
- **A per-device passphrase bought nothing a console password does not buy better.** Someone
  in radio range can join the network either way; the difference is whether they then meet a
  login. They now do.
- **It is the model every consumer router uses**, so it needs no explaining to anyone.
- **It makes "flash it and it works" true**, which is M1's whole exit criterion.

## Consequences

- **R-SEC-01 is amended** — a shared default is permitted for the setup access point, and
  forbidden for anything protecting the vehicle or its configuration.
- **R-SEC-09 is added** — the console must refuse every function until an administrator
  password exists.
- **R-CFG-08 is added** — a freshly flashed device must reach a joinable, usable state with
  no operator input at all.
- The access-point passphrase appears in the README and in the setup documentation. It must
  never be described as secret anywhere, in docs or in the interface, because describing a
  published value as a secret teaches people the wrong thing about the rest of the system.
- The console should say plainly when the access point is still on its default passphrase,
  and offer to change it. A nudge, not a block.
- `editor_password` is **no longer generated at first boot**. It does not exist until the
  operator sets it, which is what makes the setup step meaningful.

## The hole, stated plainly

Between power-on and the operator setting a password, anyone in radio range could join and
set it first. That is a window of a minute or two with the operator standing beside the
board, and it is the same trade every router on the market makes.

Mitigations exist — restricting setup to a period after boot, or requiring physical access —
and none is worth building now. If field experience shows it matters, the fix is small and
this ADR gets a successor.

## Linux owner access and recovery — 2026-09-10

[ADR-0010](0010-image-storage-and-owner-recovery.md) adds an independent Linux owner
account, optional SSH password/key authentication and reauthenticated plain owner recovery
archives. The public AP and first-console-password boundary above remain unchanged.
