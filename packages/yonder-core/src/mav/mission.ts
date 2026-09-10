// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { common } from "node-mavlink";
import type { MissionItem } from "./types.js";

export const MAX_MISSION_ITEMS = 2000;
const GLOBAL = new Set([0, 3, 5, 6, 10, 11]);
const LOCAL = new Set([1, 4, 7, 8, 9]);
const POSITION = new Set([16, 17, 18, 19, 21, 22, 31, 82, 84, 85, 179]);
// ArduPilot mission command x/y conversion, retained from the researched protocol adapter.
const RAW_XY = new Set([20, 93, 42702, 217, 3000, 2000, 2001, 531, 532, 534, 2500, 2501, 218, 83, 112, 114, 115, 211, 197, 210, 206, 177, 600, 601, 178, 181, 182, 183, 184, 202, 203, 205, 1000, 208, 207, 216, 212, 223, 215]);
export function missionIntegerScale(command: number, frame: number): number {
  return RAW_XY.has(command) ? 1 : GLOBAL.has(frame) ? 1e7 : LOCAL.has(frame) ? 1e4 : 1;
}
export function missionFrame(frame: number): number { return ({ 5: 0, 6: 3, 11: 10 } as Record<number, number>)[frame] ?? frame; }
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const integer = (v: unknown, min: number, max: number): v is number => finite(v) && Number.isInteger(v) && v >= min && v <= max;
interface CatalogParameter { index: number; label: string; required?: boolean; min?: number; max?: number; integer?: boolean; bitmask?: boolean; options?: { value: number }[] }
interface CatalogEntry { id: number; params: CatalogParameter[] }
const CATALOG = new Map<number, CatalogEntry>((JSON.parse(readFileSync(new URL("./assets/mission-catalog.json", import.meta.url), "utf8")) as {commands: CatalogEntry[]}).commands.map(c => [c.id,c]));
/** Catalog syntax/encoding checks; the connected autopilot still decides acceptance. */
export function validateCommandParameters(command: number, values: (number | null)[]): string | null {
  for (const field of CATALOG.get(command)?.params ?? []) {
    const value = values[field.index - 1];
    if (value === null) { if (field.required) return `${field.label} is required`; continue; }
    if (!finite(value) || value < (field.min ?? -3.4e38) || value > (field.max ?? 3.4e38) || (field.integer && !Number.isInteger(value))) return `${field.label} is outside its range or requires an integer`;
    if (field.options?.length) {
      if (field.bitmask) { const mask = field.options.reduce((n, option) => n | option.value, 0); if (!Number.isInteger(value) || value < 0 || (value & ~mask)) return `${field.label} has unsupported flag bits`; }
      else if (!field.options.some(option => option.value === value)) return `${field.label} is not a supported option`;
    }
  }
  return null;
}
export function validateMission(items: unknown, forUpload = true): string | null {
  if (!Array.isArray(items) || items.length > MAX_MISSION_ITEMS) return "Mission must contain at most 2000 items";
  for (const [seq, unknownItem] of items.entries()) {
    if (!unknownItem || typeof unknownItem !== "object") return "Mission item must be an object";
    const item = unknownItem as MissionItem;
    if (item.seq !== seq || !integer(item.command, 0, 65535) || !integer(item.frame, 0, 255)) return "Mission sequence, command or frame is invalid";
    if (typeof item.current !== "boolean" || typeof item.autocontinue !== "boolean" || !Array.isArray(item.params) || item.params.length !== 4) return "Mission flags and four parameters are required";
    if (![...item.params, item.z].every(v => v === null || (finite(v) && Math.abs(v) <= 3.4e38))) return "Mission parameters must be finite or null defaults";
    const scale = missionIntegerScale(item.command, item.frame);
    if (![item.x, item.y].every(v => forUpload ? finite(v) && Math.abs(Math.round(v * scale)) <= 2147483647 : v === null || finite(v))) return "Mission coordinates cannot be represented by integer MAVLink";
    if (POSITION.has(item.command)) {
      if (forUpload && item.z === null) return "Position commands require an altitude";
      if (GLOBAL.has(item.frame) && (Math.abs(item.x!) > 90 || Math.abs(item.y!) > 180)) return "Mission latitude or longitude is outside its bounds";
    }
    if (forUpload && item.command === 177 && !integer(item.params[0], 1, items.length - 1)) return "Jump target is outside the mission";
    const semantic = forUpload ? validateCommandParameters(item.command, [...item.params, item.x, item.y, item.z]) : null;
    if (semantic) return `Sequence ${seq}: ${semantic}`;
  }
  return null;
}
const wireFloat = (n: number | null): number => n === null ? NaN : n;
const decodedFloat = (n: number): number | null => Number.isNaN(n) ? null : n;
export function encodeMissionItem(item: MissionItem): common.MissionItemInt {
  const scale = missionIntegerScale(item.command, item.frame);
  return Object.assign(new common.MissionItemInt(), {
    seq: item.seq, command: item.command, frame: missionFrame(item.frame), current: 0, autocontinue: item.autocontinue ? 1 : 0,
    param1: wireFloat(item.params[0]), param2: wireFloat(item.params[1]), param3: wireFloat(item.params[2]), param4: wireFloat(item.params[3]),
    x: Math.round(item.x! * scale), y: Math.round(item.y! * scale), z: wireFloat(item.z), missionType: 0,
  });
}
export function decodeMissionItem(message: common.MissionItemInt | common.MissionItem): MissionItem {
  const scale = message instanceof common.MissionItemInt ? missionIntegerScale(message.command, message.frame) : 1;
  return {
    seq: message.seq, command: message.command, frame: message.frame,
    current: message.current === 1, autocontinue: message.autocontinue === 1,
    params: [message.param1, message.param2, message.param3, message.param4].map(decodedFloat) as MissionItem["params"],
    x: decodedFloat(message.x / scale), y: decodedFloat(message.y / scale), z: decodedFloat(message.z),
  };
}
export function missionRevision(items: MissionItem[]): string {
  return createHash("sha256").update(JSON.stringify(items.map(item => ({ ...item, current: false })))).digest("hex").slice(0, 24);
}
/** The autopilot maintains its actual home; upload is never a SET_HOME operation. */
export function verifyMission(expected: MissionItem[], actual: MissionItem[]): string[] {
  if (expected.length !== actual.length) return ["Downloaded mission count differs from upload"];
  const problems: string[] = [];
  const close = (a: number | null, b: number | null, tolerance: number, relative = true) => a === null || b === null ? a === b : Math.abs(a - b) <= Math.max(tolerance, relative ? Math.abs(a) * 2e-7 : 0);
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i], b = actual[i];
    if (i === 0 && a.command === 16 && missionFrame(a.frame) === 0 && b.command === 16 && missionFrame(b.frame) === 0) continue;
    const same = a.seq === b.seq && a.command === b.command && a.autocontinue === b.autocontinue
      && (missionIntegerScale(a.command, a.frame) === 1 || missionFrame(a.frame) === missionFrame(b.frame))
      && a.params.every((v, j) => close(v, b.params[j], 1e-4))
      && close(a.x, b.x, 2e-7, false) && close(a.y, b.y, 2e-7, false) && close(a.z, b.z, 0.011);
    if (!same) problems.push(`Downloaded sequence ${i} differs from upload`);
  }
  return problems;
}
