<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-shutter" :class="{ 'is-recording': isRecording }">
        <button
            type="button"
            class="y-shutter__btn"
            :class="{ lit: isRecording, inhibited: Boolean(inhibited) }"
            :disabled="pending || Boolean(inhibited)"
            :aria-pressed="isRecording ? 'true' : 'false'"
            @click="press"
        >
            <span class="y-shutter__label">{{ label }}</span>
        </button>
        <span v-if="inhibited" class="y-shutter__why">{{ inhibited }}</span>
        <span v-if="destination" class="y-shutter__dest">{{ destination }}</span>
    </div>
</template>

<script>
/**
 * Record or Photo, following the mode — the same key either way (R-CAM-17,
 * §8.3).
 *
 * **This is the one control in this whole task that starts something on
 * the aircraft.** Every other part in Task 19 draws a reading or relays a
 * value; this one, pressed, sends `camera/0x02` or `camera/0x01` on the
 * accessory link, or the board's own equivalent (§8.3) — a real command
 * to a real device. CLAUDE.md rule 4 is that Yonder relays commands and
 * never originates one of its own, and a second, unrequested emission of
 * the same command from this component's own hand would be exactly that:
 * a command nobody pressed for.
 *
 * **`pending` is the guard, and it is enforced twice** — the same
 * "disabled attribute, and the guard inside the handler, and neither
 * alone is provably the one holding" shape `YonderSegmented` and
 * `YonderSetBar` both document and both test in isolation, for the
 * identical reason: a mutation removing either guard alone can leave the
 * *other* one still catching a dispatched click in a test, and crediting
 * the wrong one is worse than not knowing. `:disabled="pending"` stops an
 * ordinary press (and a keyboard repeat); `press()`'s own `if (pending)
 * return` stops a *dispatched* click, which reaches a disabled button's
 * listener in a real browser even though `.click()` does not.
 *
 * **`pending` is not the same fact as `isRecording`.** A press while
 * already recording is an ordinary "stop" request and must emit —
 * `pending` is specifically "a request is in flight, awaiting the
 * device's own acknowledgement" (mode changes and repeated presses must
 * not launch competing captures, §8.3), which a caller sets after seeing
 * this component's own emit and clears again once the device answers.
 * This component does not track that round trip itself; it only honours
 * the flag.
 *
 * **The event is the mode, not a value.** `record` and `photo` are two
 * different requests, and naming them as two different events (rather
 * than one `press` event carrying a payload) means a caller wires each to
 * its own MAVLink relay without a `switch` reading `event.payload` to
 * find out which one arrived — the same reasoning `YonderTextField`'s own
 * doc comment gives for a plainly named event over a generic one.
 *
 * **Lights and counts from `recording.since`, never from when this
 * component happened to mount.** The camera (or the board recorder) may
 * have started before this page did — reopened after a reload, or a
 * second page showing the same camera — and `since` is the device's own
 * answer to when, not this component's guess. A `setInterval` advances a
 * reactive clock the way `YonderPicture`'s own does, so the reading counts
 * up on its own rather than being a value computed once and left stale.
 *
 * **The destination line is a fact independent of whether anything is
 * recording** — §8.3's "the line under the key says where" is true before
 * a press as much as during one, so it stays visible in both states
 * rather than appearing only while lit.
 */
function pad (n) {
    return String(n).padStart(2, '0')
}

export default {
    name: 'YonderShutter',
    props: {
        mode: { type: String, default: 'video' },
        /** `{ since: <ms epoch> }` while recording; `null` otherwise. */
        recording: { type: Object, default: null },
        destination: { type: String, default: '' },
        /** A press is in flight, awaiting the device's own acknowledgement
         * (§8.3) — see this component's own doc comment on why this is
         * not the same fact as `recording`. */
        pending: { type: Boolean, default: false },
        /**
         * Why this key cannot be pressed right now — spec §4's *advertised*
         * and *gated* rows applied to the one control on the deck that
         * starts something (R-UI-21).
         *
         * **A different fact from `pending`, and drawn differently.**
         * `pending` is a press already in flight and is momentary; this is
         * the capability itself saying the key exists and will not act —
         * a camera that lists a recorder and has no card in it, or a board
         * whose own recorder is not built. Spec §4 is explicit that neither
         * state hides the control: an operator who cannot find Record at all
         * has to work out whether the page is broken or the camera cannot
         * do it, and the key with its reason under it answers that in
         * place. Null when it can be pressed — never an empty string,
         * because `v-if` on `''` and on `null` read the same here and only
         * one of them is a state anybody meant.
         */
        inhibited: { type: String, default: null }
    },
    emits: ['record', 'photo'],
    data: () => ({ now: Date.now(), tick: null }),
    computed: {
        /**
         * **The whole state of the key, in the key** (blueprint L-44):
         * `○ RECORD`, `PHOTO`, `● RECORDING 00:13:47`.
         *
         * The ring is a glyph in this string and not a shape drawn around the
         * control. It was a 64px circle until the operator said it looked
         * large, and the blueprint has no circle on this page at all — the
         * shutter is the width and height of the `Video │ Photo` pair directly
         * above it, and the hollow and filled rings are the two characters
         * that say which way it is.
         */
        label () {
            if (this.isRecording) return `\u25cf RECORDING ${this.elapsed}`
            return this.mode === 'photo' ? 'PHOTO' : '\u25cb RECORD'
        },
        isRecording () {
            return this.mode === 'video' && Boolean(this.recording) && Number.isFinite(this.recording.since)
        },
        elapsed () {
            if (!this.isRecording) return ''
            const s = Math.max(0, Math.floor((this.now - this.recording.since) / 1000))
            const hh = Math.floor(s / 3600)
            const mm = Math.floor((s % 3600) / 60)
            const ss = s % 60
            return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
        }
    },
    mounted () {
        this.tick = setInterval(() => { this.now = Date.now() }, 1000)
    },
    beforeUnmount () {
        clearInterval(this.tick)
    },
    methods: {
        press () {
            // Guard one of two — see this component's own doc comment on
            // why there are two rather than one. `inhibited` is guarded in
            // both places for the identical reason `pending` is: a
            // dispatched click reaches a disabled button's listener in a
            // real browser even though `.click()` does not, so the attribute
            // alone is not provably the one holding.
            if (this.pending || this.inhibited) return
            this.$emit(this.mode === 'photo' ? 'photo' : 'record')
        }
    }
}
</script>

<style scoped>
.y-shutter {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-family: var(--yonder-font, system-ui, sans-serif);
}
.y-shutter__btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    /* The width of a key, not of its column. Blueprint L-44 draws the shutter
       the size of one `Video | Photo` button, and the gate refuses an action
       that spans its whole surface — `100%` did, on every camera page. Sized
       to its label like `YonderSegmented` is, with a floor so `PHOTO` and
       `○ RECORD` come out the same width and the key does not jump when the
       mode changes. */
    width: max-content;
    min-width: 128px;
    min-height: 40px;
    padding: 0 18px;
    border-radius: 3px;
    border: 1px solid var(--yonder-divider, #2b333c);
    background: var(--yonder-track, #161b21);
    cursor: pointer;
}
.y-shutter__btn:disabled { cursor: not-allowed; }
/* Lit while recording: the red ring is what carries at a glance, the same
   "lit, not merely coloured" rule YonderAnnunciator's own lamp states. */
.y-shutter__btn.lit { border-color: var(--yonder-bad, #ff4034); }
.y-shutter__label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--yonder-value, #ffffff);
}
.y-shutter__btn.lit .y-shutter__label { color: var(--yonder-bad, #ff4034); }
.y-shutter__dest {
    font-size: 10.5px;
    color: var(--yonder-label, #7f8a95);
    text-align: center;
}
/* The caution tone (R-UI-21): a key that will not act because the capability
   is advertised and unanswered is a fault the operator should read, and the
   ring is dimmed rather than the key hidden — spec §4. A *gated* key gets the
   same disabled key with a neutral reason, because the caller passes the
   sentence and this component chooses no tone from the words in it. */
.y-shutter__btn.inhibited { opacity: 0.5; }
.y-shutter__why {
    font-size: 10.5px;
    color: var(--yonder-waiting, #ffcf28);
    text-align: center;
    max-width: 15rem;
}
</style>
