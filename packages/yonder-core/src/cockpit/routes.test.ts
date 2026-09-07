// SPDX-License-Identifier: GPL-3.0-or-later
import { it, expect, vi } from "vitest";
import { createRouter } from "../daemon/routes.js";
import { VehicleService } from "../mav/vehicle.js";
import { CockpitData } from "./data.js";
import { cockpitRoute } from './routes.js';
import type { AdminCredential } from "../console/credential.js";
import type { ApplyEngine } from "../apply/engine.js";
const clock = {
  now: () => 1788790000000,
  setTimer: () => 0,
  clearTimer: () => {},
};
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
