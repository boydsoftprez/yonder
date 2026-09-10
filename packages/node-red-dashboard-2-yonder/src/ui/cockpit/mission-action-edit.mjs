// Local command conversion against the pinned Plane catalog. No aircraft effects.
// SPDX-License-Identifier: GPL-3.0-or-later
import {createMissionItem, getCommand} from './mission-commands.mjs';
export function changeMissionAction(item, command) {
  const next = getCommand(command);
  if (!next) throw new Error(`Unknown mission command ${command}`);
  if (item.command === command) return {...item, params: [...item.params]};
  const source = getCommand(item.command);
  const converted = createMissionItem(command, {
    ...(source?.location ? {lat: item.lat, lon: item.lon} : {}),
    ...(source?.altitude ? {alt: item.alt} : {}),
    ...([0,3,5,6,10,11].includes(item.frame) ? {frame: item.frame} : {})
  });
  // Setting home requires an absolute altitude. Preserve the coordinates, but
  // require the operator to supply MSL instead of relabeling a relative height.
  if (command === 179 && ![0, 5].includes(item.frame)) {
    converted.frame = 0;
    converted.alt = null;
  }
  // P1–P4 never inherit meanings from a different command. Geographic fields are
  // preserved where the destination consumes coordinates/altitude; other fields use defaults.
  return {...converted, seq: item.seq, current: item.current, autocontinue: item.autocontinue};
}
export function loiterPresentation(item) {
  if (![17, 18, 19, 31].includes(item?.command)) return null;
  const radiusIndex = item.command === 19 ? null : item.command === 31 ? 2 : 3;
  const value = item.params[radiusIndex === null ? 2 : radiusIndex - 1];
  return {radiusIndex, radiusM: radiusIndex !== null && Number.isFinite(value) && value !== 0 ? Math.abs(value) : null, radiusSource: radiusIndex === null || value === 0 ? 'WP_LOITER_RAD' : 'Mission item', direction: value < 0 ? 'ccw' : value > 0 ? 'cw' : 'default', duration: item.command === 17 ? 'Unlimited' : item.command === 18 ? `${item.params[0]} turns` : item.command === 19 ? `${item.params[0]} s` : 'Until target altitude'};
}
