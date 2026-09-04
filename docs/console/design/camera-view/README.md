# The camera view, as it was designed

These are the mockups from the brainstorming session that produced
[the camera view design](../../../superpowers/specs/2026-09-03-camera-view-design.md).
They are the agreed visual target, and they are committed here because they were
written to a scratch directory that `.gitignore` covers and came within one
cleanup of being lost.

**`page-anatomy-v2.html` is the one that matters most.** Three arrangements were
drawn; **layout B — picture on top, control deck below — is the one chosen**, on
the grounds that it is the same arrangement at every width, so there is one page
to design and one page for the capture gate to photograph.

## What they show that the built page does not

The M4 build delivered the structure and the behaviour these describe, and much
less of the instrument detail. Its Live deck carries two controls where layout B
carries about twelve, and eleven of the twenty-three widgets on the two camera
pages are stock Dashboard controls rather than instruments — which is the thing
[ADR-0009](../../../adr/0009-console-visual-language.md) exists to prevent.

The cause is recorded so it is not repeated: the spec described the deck's
*behaviour* — the three legends, which control applies live — and never said
"every control is an instrument, and here is the list". The plan inherited that
gap and filled it with what Dashboard already shipped.

These files are a record, not a build input. They are hand-written HTML with
inline styles and they are not wired to anything.
