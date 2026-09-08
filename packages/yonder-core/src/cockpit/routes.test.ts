// SPDX-License-Identifier: GPL-3.0-or-later
import { it, expect, vi } from "vitest";
import { createRouter } from "../daemon/routes.js";
import { VehicleService } from "../mav/vehicle.js";
import { CockpitData } from "./data.js";
import { heartbeatV2, validSysStatusBytes } from '../mav/testing.js';
import { cockpitRoute } from './routes.js';
import { unpackInstruments } from '../../../node-red-dashboard-2-yonder/src/ui/cockpit/instrumentation-client.mjs';
import type { AdminCredential } from "../console/credential.js";
import type { ApplyEngine } from "../apply/engine.js";
const clock = {
  now: () => 1788790000000,
  setTimer: () => 0,
  clearTimer: () => {},
};
it('gates instrumentation before reading host services, then serves host data without a vehicle', async () => {
  let reads = 0;
  const credential = { isSet: () => false } as AdminCredential;
  const router = createRouter({ engine: {} as ApplyEngine, credential, configPath: '/unused',
    hostInstruments: { now: clock.now, readFile: path => { reads++; return path === '/proc/uptime' ? '1234 1000' : null; } } });
  expect((await router('GET', '/cockpit/instruments', undefined)).status).toBe(403);
  expect(reads).toBe(0);
  credential.isSet = () => true;
  const response = await router('GET', '/cockpit/instruments', undefined);
  expect(response.status).toBe(200);
  expect(unpackInstruments(response.body)).toMatchObject({ generation: null, connected: false, fields: { 'host.uptimeSeconds': { value: 1234 } } });
  expect(reads).toBe(4);
  expect((await router('POST', '/cockpit/instruments', undefined)).status).toBe(404);
  expect(reads).toBe(4);
});
it('reads compact instruments independently from camera probes, public data and aircraft commands', async () => {
  const send = vi.fn(async () => {}), vehicle = new VehicleService({ clock, send });
  vehicle.receive(heartbeatV2(1, 1, 3));
  vehicle.receive(validSysStatusBytes());
  const probes = vi.fn(async () => { throw Error('must not probe'); });
  const router = createRouter({ engine: {} as ApplyEngine, credential: { isSet: () => true } as AdminCredential, configPath: '/unused',
    cockpit: { vehicle, cameraState: probes }, hostInstruments: { now: clock.now } });
  const response = await router('GET', '/cockpit/instruments', undefined);
  expect(response.status).toBe(200);
  const decoded = unpackInstruments(response.body);
  expect(decoded.fields).toHaveProperty('host.cpuPercent');
  expect(decoded).toMatchObject({ connected: true, fields: { 'battery.system.voltageV': { value: 12.6 }, 'fc.loadPercent': { value: 30 } } });
  expect(decoded.generation).toBeTruthy();
  expect(probes).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  vehicle.close();
});
it('serves compact flight and separate details without triggering public traffic fetches',async()=>{
 const vehicle=new VehicleService({clock,send:async()=>{}}),data=new CockpitData();
 const cameraState=async()=>({cameras:[],camera:null});
 const services={vehicle,data,cameraState};
 const poll=vi.spyOn(data,'snapshot');
 const one=await cockpitRoute(services,'GET','/cockpit/flight',undefined);
 expect(one?.status).toBe(200);
 expect(one?.body).toMatchObject({v:1,c:false});
 expect(JSON.stringify(one?.body).length).toBeLessThan(2500);
 expect(poll).not.toHaveBeenCalled();
 const details=await cockpitRoute(services,'GET','/cockpit/details',undefined);
 expect(details?.body).not.toHaveProperty('mission');
 expect(details?.body).not.toHaveProperty('telemetry');
 expect(details?.body).not.toHaveProperty('traffic');
 expect((details?.body as {detailKey:string}).detailKey).toBe((one?.body as {d:string}).d);
 expect(poll).not.toHaveBeenCalled();vehicle.close();data.close();
});
it('serves recorded trail pages without public-data calls or aircraft commands',async()=>{
 const send=vi.fn(async()=>{}),vehicle=new VehicleService({clock,send}),data=new CockpitData();
 const poll=vi.spyOn(data,'snapshot');
 const page=await cockpitRoute({vehicle,data},'GET','/cockpit/trail',undefined);
 expect(page).toMatchObject({status:200,body:{points:[],more:false}});
 const wire=await cockpitRoute({vehicle,data},'GET','/cockpit/flight',undefined);
 expect((wire?.body as object)).toHaveProperty('r.tail',null);
 expect((wire?.body as object)).not.toHaveProperty('r.points');
 expect(send).not.toHaveBeenCalled();expect(poll).not.toHaveBeenCalled();vehicle.close();data.close();
});
it('changes the detail token for source selection while attitude receipt is independent',async()=>{
 const vehicle=new VehicleService({clock,send:async()=>{}}),data=new CockpitData();
 const services={vehicle,data};
 const a=await cockpitRoute(services,'GET','/cockpit/flight',undefined);
 data.configure({sourceMode:'offline'});
 const b=await cockpitRoute(services,'GET','/cockpit/flight',undefined);
 expect((a?.body as {d:string}).d).not.toBe((b?.body as {d:string}).d);
 vehicle.close();data.close();
});
it("keeps cockpit routes behind provisioning and never commands from a state read", async () => {
  const send = vi.fn(async () => {}),
    vehicle = new VehicleService({ clock, send }),
    data = new CockpitData();
  const credential = { isSet: () => false } as AdminCredential;
  const router = createRouter({
    engine: {} as ApplyEngine,
    credential,
    configPath: "/unused",
    cockpit: { vehicle, data },
  });
  expect((await router("GET", "/cockpit/state", undefined)).status).toBe(403);
  credential.isSet = () => true;
  const state = await router("GET", "/cockpit/state", undefined);
  expect(state.status).toBe(200);
  expect((state.body as { connected: boolean }).connected).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect((await router("POST", "/cockpit/command", null)).status).toBe(400);
  expect(
    (await router("POST", "/cockpit/data-options", { traffic: true })).status,
  ).toBe(400);
  expect(
    (
      await router("POST", "/cockpit/data-options", {
        traffic: true,
        sessionId: "authenticated",
      })
    ).status,
  ).toBe(200);
  expect(
    (await router("GET", "/cockpit/tiles/imagery/12/10/10", undefined)).status,
  ).toBe(403);
  vehicle.close();
  data.close();
});

it('continues flight reads while a camera probe has not answered',async()=>{
 const vehicle=new VehicleService({clock,send:async()=>{}});
 let probes=0;
 const router=createRouter({engine:{} as ApplyEngine,credential:{isSet:()=>true} as AdminCredential,configPath:'/unused',cockpit:{vehicle},cameras:{detect:()=>{probes++;return new Promise(()=>{});},probe:async()=>{throw new Error('unused');}}});
 expect((await router('GET','/cockpit/state',undefined)).status).toBe(200);
 expect((await router('GET','/cockpit/state',undefined)).status).toBe(200);
 expect(probes).toBe(1);vehicle.close();
});
