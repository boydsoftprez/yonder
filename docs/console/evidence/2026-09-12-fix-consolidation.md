# September 11–12 fix consolidation

This audit preserves implemented fixes on `codex/onboard-terrain-service` and
records their source and PR coverage. It does not establish new hardware acceptance.

## Included history

The consolidation starts at CSI recovery commit `7c65c59`. Both the previous
terrain checkout `15e52d4` and current main `5c783e9` are ancestors. Main was fetched
again during consolidation and still pointed to `5c783e9`.

| Work | Source | Coverage |
| --- | --- | --- |
| Official onboard terrain and existing terrain work | `7f1dd56` | Merged PR #12, main `46913f1` |
| Pocket H.264 hardware decoding and fixed-height video status text | `500290b`, retained by `dc8e801` | Merged PR #13, main `be2626f` |
| Protected images, durable recovery, capture, image identity, storage and launcher fixes | Sep 11 image series through `28c7be0` | Merged PR #13 |
| Camera scene inside the PFD | `11d4a62` | Merged PR #14, main `5c783e9` |
| CSI startup without rebinding vendor sensor/receiver drivers | `bc499bc`, evidence correction `7c65c59` | PR #15, `codex/csi-startup-recovery` |

The Sep 11 image commits checked against main were `660cf31`, `d19d878`,
`9de2295`, `a3cf56b`, `9d680dd`, `21303f7`, `72d9a0e`, `2d9ea88`, `1626b81`,
`7adc663`, `2f3b450`, `76b061a`, `d1b36ad`, `d9923db` and `28c7be0`.
They are already ancestors of main; copying them again would add no fix.

## Rescued changes

| Fix | Previously stranded source | Preserved behavior |
| --- | --- | --- |
| Stable ArduPlane upload review | Uncommitted terrain-branch core/cockpit files and regression tests | Controller-owned home coordinate drift does not change mission-content revision; confirmation uses current reported home while real mission edits and changed command context still invalidate review. R-FLT-04. |
| Bank pointer direction | Uncommitted PFD component and attitude-direction test | Positive roll moves the pointer along the fixed bank scale in the correct direction; the horizon counter-rotates. R-FLT-01. |
| Persistent SeekerHD IQ tuning | Three uncommitted installer files based on `28c7be0` | Active IQ files live in persistent state, factory originals remain separate, reinstall preserves operator tuning, invalid topology is rejected and recognized interrupted migration resumes durably. Existing CSI startup guards remain. R-CAM-01, R-STO-03. |
| Bounded daemon requests | `46558de`, `e5b2172` | Default 1 MiB cap with existing narrower route limits and the larger recovery-preview exception; discard oversize requests, drain their remaining bytes, then return 413. R-SEC-15, K-06. |
| Reproducible cockpit guide | `238f0cf`, `2e6c808`, `8fc2e08` | Guide and sibling scripts use the header Display menu, current palette label and HOME marker; fixture instructions build core first. R-FLT-10/25, R-UI-12, K-69. |

The old body-limit design/plan commits `296f705` and `aa622a9` remain historical
sources. Their original R-SEC-13 identifier now names the committed media-listener
policy, so the recovered request-size contract uses the next unused ID, R-SEC-15.
The current recovery-preview allowance is retained rather than applying the old
1 MiB ceiling to archive imports.

The guide selector series predates official terrain on main. Its old test expected
Cove display data to provide ground/AGL and used a removed profile datum selector.
The integrated walkthrough instead checks that official ground and AGL stay
unavailable with only detailed Cove data; verified EGM96 permits the separate
surface comparison, and an unknown display datum suppresses it. Offline reload
explicitly reselects its data source and verified display datum. The fixture does
not impersonate a prepared official terrain service.

## Verification

- Production workspace build and TypeScript lint passed; schema/default generation
  produced no tracked changes.
- The final combined workspace run passed 5,626 tests with one skipped test.
- The full real daemon/Node-RED console page gate passed **219 checks, zero failures**,
  with geometry acceptance unset and both palettes exercised. It preceded the late
  request-cap port; final real Unix-socket tests cover that changed boundary.
- SeekerHD installer checks passed **18/18**, bootargs checks **16/16**, prepare checks
  **7/7**, and shellcheck passed for the three recovered installer files.
- The cockpit fixture guide passed **11 workflow groups and 28 captures**, including
  camera full/window states. The responsive verifier passed at 1440×900, 1024×768,
  768×1024 and 390×844, with no aircraft requests.
- Thirteen updated instructional captures were visually inspected. Three existing
  dialog captures differed only by 52–68 antialiasing pixels and were retained.
- One independent review covered mission/home, attitude and durable IQ migration.
  A narrow incremental review covered the later-discovered request cap and requested
  stronger slow-tail HTTP regression coverage.

The final HTTP regression cases hold the tail of both declared and chunked uploads,
observe no response during that hold, then release it and check 413 plus continued
service. A test-local early-response server proves that the gate observes an early
reply. The terrain walkthrough passed streaming, profile altitude editing, unknown
datum suppression and complete preload (812 ms with drawing off); offline reload
made zero relay requests. `guide-sitl.mjs` and `profile.mjs` received selector repairs
by inspection only; their live simulator runs were not part of this consolidation.

## Hardware and deployment boundary

This is a source consolidation and compiled-artifact rebuild. The older deployed
camera bundle explained why fixed-height status text returned despite its source
fix already being on main. A source update alone does not replace a deployed bundle.

PR #15 records the CSI boot observations separately. USB gadget teardown in the
vendor kernel and transient camera discovery causing selection to fall back to CSI
remain separate observed issues; this audit does not claim to resolve them. No
new mission, security or tuning deployment and no board reboot is part of this
consolidation. Official terrain hardware acceptance remains as documented in
[terrain service verification](../../terrain-service-verification.md).
