// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-18: an explicit VTOL variant; the imported original remains intact.
import original from './cove-demo.json' with { type: 'json' };
const mission = structuredClone(original);
mission.name = 'Cove VTOL — 180 ft takeoff, 300 ft route';
mission.source = 'Local QuadPlane demonstration';
mission.items[0] = { ...mission.items[0], command: 84, alt: 54.864 };
mission.warnings = [...mission.warnings,
  'Requires a configured QuadPlane. Start from the ground: climb vertically to 180 ft (54.864 m), then transition toward item 02 and climb to the route altitude of 300 ft above home.',
  'This variant preserves the original route; it does not include a landing command.'];
export default mission;
