<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-caps">
        <div class="y-caps__h">
            <span>Captures · {{ heldHere }}</span>
            <em v-if="listable" class="y-caps__n">{{ captures.length }} saved</em>
        </div>

        <p v-if="!report" class="y-caps__none">Waiting for this camera's captures.</p>
        <p v-else-if="!listable" class="y-caps__none">{{ report.reason || 'The camera holds these files; Yonder cannot list or download them.' }}</p>
        <p v-else-if="!captures.length" class="y-caps__none">Nothing saved to this board yet.</p>

        <ul v-else class="y-caps__list">
            <li v-for="c in captures" :key="c.name" class="y-caps__row">
                <img
                    v-if="showsThumb(c)"
                    class="y-caps__thumb"
                    :src="urlFor(c)"
                    alt=""
                    @error="thumbFailed(c)"
                />
                <span v-else class="y-caps__thumb y-caps__thumb--none">{{ kindOf(c) }}</span>

                <span class="y-caps__meta">
                    <b>{{ whenOf(c) }}</b>
                    <em>{{ sizeOf(c) }}</em>
                    <em v-if="onCamera(c)" class="y-caps__oncam">
                        {{ heldWordsFor(c) }} holds this — Yonder never saw the file
                    </em>
                </span>

                <span v-if="!onCamera(c)" class="y-caps__keys">
                    <template v-if="confirming === c.name">
                        <span class="y-caps__ask">Delete this?</span>
                        <button
                            type="button"
                            class="y-caps__key y-caps__key--warn"
                            @click="remove(c)"
                        >DELETE</button>
                        <button type="button" class="y-caps__key" @click="confirming = null">KEEP</button>
                    </template>
                    <template v-else>
                        <button type="button" class="y-caps__key" @click="view(c)">
                            {{ opened === c.name ? 'CLOSE' : 'VIEW' }}
                        </button>
                        <a class="y-caps__key" :href="urlFor(c)" :download="c.name">DOWNLOAD</a>
                        <button type="button" class="y-caps__key" @click="confirming = c.name">DELETE</button>
                    </template>
                </span>

                <span v-if="opened === c.name" class="y-caps__open">
                    <img v-if="isStill(c)" :src="urlFor(c)" :alt="c.name" />
                    <video v-else :src="urlFor(c)" controls preload="metadata"></video>
                </span>
            </li>
        </ul>

        <div v-if="listable" class="y-caps__fine">
            free space is stated under the shutter key · deleting is immediate and cannot be undone
        </div>
    </div>
</template>

<script>
import { captureUrl, heldWords } from 'yonder-core/presentation'

/**
 * `ui-yonder-captures` — what this board is holding, and the three things
 * that can be done with one (R-CAM-18, blueprint L-48).
 *
 * **A panel, not a page.** The blueprint draws it as a popover hanging off
 * the `CAPTURES ›` link in the deck's capture column, and this is the same
 * content in a widget of its own: Dashboard 2.x composes a page out of
 * widgets in groups, and one widget cannot render inside another widget's
 * column. So the link in the deck asks for this list and this panel draws it,
 * in its own group beside the deck. **That is a divergence from the render
 * and it is written down here and in the manifest**, because a divergence
 * nobody wrote down is how this console drifted from the blueprint before.
 *
 * **Three keys, and a camera-held capture gets none of them** (R-CAM-18).
 * Yonder never saw a file the camera holds: the fetch refuses it, the delete
 * refuses it, and offering either would be the console claiming something it
 * does not have. The row is still listed — a photograph that exists and is
 * not here is a fact the operator needs — with the sentence saying where it
 * is instead of the keys.
 *
 * **View and Download are the browser's, Delete is the device's.** The first
 * two are the same URL the thumbnail already uses, so they cost the daemon a
 * request and this component no round trip at all; `captureUrl` is
 * `yonder-core`'s, the same function `console/middleware.ts` matches on the
 * way in, so the two ends of that address cannot drift. Delete is a press
 * that changes the device, so it goes out of this node's output and comes
 * back as a fresh listing — this component never edits the list it was given.
 *
 * **Delete asks first, and the question is on the row.** Not a browser
 * `confirm()`, which is a modal an operator on a tablet in the field has to
 * find and dismiss, and not a bare key either: a capture is gone for good and
 * R-UI-10 puts an irreversible action's confirmation beside the thing it acts
 * on. The row's keys become *Delete this? · DELETE · KEEP*, and only the
 * second press emits. `confirming` is cleared by the next listing, so a
 * question left open does not survive the answer.
 *
 * **A recording gets no thumbnail, and says so.** There is no frame to show
 * without decoding the file, which is the one thing a browser must not be
 * asked to do over a field uplink to draw a list. The block carries the
 * kind — `MKV` — so the row still reads as a capture of a known sort rather
 * than as a picture that failed to load.
 *
 * The payload, one whole `msg.payload`, exactly as the daemon's own listing
 * route answers it:
 *
 * ```
 * { camera: "cam0",
 *   captures: [{ name, at, bytes, width, height, held }] }   // newest first
 * ```
 *
 * **Newest first is the daemon's order, kept.** `video/recorder.ts` sorts on
 * `at` descending across both media, and re-sorting here would be a second
 * copy of that rule — and one that could disagree with the count beside the
 * link, which is composed from the same listing.
 */

/** A second, in the units `at` is in. */
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago, in words (`just now`, `14 min ago`, `2 h ago`).
 *
 * Relative and not a wall clock, deliberately: an operator reading this panel
 * is asking *which of these is the one I just took*, and `14:22:05` answers
 * that only for somebody who knows what time it is now. The blueprint's own
 * rows read this way for the same reason.
 */
export function agoWords (at, now) {
    if (!Number.isFinite(at)) return ''
    const ms = now - at
    if (ms < 45 * SECOND) return 'just now'
    if (ms < HOUR) return `${Math.round(ms / MINUTE)} min ago`
    if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`
    return `${Math.round(ms / DAY)} d ago`
}

/**
 * A file size an operator reads, never a byte count.
 *
 * Decimal MB, matching every other size this console states (`system/
 * format.ts`'s own rule): a card sold as 64 GB holds 64 decimal GB, and an
 * operator comparing this figure with the one on the card has to be reading
 * the same units.
 */
export function sizeWords (bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return ''
    if (bytes < 1000) return `${bytes} B`
    if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} kB`
    return `${(bytes / 1000 / 1000).toFixed(1)} MB`
}

const STILL_EXTENSIONS = ['jpg', 'jpeg', 'png']

export default {
    name: 'YonderCaptures',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data () {
        return {
            /** The row whose delete has been asked for and not yet answered. */
            confirming: null,
            /** The row whose capture is open beneath it, or null. */
            opened: null,
            /**
             * Captures whose thumbnail did not load.
             *
             * A file the console cannot fetch draws a broken-image icon with
             * the browser's own alt text spilling out of a 56×32 box — which
             * says *this page is broken* about a row that is telling the
             * truth. The kind block is the same fallback a recording already
             * gets, and it reads as a capture rather than as a fault.
             */
            failed: {},
            now: Date.now(),
            tick: null
        }
    },
    computed: {
        /** The whole report, live in preference to configured — the same rule
         * `YonderDeck`, `YonderIndex` and `YonderAim` each state for their
         * own payload. `props.report` is a convenience for the gallery and a
         * test, never a promise that a real page shows anything before the
         * first message. */
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
        camera () {
            return (this.report && typeof this.report.camera === 'string') ? this.report.camera : ''
        },
        captures () {
            if (!this.listable) return []
            return this.report && Array.isArray(this.report.captures) ? this.report.captures : []
        },
        listable () { return this.report?.listing !== 'unavailable' },
        /** The heading's own qualifier. Every listing this panel draws is one
         * camera's, and the board is where the ones it can act on live. */
        heldHere () {
            return heldWords(this.report?.destination === 'camera' ? 'camera' : 'board')
        }
    },
    watch: {
        /** A fresh listing answers whatever was being asked. A confirmation
         * left standing across a re-read would be a question about a row that
         * may no longer be the row under it. */
        captures () {
            this.confirming = null
            // A fresh listing is a fresh answer about every row, including
            // whether its bytes are there — a thumbnail held down for ever by
            // one failed fetch would outlive the reason for it.
            this.failed = {}
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    mounted () {
        // `just now` has to stop being true on its own. The same once-a-second
        // reactive clock `YonderShutter` and `YonderPicture` each keep, for
        // the same reason: a relative time computed once and left is a lie
        // within the minute.
        this.tick = setInterval(() => { this.now = Date.now() }, 1000)
    },
    beforeUnmount () {
        clearInterval(this.tick)
    },
    methods: {
        /** Every message this node posts leaves through here — one seam, the
         * same reasoning `YonderDeck` and `YonderIndex` each give. */
        post (payload) {
            if (this.camera) this.$socket.emit('widget-action', this.id, { camera: this.camera, payload })
        },
        onCamera (c) {
            return c && c.held === 'camera'
        },
        heldWordsFor (c) {
            return heldWords(this.onCamera(c) ? 'camera' : 'board')
        },
        extensionOf (c) {
            const name = (c && typeof c.name === 'string') ? c.name : ''
            const dot = name.lastIndexOf('.')
            return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
        },
        isStill (c) {
            return STILL_EXTENSIONS.includes(this.extensionOf(c))
        },
        /** A thumbnail is drawn for a still this board holds whose bytes have
         *  not already failed to arrive. */
        showsThumb (c) {
            return this.isStill(c) && !this.onCamera(c)
                && this.failed[c && c.name] !== true
        },
        thumbFailed (c) {
            if (c && typeof c.name === 'string') this.failed[c.name] = true
        },
        kindOf (c) {
            const ext = this.extensionOf(c)
            return ext === '' ? 'FILE' : ext.toUpperCase()
        },
        /** The one address this panel knows, and it is `yonder-core`'s.
         * A capture with no camera to belong to has no address at all —
         * an empty `src` draws nothing rather than resolving to the page. */
        urlFor (c) {
            if (!this.camera || !c || typeof c.name !== 'string') return ''
            return captureUrl(this.camera, c.name)
        },
        whenOf (c) {
            return agoWords(c && c.at, this.now)
        },
        sizeOf (c) {
            const shape = (Number.isFinite(c && c.width) && Number.isFinite(c && c.height))
                ? `${c.width}×${c.height}`
                : ''
            const bytes = sizeWords(c && c.bytes)
            return [shape, bytes].filter(Boolean).join(' · ')
        },
        view (c) {
            this.opened = this.opened === c.name ? null : c.name
        },
        /**
         * The second press, and the only one that emits.
         *
         * Guarded on the same value the template branches on, for the reason
         * `YonderShutter` gives for guarding twice: a dispatched click reaches
         * a listener in a real browser whatever the markup says, and a
         * dispatched DELETE that skipped the question would be the one press
         * on this page nothing can undo.
         */
        remove (c) {
            if (!c || this.confirming !== c.name || this.onCamera(c)) return
            this.confirming = null
            if (this.opened === c.name) this.opened = null
            this.post({ remove: c.name })
        }
    }
}
</script>

<style scoped>
/* The blueprint's own figures (`gallery/DraftCaptures.vue`), carried over:
   the 56×32 thumbnail, the 11px gap, the type scale and every colour. What
   changed is the class prefix — `y-caps*`, this library's own BEM — and the
   framing: a panel in its own group rather than an absolutely positioned
   popover, because a Dashboard widget cannot render inside another widget's
   column. See this component's own doc comment. */
.y-caps {
    font-family: var(--yonder-font, system-ui, sans-serif);
    background: var(--yonder-pane, #090d12);
    color: var(--yonder-value, #ffffff);
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: 4px;
    padding: 14px 16px;
}
.y-caps__h {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 12px;
}
.y-caps__n { font-style: normal; letter-spacing: 0.1em; }
.y-caps__none {
    font-size: 12px;
    color: var(--yonder-label, #7f8a95);
    padding: 8px 0 14px;
    margin: 0;
}
.y-caps__list { list-style: none; margin: 0 0 12px; padding: 0; }
.y-caps__row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 11px;
    padding: 8px 0;
    border-top: 1px solid var(--yonder-divider, #2b333c);
}
.y-caps__row:first-child { border-top: 0; }
.y-caps__thumb {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 32px;
    border-radius: 2px;
    object-fit: cover;
    background: var(--yonder-track, #161b21);
}
/* A recording has no frame to show without decoding it, which is the one
   thing a browser must not be asked to do over a field uplink to draw a
   list. The kind, so the row reads as a capture rather than a broken image. */
.y-caps__thumb--none {
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.1em;
    color: var(--yonder-label, #7f8a95);
    border: 1px solid var(--yonder-divider, #2b333c);
}
.y-caps__meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.y-caps__meta b {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--yonder-value, #ffffff);
    font-variant-numeric: tabular-nums;
}
.y-caps__meta em { font-style: normal; font-size: 10.5px; color: var(--yonder-label, #7f8a95); }
/* Neutral, not caution: a camera holding its own photograph is not a fault. */
.y-caps__oncam { color: var(--yonder-neutral, #7d7869); }
.y-caps__keys { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.y-caps__ask {
    font-size: 10.5px;
    color: var(--yonder-irreversible, #f03fce);
    letter-spacing: 0.04em;
}
.y-caps__key {
    display: inline-block;
    font: inherit;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    text-decoration: none;
    padding: 6px 9px;
    border-radius: 2px;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--yonder-divider, #2b333c);
    color: var(--yonder-value, #ffffff);
}
.y-caps__key:hover {
    border-color: var(--yonder-select, #2ad4f0);
    color: var(--yonder-select, #2ad4f0);
}
.y-caps__key--warn {
    border-color: var(--yonder-irreversible, #f03fce);
    color: var(--yonder-irreversible, #f03fce);
}
.y-caps__open { flex-basis: 100%; }
.y-caps__open img,
.y-caps__open video { display: block; width: 100%; border-radius: 2px; }
.y-caps__fine {
    font-size: 10px;
    letter-spacing: 0.04em;
    line-height: 1.5;
    color: var(--yonder-label, #7f8a95);
}
</style>
