// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi,afterEach} from 'vitest';
import {webcrypto} from 'node:crypto';
import {TelemetryCadence,cockpitRequestId} from './telemetry-cadence.mjs';
import YonderCockpit from '../YonderCockpit.vue';
afterEach(()=>vi.useRealTimers());
it('distinguishes browser reads from repeated attitude samples and expires stopped observations',()=>{
 const c=new TelemetryCadence();
 for(let i=0;i<=16;i++)c.observe({fields:{rollDeg:{valid:true,receivedAt:Math.floor(i/4)*500,ageMs:(i%4)*125}}},i*125);
 expect(c.stats(2000)).toMatchObject({flightHz:8,attitudeHz:2,attitudeAgeMs:0});
 expect(c.stats(4100)).toMatchObject({flightHz:0,attitudeHz:0,attitudeAgeMs:2100});
 c.reset();expect(c.stats(4100).flightHz).toBe(0);
});
it('generates distinct valid request IDs on an HTTP browser without randomUUID',()=>{
 const cryptoSource={getRandomValues:(value:Uint8Array)=>webcrypto.getRandomValues(value)};
 const ids=Array.from({length:100},()=>cockpitRequestId(cryptoSource));
 expect(new Set(ids).size).toBe(100);
 for(const id of ids)expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 expect(()=>cockpitRequestId({})).toThrow(/Secure request IDs unavailable/);
});
it('accounts for the completed request time without overlapping flight reads',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 let finish;const state=new Promise(resolve=>{finish=resolve});
 const context={disposed:false,telemetryRate:8,source:{state:vi.fn(()=>state)},ingest:vi.fn(),poll:vi.fn()};
 const pending=YonderCockpit.methods.poll.call(context);
 await vi.advanceTimersByTimeAsync(80);expect(context.poll).not.toHaveBeenCalled();
 finish({});await pending;
 await vi.advanceTimersByTimeAsync(44);expect(context.poll).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(context.poll).toHaveBeenCalledOnce();
});
