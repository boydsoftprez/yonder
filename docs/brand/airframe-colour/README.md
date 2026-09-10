# Yonder — split Y, colour, and material

The approved modern airframe emblem remains the basis of this study. Its pointed
central fuselage and two rigid swept wing panels are paired with the titlecase
wordmark, now incorporating the earlier split-Y construction.

The detached upper-left arm of the Y repeats the separation between the aircraft's
wing panels and fuselage. Blue on those wings and the detached arm ties the emblem
and lettering together; the remainder uses graphite.

## Colour is part of the identity

Monochrome was a design-development choice, not a project-wide ban on colour.
A single-colour version is useful for small console headers, labels, and engraving.
The existing requirements also permit colour, gradients, and generated material
effects: [ADR-0009](../../adr/0009-console-visual-language.md) and R-UI-13 require
runtime interface material to be generated from stylesheet and vector rules.

The console reserves strong colours for operational meaning. A coloured identity
can have more presence on the login screen, while a neutral compact variant can
sit quietly beside live readings. This is a placement decision, not a requirement
that the entire brand always be monochrome.

## Treatments

- **Solid colour:** sectional-blue wing panels and the detached arm of the Y,
  with a graphite fuselage and remaining lettering. The primary colour proposal.
- **Linework:** the same emblem in a controlled outline, paired with filled
  lettering. A secondary graphic treatment that needs sufficient display size.
- **Material:** the same geometry with a restrained blue anodized-metal finish,
  satin graphite, shallow depth, and a fine edge highlight. A larger-format
  brand treatment for exploration.

The palette uses sectional blue `#2c5f8f`, graphite `#1b1811`, and chart paper
`#f6f1e3` from the console's existing day palette.

The board is an image-generated concept, not a runtime asset. `prompt.txt` records
the exact edit brief; `split-correction-prompt.txt` records the targeted correction
that physically separates the blue arm of the Y from the dark stem. The built-in
image generation tool produced the artwork. This board is the visual reference
for the [production SVG assets](../approved/README.md).
