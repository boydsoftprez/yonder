// SPDX-License-Identifier: GPL-3.0-or-later
import type { TerrainPackService } from "../terrain/service.js";
import type { VehicleService } from "../mav/vehicle.js";
import type { OperatorRequest } from "../mav/types.js";
import type { CockpitData } from "./data.js";
import { createHash } from 'node:crypto';
import { packFlight } from './flight-wire.js';
import { packInstruments } from './instrumentation-wire.js';
import type { CockpitInstruments } from './host-instruments.js';
export interface CockpitServices {
  instruments?: Pick<CockpitInstruments, 'snapshot'>;
  vehicle?: VehicleService;
  data?: CockpitData;
  terrain?: TerrainPackService;
  cameraState?: () => Promise<{ cameras: unknown[]; camera: unknown }>;
}
/** Called behind the daemon's provisioning gate; console owns browser sessions. */
export async function cockpitRoute(
  services: CockpitServices,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  if (!path.startsWith("/cockpit/")) return null;
  if (path === '/cockpit/instruments' && method === 'GET') return services.instruments
    ? { status: 200, body: packInstruments(await services.instruments.snapshot()) }
    : { status: 503, body: { error: 'Instrumentation service unavailable' } };
  const trail=/^\/cockpit\/trail(?:\/([a-zA-Z0-9-]{1,64})\/(\d{1,12})(?:\/(\d{1,12})\/(\d{1,12}))?)?$/.exec(path);
  if(trail&&method==='GET')return services.vehicle
    ?{status:200,body:services.vehicle.trailPage(trail[1],Number(trail[2]??0),Number(trail[3]??0),Number(trail[4]??0))}
    :{status:503,body:{error:'Vehicle trail service unavailable'}};
  if(['/cockpit/flight','/cockpit/details','/cockpit/mission','/cockpit/traffic'].includes(path)&&method==='GET'){
    if(!services.vehicle)return {status:503,body:{error:'Vehicle telemetry service is unavailable'}};
    if(path==='/cockpit/mission'){
      const snapshot=services.vehicle.snapshot();
      return {status:200,body:{generation:snapshot.identity?.generation??null,mission:snapshot.mission}};
    }
    if(path==='/cockpit/traffic'){
      const t=services.vehicle.snapshot({details:false}).telemetry;
      const state=services.data?.snapshot({lat:t.latitude,lon:t.longitude,valid:t.ready&&t.fixType!==null&&t.fixType>=3});
      const traffic=state?.traffic;
      // One current observation per target. Trails are assembled on the ground.
      return {status:200,body:traffic?{...traffic,tracks:traffic.tracks.map(({history:_,...track})=>track)}:{status:'disabled',tracks:[],message:'Traffic provider unavailable'}};
    }
    const camera=await services.cameraState?.();
    const snapshot=services.vehicle.snapshot({details:path==='/cockpit/details'});
    const dataOptions=services.data?.options;
    const detailKey=createHash('sha256').update(JSON.stringify([snapshot.detailKey,camera,dataOptions],(key,value)=>{
      // An unstarted camera's stopped status is synthesized with since=now.
      // That observation time is not a state change: hashing it prevents the
      // browser's flight and detail reads ever agreeing, blocking commands.
      // Keep the original timestamp in the response and all real transitions
      // (including a new running instance's since) in the version token.
      if(key==='run'&&value?.state==='stopped'){
        const {since:_,...state}=value;return state;
      }
      return value;
    })).digest('hex').slice(0,24);
    if(path==='/cockpit/flight'){
      snapshot.telemetry.altitudeDatum=dataOptions?.aircraftDatum??'UNKNOWN';
      return {status:200,body:packFlight(snapshot,detailKey)};
    }
    return {status:200,body:{detailKey,identity:snapshot.identity,capabilities:snapshot.capabilities,
      operations:snapshot.operations,statustext:snapshot.statustext,...camera,dataOptions,
      terrainPack:services.terrain?{id:services.terrain.manifest.id,available:true}:null}};
  }
  if (path === "/cockpit/state" && method === "GET") {
    if (!services.vehicle)
      return {
        status: 503,
        body: { error: "Vehicle telemetry service is unavailable" },
      };
    const camera = await services.cameraState?.();
    const snapshot = services.vehicle.snapshot(),
      t = snapshot.telemetry;
    const extra = services.data?.snapshot({
      lat: t.latitude,
      lon: t.longitude,
      valid: t.ready && t.fixType !== null && t.fixType >= 3,
    });
    return {
      status: 200,
      body: {
        ...snapshot,
        ...extra,
        ...camera,
        telemetry: {
          ...snapshot.telemetry,
          altitudeDatum: services.data?.options.aircraftDatum ?? "UNKNOWN",
        },
        terrainPack: services.terrain
          ? { id: services.terrain.manifest.id, available: true }
          : null,
      },
    };
  }
  if (path === "/cockpit/command" && method === "POST") {
    if (!services.vehicle)
      return {
        status: 503,
        body: { error: "Vehicle control service is unavailable" },
      };
    const result = services.vehicle.submit(body as OperatorRequest);
    return result.accepted
      ? { status: 202, body: result }
      : { status: result.status, body: { error: result.message } };
  }
  if (path === "/cockpit/data-options" && method === "POST") {
    if (!services.data)
      return {
        status: 503,
        body: { error: "Geographic data service is unavailable" },
      };
    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as { sessionId?: unknown }).sessionId !== "string"
    )
      return { status: 400, body: { error: "Session provenance is required" } };
    return services.data.configure(body)
      ? { status: 200, body: { dataOptions: services.data.options } }
      : { status: 400, body: { error: "Invalid geographic data options" } };
  }
  if (path === "/cockpit/terrain/manifest" && method === "GET")
    return services.terrain
      ? { status: 200, body: services.terrain.manifest }
      : { status: 503, body: { error: "Prepared terrain pack unavailable" } };
  const terrainTile = /^\/cockpit\/terrain\/tile\/([a-zA-Z0-9_.-]{1,96})$/.exec(
    path,
  );
  if (terrainTile && method === "GET") {
    if (!services.terrain)
      return {
        status: 503,
        body: { error: "Prepared terrain pack unavailable" },
      };
    if (!services.terrain.manifest.tiles.some((t) => t.id === terrainTile[1]))
      return { status: 404, body: { error: "Unknown terrain tile" } };
    try {
      const bytes = await services.terrain.getTile(terrainTile[1]!);
      return {
        status: 200,
        body: {
          data: Buffer.from(bytes).toString("base64"),
          type: "application/octet-stream",
        },
      };
    } catch {
      return {
        status: 503,
        body: { error: "Terrain tile unavailable or failed integrity check" },
      };
    }
  }
  const tile =
    /^\/cockpit\/tiles\/(elevation|imagery|places|roads)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/.exec(
      path,
    );
  if (tile && method === "GET")
    return services.data
      ? services.data.tile(
          tile[1]!,
          Number(tile[2]),
          Number(tile[3]),
          Number(tile[4]),
        )
      : {
          status: 503,
          body: { error: "Geographic data service is unavailable" },
        };
  return { status: 404, body: { error: "Unknown cockpit route" } };
}
