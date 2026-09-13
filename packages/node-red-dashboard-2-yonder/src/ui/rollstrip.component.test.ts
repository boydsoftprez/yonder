// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import YonderRollStrip from './YonderRollStrip.vue'
import { AIM_RESPONSE_CHANGED, EXPO_KEY, ROLL_SPEED_KEY, SPEED_KEY } from './aim-response.js'

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
    vi.restoreAllMocks()
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

    it('uses independent roll speed, Shift fine control, and retires a hold when roll settings change', () => {
        localStorage.setItem(SPEED_KEY, '90')
        localStorage.setItem(ROLL_SPEED_KEY, '20')
        const wrapper = strip({ maxRate: 30 })
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 156, 1, true))
        expect(slews(wrapper)[0]!.roll).toBe(5)
        localStorage.setItem(ROLL_SPEED_KEY, '10')
        window.dispatchEvent(new CustomEvent(AIM_RESPONSE_CHANGED, { detail: { key: ROLL_SPEED_KEY, value: 10 } }))
        expect(stops(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointermove', 4, 1))
        expect(slews(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointerdown', 4, 2))
        expect(slews(wrapper).at(-1)!.roll).toBe(-10)
        wrapper.unmount()
    })

    it('defaults to 30 independently of pan/tilt speed and retains fine movement near centre', () => {
        localStorage.setItem(SPEED_KEY, '20')
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 100))
        expect(slews(wrapper)[0]!.roll).toBeGreaterThan(1)
        expect(slews(wrapper)[0]!.roll).toBeLessThan(5)
        track.dispatchEvent(pointer('pointermove', 156))
        expect(slews(wrapper).at(-1)!.roll).toBe(30)
        localStorage.setItem(SPEED_KEY, '10')
        window.dispatchEvent(new CustomEvent(AIM_RESPONSE_CHANGED, { detail: { key: SPEED_KEY, value: 10 } }))
        track.dispatchEvent(pointer('pointermove', 4))
        expect(slews(wrapper).at(-1)!.roll).toBe(-30)
        expect(stops(wrapper)).toHaveLength(0)
        localStorage.setItem(EXPO_KEY, '100')
        window.dispatchEvent(new CustomEvent(AIM_RESPONSE_CHANGED, { detail: { key: EXPO_KEY, value: 100 } }))
        expect(stops(wrapper)).toHaveLength(1)
        wrapper.unmount()
    })

    it('persists the roll slider, stops its active hold and leaves pan/tilt speed alone', async () => {
        localStorage.setItem(SPEED_KEY, '60')
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 156))
        await wrapper.find('input[aria-label="Maximum roll speed"]').setValue('12')
        expect(stops(wrapper)).toHaveLength(1)
        expect(localStorage.getItem(ROLL_SPEED_KEY)).toBe('12')
        expect(localStorage.getItem(SPEED_KEY)).toBe('60')
        track.dispatchEvent(pointer('pointermove', 4))
        expect(slews(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointerdown', 4, 2))
        expect(slews(wrapper).at(-1)!.roll).toBe(-12)
        wrapper.unmount()
        const restored = strip()
        expect(restored.find('input').element.value).toBe('12')
        expect(restored.find('.y-roll__head').text()).toContain('12°/s max')
        restored.unmount()
    })

    it.each(['NaN', 'Infinity', '0', '-1', '121', ''])('ignores invalid saved roll speed %s', value => {
        localStorage.setItem(ROLL_SPEED_KEY, value)
        const wrapper = strip()
        wrapper.find('.y-roll__track').element.dispatchEvent(pointer('pointerdown', 156))
        expect(slews(wrapper)[0]!.roll).toBe(30)
        wrapper.unmount()
    })

    it.each([null, '20'])('retains the chosen speed if persistence fails with stored value %s', async previous => {
        if (previous !== null) localStorage.setItem(ROLL_SPEED_KEY, previous)
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
        const wrapper = strip()
        await wrapper.find('input[aria-label="Maximum roll speed"]').setValue('5')
        expect(wrapper.find('.y-roll__head').text()).toContain('5°/s max')
        wrapper.find('.y-roll__track').element.dispatchEvent(pointer('pointerdown', 156))
        expect(slews(wrapper)[0]!.roll).toBe(5)
        wrapper.unmount()
    })

    it('clamps to a reduced backend cap and retires any hold without replay', async () => {
        localStorage.setItem(ROLL_SPEED_KEY, '120')
        const wrapper = strip()
        const track = wrapper.find('.y-roll__track').element
        track.dispatchEvent(pointer('pointerdown', 156))
        expect(slews(wrapper)[0]!.roll).toBe(30)
        await wrapper.setProps({ maxRate: 5 })
        expect(stops(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointermove', 156))
        expect(slews(wrapper)).toHaveLength(1)
        track.dispatchEvent(pointer('pointerdown', 156, 2))
        expect(slews(wrapper).at(-1)!.roll).toBe(5)
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
