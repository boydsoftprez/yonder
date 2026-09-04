<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <button
        type="button"
        class="y-hold"
        :class="['tone-' + (props.tone || 'plain'), { held, unavailable: !available }]"
        :aria-pressed="held ? 'true' : 'false'"
        :disabled="!available"
        @pointerdown.prevent="down"
        @pointerup="up"
        @pointercancel="up"
        @pointerleave="up"
        @contextmenu.prevent
    >
        <span class="y-hold__label">{{ props.label }}</span>
        <span v-if="cost" class="y-hold__cost">{{ cost }}</span>
    </button>
</template>

<script>
/**
 * A soft key that acts while it is held (R-VID-11, R-VID-13).
 *
 * **Pointer events, not mouse and touch.** A touch fires a synthetic mouse
 * event after the touch event, so a component listening to both sends
 * everything twice — which here means asking for the full-rate stream twice
 * and releasing it once. Pointer events are one stream for both.
 *
 * **Four releases, not one.** `pointerup` is the ordinary case.
 * `pointercancel` is the browser taking the gesture away — a scroll on a
 * tablet, a notification. `pointerleave` is a finger or a cursor that slid off
 * the button while held. And `visibilitychange` is a page that went to the
 * background still holding it. Every one of them leaves the aircraft sending
 * a full-rate stream nobody is watching if it is missed, and on a cellular
 * uplink that is most of the link.
 *
 * `setPointerCapture` is deliberately *not* used. Capturing would keep
 * delivering events after the pointer left the button, which sounds like the
 * safer choice and is the opposite: it makes `pointerleave` never fire, so a
 * finger dragged off the key keeps the expensive stream running with nothing
 * on screen indicating it.
 *
 * `down`/`up` both guard on `held`, so two release events for the same press
 * — a `pointerleave` immediately followed by the `pointerup` a browser can
 * still deliver after it — send exactly one `up`, not two.
 *
 * `preventDefault` on pointerdown stops the browser starting a text
 * selection or a drag, either of which swallows the release.
 */
export default {
    name: 'YonderHoldKey',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data () {
        return { held: false }
    },
    computed: {
        /**
         * What the flow last said about this key, or nothing yet.
         *
         * Through `$store` rather than vuex's `mapState`, for the reason
         * YonderDataBar records.
         */
        sent () {
            const payload = this.$store?.state?.data?.messages?.[this.id]?.payload
            return payload && typeof payload === 'object' ? payload : {}
        },
        /**
         * What holding this costs, stated before it is pressed (R-VID-11).
         *
         * **From the message, in preference to the editor field.** The
         * configured string is one configuration's number frozen at deploy
         * time: raise the camera's bitrate and this key went on saying
         * *2.07 Mb/s while held* while the readout strip beside it said 8.27.
         * R-VID-11 is about stating the cost *before* it is asked for, so a
         * figure that cannot move is the requirement failing rather than a
         * cosmetic slip. The prop stays as the fall-back, so the key says
         * something before the first read arrives.
         */
        cost () {
            return typeof this.sent.cost === 'string' ? this.sent.cost : this.props.cost
        },
        /**
         * Whether there is anything to hold.
         *
         * **A key that cannot do its job must not offer to** — R-UI-15's own
         * exception clause is that the soft-key rail carries only what can be
         * done. The full-rate stream exists only where the camera has an RTSP
         * output; without one, holding this asks the media server for a path
         * that does not exist and the picture reports the 404 as "this camera
         * is not streaming", which is a true sentence about the wrong thing.
         *
         * Drawn and disabled rather than hidden, because a key that vanishes
         * leaves an operator wondering where it went, and `cost` is where the
         * answer goes.
         */
        available () {
            return this.sent.available !== false
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    mounted () {
        this.onHidden = () => { if (document.hidden) this.up() }
        document.addEventListener('visibilitychange', this.onHidden)
    },
    beforeUnmount () {
        document.removeEventListener('visibilitychange', this.onHidden)
        // A component torn down mid-hold must still release. Navigating away
        // from the page is not a reason to keep paying for the stream.
        this.up()
    },
    methods: {
        down () {
            if (!this.available) return
            if (this.held) return
            this.held = true
            this.send('down')
        },
        up () {
            if (!this.held) return
            this.held = false
            this.send('up')
        },
        send (edge) {
            // widget-action rather than widget-change: a press is an event,
            // not a value to restore on reload. A console that replayed the
            // last key pressed when a browser reconnected would be
            // originating an action nobody asked for.
            this.$socket.emit('widget-action', this.id, {
                payload: `${this.props.action}:${edge}`,
                topic: this.props.label
            })
        }
    }
}
</script>

<style scoped>
.y-hold {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    /* R-UI-10 and ADR-0009: sized to its words, never to its container. */
    max-width: 220px;
    padding: 8px 14px;
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: 3px;
    background: var(--yonder-track, #161b21);
    color: var(--yonder-value, #fff);
    font-family: var(--yonder-font, system-ui, sans-serif);
    cursor: pointer;
    /* A held key must not be interpreted as a scroll or a text selection. */
    touch-action: none;
    user-select: none;
}
.y-hold.unavailable {
    /* Visibly not a control: the words say why, and the cursor and the tone
       agree with them. */
    cursor: not-allowed;
    color: var(--yonder-label, #7f8a95);
    border-style: dashed;
}
.y-hold.held {
    border-color: var(--yonder-select, #2ad4f0);
    color: var(--yonder-select, #2ad4f0);
}
.y-hold__label {
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}
.y-hold__cost {
    /* Never uppercased: Mb/s rendered as MB/S says megabytes. */
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--yonder-label, #7f8a95);
    text-transform: none;
}
</style>
