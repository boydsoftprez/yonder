<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <section class="y-roll" :class="{ 'is-disabled': !available }" aria-label="Roll control">
        <header class="y-roll__head">
            <span>Roll<span v-if="available"> · {{ selectedSpeed }}°/s max</span></span>
            <output>{{ shownRoll }}</output>
        </header>
        <div
            ref="strip"
            class="y-roll__track"
            :class="{ 'is-pushing': pushing, 'is-disabled': !available }"
            :aria-disabled="String(!available)"
            @pointerdown="down"
            @pointermove="move"
            @pointerup="onEnd"
            @pointercancel="onEnd"
            @pointerleave="onLeave"
            @lostpointercapture="onEnd"
        >
            <span class="y-roll__centre" aria-hidden="true" />
            <span class="y-roll__puck" :style="{ left: puck + '%' }" aria-hidden="true" />
        </div>
        <div class="y-roll__labels"><span>↶ Roll left</span><span>Roll right ↷</span></div>
        <label class="y-roll__speed">
            <span>Roll max speed <output>{{ selectedSpeed }}°/s</output></span>
            <input type="range" aria-label="Maximum roll speed" min="1" :max="rateLimit" step="1"
                :value="selectedSpeed" :disabled="!available || rateLimit < 1"
                :aria-valuetext="`${selectedSpeed} degrees per second`" @input="changeSpeed" />
        </label>
        <p v-if="reason" class="y-roll__reason">{{ reason }}</p>
    </section>
</template>

<script>
import { AIM_RESPONSE_CHANGED, EXPO_KEY, ROLL_SPEED_KEY, hasWireMotion, rateLimit, responseMagnitude, savedNumber, saveResponse } from './aim-response.ts'

const DEAD_PX = 12
const RANGE_PX = 64
const PUCK_TRAVEL_PERCENT = 42
const DEFAULT_EXPO = 50
const DEFAULT_SPEED = 30
let gestureCounter = 0

function newGestureId () {
    gestureCounter += 1
    return 'roll-' + gestureCounter
}

/**
 * A one-axis, spring-return rate control for a gimbal roll joint (R-CAM-11).
 * It owns a separate roll speed preference and shares the Aim pad's expo.
 * A press begins a gesture even inside the dead
 * zone, so its parent can retire a simultaneous pan/tilt hold; movement begins
 * only after the pointer leaves centre. Every release path retires one gesture.
 */
export default {
    name: 'YonderRollStrip',
    props: {
        roll: { type: Number, default: null },
        maxRate: { type: Number, default: 0 },
        available: { type: Boolean, default: false },
        reason: { type: String, default: '' }
    },
    emits: ['start', 'slew', 'stop'],
    data: () => ({
        gesture: null,
        seq: 0,
        pointerId: null,
        puck: 50,
        speed: savedNumber(ROLL_SPEED_KEY, DEFAULT_SPEED, 1, 120),
        expo: savedNumber(EXPO_KEY, DEFAULT_EXPO, 0, 100)
    }),
    computed: {
        rateLimit () { return rateLimit(this.maxRate) },
        selectedSpeed () { return Math.min(this.speed, this.rateLimit) },
        shownRoll () { return Number.isFinite(this.roll) ? `${this.roll.toFixed(1)}°` : '—' },
        pushing () { return this.gesture !== null }
    },
    watch: {
        available (now) { if (!now) this.onEnd() },
        rateLimit () { this.onEnd() }
    },
    mounted () {
        this.onBlur = () => this.onEnd()
        this.onOffline = () => this.onEnd()
        this.onVisibility = () => { if (document.hidden) this.onEnd() }
        this.onPageHide = () => this.onEnd()
        this.onResponseChanged = event => {
            const { key, value } = event?.detail ?? {}
            if (![ROLL_SPEED_KEY, EXPO_KEY].includes(key) || !Number.isFinite(value)
                || value < (key === EXPO_KEY ? 0 : 1) || value > (key === EXPO_KEY ? 100 : 120)) return
            this.onEnd()
            // Keep the current-session choice even when browser storage rejects it.
            if (key === ROLL_SPEED_KEY) this.speed = value
            else this.expo = value
        }
        window.addEventListener('blur', this.onBlur)
        window.addEventListener('offline', this.onOffline)
        window.addEventListener(AIM_RESPONSE_CHANGED, this.onResponseChanged)
        document.addEventListener('visibilitychange', this.onVisibility)
        window.addEventListener('pagehide', this.onPageHide)
    },
    beforeUnmount () {
        window.removeEventListener('blur', this.onBlur)
        window.removeEventListener('offline', this.onOffline)
        window.removeEventListener(AIM_RESPONSE_CHANGED, this.onResponseChanged)
        document.removeEventListener('visibilitychange', this.onVisibility)
        window.removeEventListener('pagehide', this.onPageHide)
        this.onEnd()
    },
    methods: {
        changeSpeed (event) {
            const value = Number(event.target.value)
            if (!this.available || !Number.isFinite(value) || value < 1 || value > this.rateLimit) return
            this.onEnd()
            this.speed = value
            saveResponse(ROLL_SPEED_KEY, value)
        },
        at (event) {
            const rect = this.$refs.strip?.getBoundingClientRect()
            if (!rect || ![rect.left, rect.width, event.clientX].every(Number.isFinite) || rect.width <= 0) return false
            const dx = event.clientX - (rect.left + rect.width / 2)
            const distance = Math.abs(dx)
            if (distance <= DEAD_PX) return null
            const amount = Math.min(1, (distance - DEAD_PX) / RANGE_PX)
            const rate = responseMagnitude(amount, this.expo, this.selectedSpeed) * (event.shiftKey ? 0.25 : 1)
            const roll = Math.sign(dx) * rate
            if (!hasWireMotion(roll, 0)) return null
            return { roll, puck: 50 + Math.sign(dx) * amount * PUCK_TRAVEL_PERCENT }
        },
        down (event) {
            if (!this.available || this.pointerId !== null) return
            if (event.button !== undefined && event.button !== 0) return
            this.$emit('start')
            this.pointerId = event.pointerId
            try { this.$refs.strip?.setPointerCapture?.(event.pointerId) } catch { /* Leaving an uncaptured strip stops. */ }
            this.update(event)
        },
        move (event) {
            if (this.pointerId === null) return
            if (event.pointerId !== undefined && event.pointerId !== this.pointerId) return
            this.update(event)
        },
        update (event) {
            if (!this.available) { this.endGesture(); return }
            const next = this.at(event)
            if (next === false) { this.onEnd(); return }
            if (!next) { this.endGesture(); return }
            if (this.gesture === null) this.gesture = newGestureId()
            this.puck = next.puck
            this.seq += 1
            this.$emit('slew', { gesture: this.gesture, pan: 0, tilt: 0, roll: next.roll, seq: this.seq })
        },
        endGesture () {
            this.puck = 50
            if (this.gesture === null) return
            const gesture = this.gesture
            this.gesture = null
            this.$emit('stop', { gesture })
        },
        onLeave () {
            try { if (this.pointerId !== null && this.$refs.strip?.hasPointerCapture?.(this.pointerId)) return } catch { /* No capture: stop. */ }
            this.onEnd()
        },
        onEnd () {
            const pointerId = this.pointerId
            this.pointerId = null
            this.endGesture()
            try { if (pointerId !== null && this.$refs.strip?.hasPointerCapture?.(pointerId)) this.$refs.strip.releasePointerCapture?.(pointerId) } catch { /* Already released. */ }
        }
    }
}
</script>

<style scoped>
.y-roll { margin: 8px 0 10px; font-family: var(--yonder-font, system-ui, sans-serif); }
.y-roll__head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px; color:var(--yonder-label, #7f8a95); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
.y-roll__head output { color:var(--yonder-value, #fff); font-size:13px; font-variant-numeric:tabular-nums; letter-spacing:0; }
.y-roll__track { position:relative; height:42px; border:1px solid var(--yonder-divider, #2b333c); border-radius:3px; background:var(--yonder-track, #161b21); cursor:ew-resize; touch-action:none; user-select:none; }
.y-roll__track::before { content:''; position:absolute; left:10px; right:10px; top:50%; border-top:1px solid var(--yonder-divider, #2b333c); }
.y-roll__centre { position:absolute; left:50%; top:9px; bottom:9px; border-left:1px solid var(--yonder-label, #7f8a95); }
.y-roll__puck { position:absolute; top:12px; width:16px; height:16px; transform:translateX(-50%); border:2px solid var(--yonder-select, #2ad4f0); border-radius:50%; background:var(--yonder-pane, #0c1218); box-sizing:border-box; pointer-events:none; }
.y-roll__labels { display:flex; justify-content:space-between; margin-top:4px; color:var(--yonder-label, #7f8a95); font-size:9px; letter-spacing:.06em; text-transform:uppercase; }
.y-roll__speed { display:block; margin-top:9px; color:var(--yonder-label, #7f8a95); font-size:11px; }
.y-roll__speed > span { display:flex; justify-content:space-between; }
.y-roll__speed output { color:var(--yonder-value, #fff); font-variant-numeric:tabular-nums; }
.y-roll__speed input { display:block; width:100%; margin:4px 0 0; accent-color:var(--yonder-select, #2ad4f0); }
.y-roll__track.is-pushing { cursor:grabbing; border-color:var(--yonder-select, #2ad4f0); }
.y-roll__track.is-disabled { cursor:not-allowed; border-style:dashed; }
.y-roll__reason { margin:5px 0 0; color:var(--yonder-label, #7f8a95); font-size:11px; line-height:1.35; }
</style>
