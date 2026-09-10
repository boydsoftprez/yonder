# PR #7 reconciliation

PR #7, **Console instrument library and camera view, proven on hardware, with
the telemetry merge**, predates the combined application merged in PR #8.
It must not be merged wholesale over the current application.

The comparison uses PR #8's retained integration history (`ed66b1a`) as well as
the identical merged tree (`141dd3a`). A commit-count comparison with `main`
alone is misleading because PR #8 was squash-merged. Thirteen commits on #7's
side of the fork needed separate disposition.

## Disposition of all thirteen commits

| Commit | Historical change | Current disposition |
| --- | --- | --- |
| `fff85fe` | Shared RAM still generation and per-copy accounting | Retained by the newer `Stills`, `Viewers`, authenticated relay and thumbnail-demand implementation, including generation invalidation and completion timestamps. Browser coverage is restored here |
| `ae8cb0a` | Scope Live/Setup presses to soft keys | Preserve current exact-role Settings/Revert presses; scope legacy deck presses to `.y-keys__key`, and use explicit thumbnail/mode selectors in the new pair proof |
| `22f84e8` | Stopped thumbnail must not read Live | Current source captions and real-frame age handling already implement it; existing thumbnail tests cover stopped/no-image state |
| `7c89186` | Register R-VID-16, R-VID-17 and R-VID-18 | Restore the three original requirement rows without renumbering them. Their implemented output, adaptation and picture-state behavior already references those IDs |
| `a471636` | Standalone Picture/Aim on Cockpit, with independent capture rules | Current Cockpit wiring and standalone component tests retain the feature. Restore flow-derived viewport contracts and exercise the pair at notebook/tablet sizes without requiring a nonexistent deck or rail |
| `d7a9d97` | Aim feed/hint, confirmation pill, Live/Setup output split and unreachable count | Current guarded Aim feed and gestures retain the functional path. The approved R-UI-29 workspace replaces the old strip pill and Live/Setup composition with inline transaction results, staged output controls and per-output reachability. Do not resurrect the retired DTOs, navigation or presentation-only helpers |
| `821f108` | Remove an already-built rail from the missing-work table | Historical audit correction. The current manifest identifies the old camera composition as superseded by R-UI-29 |
| `2feace6` | Shared viewer-ID rule, confirmation semantics and audit corrections | Restore the shared boundary validator and reject trailing newlines. Current transaction tests cover automatic keep/confirm behavior; the old strip-pill field is retired |
| `f287910` | Document the then-missing slew route and clarify confirmation | The native guarded transport now exists. Keep current transport tests and documentation; do not overwrite the current unrelated K-62 entry with the old branch's numbering |
| `5cf86bd` | Two cameras, gimbal capability, real JPEGs and browser capture coverage | Adapt the real pipeline host/fake-GI fixture, decode JPEGs in the actual browser, verify nonzero copy accounting, selection, private display state and both independent surfaces; scope stale-debt checks to captured states |
| `73fdb7f` | Aim layout, separate refusal note, and empty mode controls | Keep current native speed/expo, modes, presets and guard logic. Port the display-only note override and empty-options guard; make narrow controls fit and retain their inhibition |
| `a8b00c4` | One aim dial and honest unreported positions | Current code already removes the deck dial and preserves null readings. Add browser assertions and restore per-axis explanations. No zero pointer is invented |
| `b9c98cb` | Refresh the historical missing/unowned table | Retain the current R-UI-29 manifest and this explicit reconciliation; historical row counts and colliding K-IDs are not current product status |

## Defects the restored checks exposed

- Thumbnail subscriptions were receiving private preview-state replies but
  dropping them. Stills mode therefore displayed the image without the R-VID-18
  mode/bitrate overlay. `ThumbnailDemand` now passes valid current replies to
  the selected Picture, without requiring an active WebRTC statistics session.
  Wrong-camera, retired-demand and closed-session replies are ignored.
- Gimbal range inputs inherited unreadable text color in Night mode. Their
  foreground now follows the existing value token.
- Two thumbnail rows could exceed the fixed 80 px strip and be hidden. The
  layout now accommodates the rows. The dedicated Camera picture retains its
  aspect-driven size; Cockpit still uses its configured slot.
- Gimbal speed/expo labels overflowed the narrow tablet panel. The controls stack
  inside a narrow Aim container.

These are display and validation repairs. They do not loosen motion guards,
change native travel limits, issue aircraft commands or alter device networking.

## Verification

The pair fixture has two configured, running UVC-style pipelines under the real
pipeline host with fake GStreamer. Its JPEGs are synthetic grey fields, not
hardware photographs. The first camera advertises generic gimbal bounds but
reports no position or guarded transport; its controls remain inhibited. The
second has no gimbal.

The browser proof checks decoded full-size stills and thumbnails, their age,
nonzero traffic, the private state overlay, one dial, null position readouts,
and switching to the second camera without retaining the first camera's Aim.
It runs on Camera and Cockpit in both palettes, with additional standalone
Cockpit notebook/tablet captures. The normal console gate still runs all prior
base, state, credential, rollback and viewport checks.

For focused development only:

```sh
PAIR_ONLY=1 ./scripts/verify-pages.sh
```

This is not the full gate. Normal CI leaves `PAIR_ONLY` unset. New geometry is
reviewed and committed for both macOS and Linux; an ordinary run must reproduce
it. Unit tests cover shared viewer validation, note/inhibition separation,
empty choices and stale/closed private-state responses.

Once this reconciliation is merged and checked, close #7 as superseded by #8
and this follow-up. Keep its historical record; do not merge its obsolete tree
or remove another checkout's unfinished work.
