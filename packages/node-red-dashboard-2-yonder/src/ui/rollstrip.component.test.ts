// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import YonderRollStrip from './YonderRollStrip.vue'
import { AIM_RESPONSE_CHANGED, SPEED_KEY } from './aim-response.js'

function strip (props: Record<string, unknown> = {}) {
    const wrapper = mount(YonderRollStrip, { props: { roll: 12.4, maxRate: 30, available: true, reason: '', ...props } })
    wrapper.find('.y-roll__track').element.getBoundingClientRect = () => ({ left: 0, width: 160 }) as DOMRect
    return wrapper
}

function pointer (type: string, x: number, pointerId = 1, shiftKey = false) {
    return new PointerEvent(type, { clientX: x, pointerId, shiftKey, bubbles: true, cancelable: true })
}

function fire (target: Element | Window | Document, type: string) {
    target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
}

function slews (wrapper: VueWrapper) {
    return ((wrapper.emitted('slew') ?? []).map(call => call[0])) as Array<{ gesture: string; pan: number; tilt: number; roll: number; seq: number }>
}

function stops (wrapper: VueWrapper) {
    return ((wrapper.emitted('stop') ?? []).map(call => call[0])) as Array<{ gesture: string }>
}

afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    localStorage.clear()
})

describe('Roll strip', () => {
    it('draws the measured roll even when the known control is unavailable', () => {
        const wrapper = strip({ roll: -4.5, available: false, reason: 'Roll rate has not been verified.' })
        expect(wrapper.find('.y-roll__head').text()).toContain('-4.5°')
        expect(wrapper.find('.y-roll__track').attributes('aria-disabled')).toBe('true')
        expect(wrapper.find('.y-roll__reason').text()).toBe('Roll rate has not been verified.')
        wrapper.find('.y-roll__track').element.dispatchEvent(pointer('pointerdown', 155))
        expect(wrapper.emitted()).not.toHaveProperty('start')
        expect(slews(wrapper)).toHaveLength(0)
    })

    it.each([Number.NaN, Infinity, -Infinity])('treats a non-finite reported roll (%s) as unknown', roll => {
        const wrapper = strip({ roll, available: false })
        expect(wrapper.find('.y-roll__head output').text()).toBe('—')
    })

    it('starts at centre without movement, then emits a bounded signed roll rate and an exactly-once stop', async () => {
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 80))
        expect(wrapper.emitted('start')).toHaveLength(1)
        expect(slews(wrapper)).toHaveLength(0)
        track.dispatchEvent(pointer('pointermove', 156))
        const first = slews(wrapper)[0]!
        expect(first).toMatchObject({ pan: 0, tilt: 0, seq: 1 })
        expect(first.gesture).toMatch(/^roll-/)
        expect(first.roll).toBeGreaterThan(0)
        expect(first.roll).toBeLessThanOrEqual(30)
        // Full rate begins after the dead zone at x=156, so the puck reaches
        // its reserved right endpoint at exactly the same throw.
        expect(wrapper.vm.puck).toBe(92)
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.y-roll__puck').attributes('style')).toContain('left: 92%')
        expect(wrapper.find('.y-roll__track .y-roll__labels').exists()).toBe(false)
        expect(wrapper.find('.y-roll__labels').exists()).toBe(true)
        fire(track, 'pointerleave')
        fire(track, 'pointerup')
        expect(stops(wrapper)).toEqual([{ gesture: first.gesture }])
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.y-roll__puck').attributes('style')).toContain('left: 50%')
    })

    it('quantizes tiny throws to rest and gives each repeated hold a fresh gesture with a monotonic sequence', () => {
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 92.1)) // just beyond the dead zone, below 0.1°/s on wire
        expect(slews(wrapper)).toHaveLength(0)
        track.dispatchEvent(pointer('pointermove', 156))
        const first = slews(wrapper)[0]!
        fire(track, 'pointerup')
        track.dispatchEvent(pointer('pointerdown', 4, 2))
        const second = slews(wrapper)[1]!
        expect(second.gesture).not.toBe(first.gesture)
        expect(second.seq).toBeGreaterThan(first.seq)
        wrapper.unmount()
    })

    it('uses the shared Aim response values, Shift fine control, and retires a hold when settings change', () => {
        localStorage.setItem(SPEED_KEY, '20')
        const wrapper = strip({ maxRate: 30 })
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 156, 1, true))
        const fine = slews(wrapper)[0]!.roll
        expect(fine).toBeGreaterThan(0)
        expect(fine).toBeLessThanOrEqual(5)
        localStorage.setItem(SPEED_KEY, '10')
        window.dispatchEvent(new CustomEvent(AIM_RESPONSE_CHANGED, { detail: { key: SPEED_KEY, value: 10 } }))
        expect(stops(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointerdown', 4, 2))
        const left = slews(wrapper).at(-1)!
        expect(left.roll).toBeLessThan(0)
        expect(Math.abs(left.roll)).toBeLessThanOrEqual(10)
        wrapper.unmount()
    })

    it('captures a pointer, and every cancellation path stops the active gesture without resuming it', async () => {
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element as HTMLElement & { setPointerCapture: (id: number) => void; hasPointerCapture: (id: number) => boolean; releasePointerCapture: (id: number) => void }
        let captured: number | null = null
        track.setPointerCapture = id => { captured = id }
        track.hasPointerCapture = id => captured === id
        track.releasePointerCapture = id => { if (captured === id) captured = null }
        track.dispatchEvent(pointer('pointerdown', 156, 7))
        expect(captured).toBe(7)
        fire(window, 'blur')
        expect(stops(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointermove', 156, 7))
        expect(slews(wrapper)).toHaveLength(1)

        track.dispatchEvent(pointer('pointerdown', 156, 8))
        await wrapper.setProps({ available: false })
        expect(stops(wrapper)).toHaveLength(2)
        await wrapper.setProps({ available: true })
        track.dispatchEvent(pointer('pointermove', 156, 8))
        expect(slews(wrapper)).toHaveLength(2)
        wrapper.unmount()
    })

    it.each([
        ['pointercancel', 'track'], ['lostpointercapture', 'track'], ['pointerleave', 'track'],
        ['blur', 'window'], ['offline', 'window'], ['pagehide', 'window'], ['hidden', 'document']
    ])('ends a held rate on %s', (kind, target) => {
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 156))
        if (kind === 'hidden') {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true })
            fire(document, 'visibilitychange')
        } else if (target === 'track') fire(track, kind)
        else fire(window, kind)
        expect(stops(wrapper)).toHaveLength(1)
        wrapper.unmount()
    })
})
