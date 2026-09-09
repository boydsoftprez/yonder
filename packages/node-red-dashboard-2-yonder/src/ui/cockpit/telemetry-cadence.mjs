// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-02/12: browser reads, distinct attitude observations and request identity.
export const telemetryRates = Object.freeze([1, 2, 4, 8]);
export const defaultTelemetryRate = 8;
export const telemetryPollDelay = (hz, elapsedMs) => Math.max(0, 1000 / hz - Math.max(0, elapsedMs));

// randomUUID is secure-context-only in browsers. getRandomValues remains
// available on the authenticated HTTP console; retain 122 random UUID bits.
export function cockpitRequestId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues !== 'function') throw new Error('Secure request IDs unavailable in this browser');
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export class TelemetryCadence {
  constructor() { this.reset(); }
  reset() { this.flight=[];this.attitude=[];this.lastSample=null;this.lastAge=null; }
  observe(telemetry, at) {
    if (this.flight.length && at <= this.flight.at(-1)) this.reset();
    this.flight.push(at);
    const field=telemetry.fields?.rollDeg;
    if (field?.valid && Number.isFinite(field.receivedAt) && field.receivedAt !== this.lastSample) {
      this.attitude.push(at);this.lastSample=field.receivedAt;
    }
    this.lastAge=field?.valid && Number.isFinite(field.ageMs) ? {at,age:field.ageMs} : null;
    for (const list of [this.flight,this.attitude]) while(list.length>128 || list[0]<at-10000) list.shift();
  }
  stats(now) {
    const rate=list=>{
      const recent=list.filter(t=>t>=now-10000);
      if (!recent.length || now-recent.at(-1)>2000) return 0;
      return recent.length>1 ? (recent.length-1)*1000/(recent.at(-1)-recent[0]) : null;
    };
    return {flightHz:rate(this.flight),attitudeHz:rate(this.attitude),attitudeAgeMs:this.lastAge?this.lastAge.age+Math.max(0,now-this.lastAge.at):null};
  }
}
