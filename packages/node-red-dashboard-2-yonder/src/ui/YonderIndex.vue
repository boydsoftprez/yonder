<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-idx">
        <div class="y-idx__placard">
            <YonderPlacard kind="Cameras" />
            <span class="y-idx__summary">{{ summaryText }}</span>
        </div>
        <div class="y-idx__display">
            <YonderColumn legend="Flying">
                <template v-if="cameras.length">
                    <div
                        v-for="cam in cameras"
                        :key="cam.id || cam.bus"
                        class="y-idx__cam"
                    >
                        <span class="y-idx__nm"><b>{{ cam.name }}</b><span>{{ cam.bus }}</span></span>
                        <span class="y-idx__sp">
                            <span class="y-idx__a">{{ cam.spec }}</span>
                            <span v-if="cam.identity" class="y-idx__id">{{ cam.identity }}</span>
                            <span class="y-idx__b">{{ probeSummary(cam) }}</span>
                        </span>
                        <span class="y-idx__st">
                            <span class="y-idx__ann" :class="toneClass(cam.tone)">
                                <i aria-hidden="true" /><span>{{ cam.state }}</span>
                            </span>
                            <YonderReadout :rows="[{ label: '', value: rateValue(cam), unit: 'Mb/s' }]" />
                        </span>
                        <button
                            type="button"
                            class="y-idx__open"
                            :disabled="!cam.id"
                            :title="cam.id ? 'Open ' + cam.name : 'No page: this camera is not configured'"
                            @click="open(cam.id)"
                        >OPEN<i aria-hidden="true">&rsaquo;</i></button>
                    </div>
                </template>
                <p v-else class="y-idx__none">No camera.</p>
            </YonderColumn>

            <YonderColumn v-if="rejected.length" legend="Seen, and not usable" qualifier="why">
                <div v-for="r in rejected" :key="r.device" class="y-idx__rej">
                    <span class="y-idx__dev">{{ r.device }}</span>
                    <span class="y-idx__why">{{ r.reason }}</span>
                </div>
            </YonderColumn>
        </div>
    </div>
</template>

<script>
import YonderPlacard from './YonderPlacard.vue'
import YonderColumn from './YonderColumn.vue'
import YonderReadout from './YonderReadout.vue'
import { summarise } from 'yonder-core/presentation'

/**
 * `ui-yonder-index` — the Cameras page: what the probe found, and what it
 * refused (R-CAM-12).
 *
 * R-CAM-12 asks for three things — what was found, what was rejected, and
 * why — and the rejection half is the point this whole page exists for. A
 * camera that is plugged in and simply absent, with nothing explaining it,
 * is the failure the requirement is written against; it happened repeatedly
 * on the bench this session (task-24-brief.md). So a rejection row without
 * its reason would defeat the page, and an empty found list that renders as
 * a blank pane would be indistinguishable from a page that failed to load
 * at all — both are drawn as explicit facts here, never as silence.
 *
 * **The payload is this node's own shape**, assembled server-side (a later
 * wiring task, the same way `camera.ts` builds `ui-yonder-deck`'s payload):
 *
 * ```
 * { cameras: { id, name, bus, spec, state, tone, rate,
 *              capabilities: CameraCapabilities }[],
 *   rejected: { device, reason }[] }
 * ```
 *
 * `tone` is one of `'good' | 'waiting' | 'bad' | 'neutral'` — the same
 * closed register `CommandPresentation` uses everywhere else in this
 * project (`console/command.ts`), decided by whoever knows the camera's own
 * run-state vocabulary (a supervisor's "streaming"/"idle"/"error" words are
 * not enumerable from this file, unlike a `Capability`'s four states) and
 * handed down already paired with the caption. This component only ever
 * maps a *recognised tone keyword* to a colour — never a raw string to a
 * raw colour — falling back to the neutral border for anything it does not
 * recognise, the same "a lookup, not a ternary" rule `YonderColumn` states
 * for its own `tone` prop.
 *
 * **`rate` is `null` while a camera is not streaming, never hidden.** The
 * same absent-versus-zero distinction `YonderReadout` exists to draw is
 * applied here at the field level: a camera with nothing to report a rate
 * for reads "none", not a gap where a number would have been.
 *
 * **Reused, not redrawn:**
 * - `YonderPlacard` draws the "Cameras" nameplate. Its own layout is one
 *   packed-left phrase (`kind · name`), not the blueprint's two-ended
 *   header, so the trailing "N found · M rejected" summary is composed
 *   beside it in this file's own markup rather than forced into `name` —
 *   using the part for what it draws and no further.
 * - `YonderColumn` groups both lists ("Flying"; "Seen, and not usable",
 *   qualified "why") exactly as it groups a deck's own control groups —
 *   its contract (a legend, an optional qualifier, a slot) is generic, not
 *   deck-specific, and this page is the same molecule with rows in the
 *   slot instead of controls.
 * - `YonderReadout` draws each rate — inheriting its absence handling and
 *   its unit-casing fix (`Mb/s`, never `MB/S`) rather than a second copy
 *   of either rule (CLAUDE.md, project-wide; coordinator resolution 3).
 * - `summarise()` (`yonder-core`'s `video/capability.ts`, re-exported from
 *   `yonder-core/presentation` for this component to reach it) writes the
 *   probe-summary line — `exposure: auto exposure has it`, `aim: none` —
 *   over all 21 capability keys. Composing a second, shorter sentence with
 *   the same job was exactly what coordinator resolution 7 warned against;
 *   this draws its literal output, however long, not a trimmed paraphrase
 *   of it.
 *
 * **`YonderAnnunciator` does not fit here, and is not used.** Two
 * independent reasons, either alone sufficient: first, it reads a live
 * `CommandStatus` from `$store.state.data.messages[this.id]` — keyed by a
 * *Node-RED node's own id* — and a camera row is an element of an array
 * inside one widget's own payload, not a node with an id of its own to key
 * a store slot on. Second, even given an id, its vocabulary is
 * `presentation()`'s `idle | pending | confirmed | rejected` — the apply/
 * confirm command-state language (ADR-0005) — and "Streaming"/"Idle" is a
 * camera's run state, a different vocabulary entirely; routing it through
 * `presentation()` would show the wrong words in the wrong colour. So the
 * badge below is this file's own small pill, built from the same
 * lamp-and-caption shape R-UI-11 established and the same four-tone
 * palette (`--yonder-good/-waiting/-bad/-label`) every tone-driven part in
 * this library already draws from — not a new visual language, just not
 * routed through a component whose runtime coupling does not apply here.
 *
 * **Simplifications from the blueprint** (`docs/console/design/camera-view/
 * cameras-index-day-v2.html`), each because Step 1 does not test it and
 * inventing an untested field or control risked exactly the drift this
 * plan's coordinator has flagged elsewhere:
 * - No thumbnail. The blueprint's sky/ground rectangle is decorative CSS
 *   art standing in for a camera preview, backed by no field this payload
 *   carries and no behaviour Step 1 names.
 * - `spec` is one field, not the blueprint's separate spec/encoder pair —
 *   Step 1 names "spec" once, not two facts.
 * - No "detected HH:MM:SS" clock in the placard. Stamping a wall-clock
 *   instant is more honestly the job of whatever assembles this payload
 *   (it knows when the probe ran); computing one from `Date.now()` inside
 *   this component would be impure and untestable. The placard here states
 *   the two counts the payload actually carries.
 * - No "Detect again" / "Add by address" / "Apply" key row and no board/
 *   uplink budget columns — both are separate sibling widgets on the
 *   composed Cameras page (`ui-yonder-softkeys`, `ui-yonder-budget`; see
 *   the master plan's Task 28 test stub, "draws the Cameras page from
 *   index, budget, softkeys"), not this node's own concern.
 *
 * **Report-null and report-empty read identically: both draw "No camera."**
 * Step 1 names one empty behaviour, not `YonderAim`'s own separate
 * "waiting for a report at all" wording — that panel's three-way split
 * answers a four-state capability machine this page has no equivalent of.
 * Collapsing the two here is deliberate: an operator still sees a concrete,
 * drawn sentence rather than blank space either way, which is the actual
 * guarantee coordinator resolution 4 asks for.
 */
const TONE_CLASS = {
    good: 'tone-good',
    waiting: 'tone-waiting',
    bad: 'tone-bad',
    neutral: 'tone-neutral'
}

export default {
    name: 'YonderIndex',
    inject: ['$socket', '$dataTracker'],
    components: { YonderPlacard, YonderColumn, YonderReadout },
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        /** The whole report, live in preference to configured — the same
         * rule `YonderDeck` and `YonderAim` each state for their own payload.
         * `props.report` is a convenience for the gallery and a test, not a
         * promise that a real page shows anything before the first message. */
        report () {
            const live = this.$store && this.$store.state && this.$store.state.data
                ? (this.$store.state.data.messages && this.$store.state.data.messages[this.id]
                    ? this.$store.state.data.messages[this.id].payload
                    : undefined)
                : undefined
            if (live && typeof live === 'object') return live
            const fallback = this.props.report
            return fallback && typeof fallback === 'object' ? fallback : null
        },
        cameras () {
            return this.report && Array.isArray(this.report.cameras) ? this.report.cameras : []
        },
        rejected () {
            return this.report && Array.isArray(this.report.rejected) ? this.report.rejected : []
        },
        summaryText () {
            return `${this.cameras.length} found · ${this.rejected.length} rejected`
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        /** Every message this node posts leaves through here — one seam,
         * the same reasoning `YonderDeck`'s and `YonderAim`'s own `post()`
         * give for having exactly one. */
        post (payload) {
            this.$socket.emit('widget-action', this.id, { payload })
        },
        /** The id, never the row's own index in `cameras` (coordinator
         * resolution 5) — the index is a fact about an array, and every
         * consumer downstream maps a camera by its id.
         *
         * **A row with no id posts nothing.** A camera detected on a socket
         * nothing is configured for has no page to open (R-UI-03), and a
         * press that reached the flow with a null id would open a page whose
         * every widget then asks the daemon about a camera that is not in the
         * configuration — 404 on each, "not answering" on every badge. The
         * key is disabled as well; both, for the reason `YonderShutter` gives
         * for guarding twice — a dispatched click reaches a disabled button's
         * listener in a real browser. */
        open (id) {
            if (!id) return
            this.post({ camera: id })
        },
        toneClass (tone) {
            return TONE_CLASS[tone] || ''
        },
        /** Defensive against a row with no `capabilities` object at all —
         * `summarise()` itself has no such guard, since every other caller
         * in this codebase always has a real `CameraCapabilities`. */
        probeSummary (cam) {
            return cam && cam.capabilities && typeof cam.capabilities === 'object'
                ? summarise(cam.capabilities)
                : ''
        },
        rateValue (cam) {
            return typeof cam.rate === 'number' ? cam.rate : null
        }
    }
}
</script>

<style scoped>
.y-idx {
    font-family: var(--yonder-font, system-ui, sans-serif);
}
.y-idx__placard {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
}
.y-idx__summary {
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}
.y-idx__display > * + * {
    border-top: 1px solid var(--yonder-divider, #2b333c);
}
/* The fallback once a container is narrower than a row's own minimum width
   (see `.y-idx__cam`'s own comment) — a horizontal scrollbar, not a page
   whose text wraps into an unreadable, thousands-of-pixels-tall column. */
.y-idx__display { overflow-x: auto; }

/*
 * `minmax(140px, 1fr)` on the spec column, not a bare `1fr`: a bare `1fr`
 * beside three fixed-width neighbours has no floor, and this file's own
 * `.y-idx__sp` sets `min-width: 0` (needed so the flex child inside it can
 * shrink at all) — the two together let the grid track collapse all the way
 * to zero once the row's total fixed width alone exceeds its container,
 * rather than merely getting narrow. At zero width, `summarise()`'s ~21-key
 * line (`overflow-wrap: break-word`, needed for a genuinely narrow-but-real
 * column) has nowhere to wrap but one glyph per line — thousands of pixels
 * tall, discovered rendering this in the gallery's own ~440px-wide cell
 * before shipping it. `minmax(140px, 1fr)` gives the column a floor no
 * container is allowed to squeeze past; `.y-idx__display`'s own
 * `overflow-x: auto` is the fallback once a container is narrower than the
 * row's own minimum total width — a horizontal scrollbar on a page nobody
 * has actually shrunk that far, rather than a page that is unreadable
 * vertically for everyone.
 */
.y-idx__cam {
    display: grid;
    grid-template-columns: 150px minmax(140px, 1fr) 168px 76px;
    gap: 16px;
    align-items: center;
    width: 100%;
    min-width: 480px;
    padding: 11px 0;
    background: transparent;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--yonder-divider, #2b333c) 55%, transparent);
    text-align: left;
    color: var(--yonder-value, #ffffff);
    font: inherit;
}
.y-idx__cam:first-of-type { border-top: 0; }
.y-idx__cam:hover { background: color-mix(in srgb, var(--yonder-value, #ffffff) 3%, transparent); }
/* **The row is a row and the key is the key** (R-UI-10). The whole row was
   the `<button>`, which made every one of them an action 934 px wide in a
   966 px page — *no action occupies the full width of the surface it sits
   on*, measured in the DOM by the capture gate rather than argued about.
   The row keeps its hover, so it still reads as one thing; what an operator
   presses is a key sized to what it says, at the end of the row where the
   chevron already pointed.

   `:disabled` rather than absent: a camera detected on a socket nothing is
   configured for has no page to open (R-UI-03), and a key that is missing
   for that reason is indistinguishable from a page that failed to draw it.
   44 px tall, which is a finger on a tablet (spec §5). */
.y-idx__open {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 44px;
    padding: 0 10px;
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: 2px;
    background: transparent;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.13em;
    color: var(--yonder-label, #7f8a95);
    cursor: pointer;
}
.y-idx__open:hover:not(:disabled) {
    color: var(--yonder-value, #ffffff);
    border-color: var(--yonder-select, #2ad4f0);
}
.y-idx__open:disabled { cursor: not-allowed; opacity: 0.45; }
.y-idx__open i { font-size: 15px; font-style: normal; }

.y-idx__nm { display: flex; flex-direction: column; gap: 3px; }
.y-idx__nm b { font-size: 13.5px; font-weight: 600; }
.y-idx__nm span {
    font-size: 9.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}

.y-idx__sp { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.y-idx__a { font-size: 12px; }
/* **R-CAM-05, in the only form an operator can act on.** `identityWords()`
   answers either "…-video-index0 — survives a reboot" or "…— an enumeration
   number; it may mean a different camera after a reboot", and the second is
   the whole reason the field exists: a camera held by an enumeration number
   will mean a different device after the next boot, and the operator is the
   only one who can move the plug or fix the configuration. It was composed on
   every row and drawn on none. Wraps rather than being cut off — a by-path
   name is 66 characters before the sentence starts. */
.y-idx__id {
    font-size: 10.5px;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    color: var(--yonder-neutral, #7d7869);
    overflow-wrap: break-word;
}
.y-idx__b {
    font-size: 10.5px;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    color: var(--yonder-label, #7f8a95);
    overflow-wrap: break-word;
}

.y-idx__st { display: flex; flex-direction: column; gap: 5px; align-items: flex-end; }
.y-idx__ann {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 2px;
    border: 1px solid var(--yonder-label, #7f8a95);
    color: var(--yonder-label, #7f8a95);
    font-size: 9.5px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    white-space: nowrap;
}
.y-idx__ann i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
    flex: none;
}
.y-idx__ann.tone-good { border-color: var(--yonder-good, #35d06a); color: var(--yonder-good, #35d06a); }
.y-idx__ann.tone-waiting { border-color: var(--yonder-waiting, #ffcf28); color: var(--yonder-waiting, #ffcf28); }
.y-idx__ann.tone-bad { border-color: var(--yonder-bad, #ff4034); color: var(--yonder-bad, #ff4034); }
.y-idx__ann.tone-neutral { border-color: var(--yonder-label, #7f8a95); color: var(--yonder-label, #7f8a95); }

.y-idx__none {
    margin: 0;
    padding: 11px 0;
    font-size: 12px;
    color: var(--yonder-neutral, #7d7869);
}

.y-idx__rej {
    display: grid;
    grid-template-columns: 152px minmax(180px, 1fr);
    gap: 16px;
    padding: 10px 0;
    min-width: 380px;
    border-top: 1px solid color-mix(in srgb, var(--yonder-divider, #2b333c) 55%, transparent);
}
.y-idx__rej:first-of-type { border-top: 0; }
.y-idx__dev {
    font-size: 11.5px;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    color: var(--yonder-value, #ffffff);
}
.y-idx__why { font-size: 12px; color: var(--yonder-label, #7f8a95); line-height: 1.5; }
</style>
