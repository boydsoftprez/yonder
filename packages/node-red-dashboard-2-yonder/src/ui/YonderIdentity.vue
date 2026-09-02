<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-id">
        <span class="y-id__k">{{ props.label }}</span>
        <span class="y-id__v" :class="{ absent: !has }">{{ shown }}</span>
        <button
            v-if="has"
            type="button"
            class="y-id__copy"
            :class="{ done: copied }"
            :aria-label="'Copy ' + props.label"
            @click="copy"
        >
            {{ copied ? 'COPIED' : 'COPY' }}
        </button>
    </div>
</template>

<script>
/**
 * An identifier, with a means of copying it (R-VPN-06, ADR-0009).
 *
 * R-VPN-06 requires the identifier a person must approve to be shown "with a
 * means of copying it", and a stock `ui-button` cannot be that: Dashboard
 * 1.31.0 has no clipboard path, so what shipped was a control whose own
 * tooltip told the operator to select the text and copy it by hand. A dead
 * control is worse than an absent one — it says it will act, does not, and
 * costs the operator the ten seconds of finding that out while they are
 * standing at an aircraft. CLAUDE.md rule 2 forbids the `function` node and
 * the `ui-template` that would have wired one up; it does not forbid this,
 * which is where behaviour is supposed to live.
 *
 * **`navigator.clipboard` is usually not there.** It is gated on a secure
 * context, and the console is reached at `http://yonder.local:3000` over an
 * access point or a mesh — never `https`, because there is no certificate a
 * device with no name on the internet could present. So the modern API is the
 * path that mostly will not run, and the `execCommand` fallback is the one
 * that mostly does. Both are here, in that order, and if neither works the
 * button says so rather than reporting a copy that never happened.
 */
export default {
    name: 'YonderIdentity',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data () {
        return { copied: false, timer: null }
    },
    computed: {
        payload () {
            const value = this.$store?.state?.data?.messages?.[this.id]?.payload
            return value && typeof value === 'object' ? value : {}
        },
        /**
         * The value, or nothing. An identifier that is not known yet is an em
         * dash and no copy control: the same distinction the data bar makes,
         * and the reason it matters more here is that a button offering to
         * copy an em dash is a button that lies.
         */
        value () {
            const raw = this.payload[this.props.key]
            return raw === undefined || raw === null || raw === '' ? '' : String(raw)
        },
        has () {
            return this.value !== ''
        },
        shown () {
            return this.has ? this.value : '—'
        }
    },
    beforeUnmount () {
        if (this.timer) clearTimeout(this.timer)
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        async copy () {
            if (!this.has) return
            if (await this.write(this.value)) {
                this.copied = true
                if (this.timer) clearTimeout(this.timer)
                this.timer = setTimeout(() => { this.copied = false }, 2000)
            }
        },
        /**
         * Nothing here reaches the device. Copying is a thing a browser does
         * with its own clipboard, so no `widget-action` is emitted and this
         * widget registers none — an instrument that could emit is an
         * instrument that could originate a command.
         */
        async write (text) {
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(text)
                    return true
                }
            } catch (e) {
                // Denied, or no permission. Fall through to the older path,
                // which does not ask for one.
            }
            try {
                const field = document.createElement('textarea')
                field.value = text
                // Off-screen rather than hidden: a field that is not rendered
                // cannot be selected, and a selection is what execCommand
                // copies.
                field.setAttribute('readonly', '')
                field.style.position = 'fixed'
                field.style.top = '-1000px'
                document.body.appendChild(field)
                field.select()
                const done = document.execCommand('copy')
                document.body.removeChild(field)
                return done
            } catch (e) {
                return false
            }
        }
    }
}
</script>

<style scoped>
.y-id {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    font-family: var(--yonder-font);
    border-top: 1px solid var(--yonder-divider, #2b333c);
}

.y-id__k {
    font-family: var(--yonder-font-mono);
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    flex: none;
}

/* An identifier is compared character by character, so it is cyan and
   addressable rather than white and read. */
.y-id__v {
    flex: 1;
    min-width: 0;
    font-family: var(--yonder-font-mono);
    font-size: 0.875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-select, #2ad4f0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Selectable by hand as well, for a browser where neither path works. */
    user-select: all;
}
.y-id__v.absent {
    color: var(--yonder-label, #7f8a95);
    font-weight: 400;
    letter-spacing: normal;
    user-select: auto;
}

/* Secondary by construction: an outline, never a fill. The one primary action
   on this surface is JOIN, and copying is not it (R-UI-10). */
.y-id__copy {
    flex: none;
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--yonder-divider, #2b333c);
    color: var(--yonder-label, #7f8a95);
    font-family: var(--yonder-font-mono);
    font-size: 0.5rem;
    font-weight: 800;
    letter-spacing: 0.16em;
    cursor: pointer;
}
.y-id__copy:hover { color: var(--yonder-value, #fff); border-color: var(--yonder-label, #7f8a95); }
.y-id__copy.done { color: var(--yonder-good, #35d06a); border-color: var(--yonder-good, #35d06a); }
</style>
