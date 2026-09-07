// Display references and settings. These values never become aircraft commands.
// SPDX-License-Identifier: GPL-3.0-or-later
export const referenceFields = Object.freeze({
  airspeed: {
    title: 'Airspeed reference',
    short: 'IAS',
    unit: 'KT',
    min: 0,
    max: 500,
    step: 1,
    coarse: 10
  },
  altitude: {
    title: 'Altitude reference',
    short: 'ALT',
    unit: 'FT MSL',
    min: -2000,
    max: 60000,
    step: 100,
    coarse: 1000
  },
  heading: {
    title: 'Heading reference',
    short: 'HDG',
    unit: '° TRUE',
    min: 0,
    max: 359,
    step: 1,
    coarse: 10
  },
  vsi: {
    title: 'Vertical speed reference',
    short: 'VS',
    unit: 'FPM',
    min: -6000,
    max: 6000,
    step: 100,
    coarse: 500
  },
});
export const displayDefaults = Object.freeze({
  tapeOpacity: .35,
  hsiOpacity: .3,
  pitchLadder: true,
  secondary: true,
  syntheticVision: true,
  fdVisible: true,
  fdStyle: 'vbar',
  windDisplay: 'components',
  stripPlacement: 'mfd',
  layout: 'split'
});
export function parseReference(key, input) {
  const field = referenceFields[key];
  if (!field) throw new Error('Unknown display reference');
  if ((typeof input !== 'string' && typeof input !== 'number') || String(input).trim() === '' || !/^[-+]?\d+(?:\.\d+)?$/
    .test(String(input).trim())) throw new Error('Enter a numeric value');
  const value = Number(input);
  if (!Number.isFinite(value) || value < field.min || value > field.max) throw new Error(
    `Use ${field.min.toLocaleString('en-US')} to ${field.max.toLocaleString('en-US')} ${field.unit}`);
  return Math.round(value);
}
export function referenceStep(key, input, amount) {
  const field = referenceFields[key];
  if (!field) throw new Error('Unknown display reference');
  const value = Number.isFinite(input) ? input : 0;
  if (key === 'heading') return ((Math.round(value + amount) % 360) + 360) % 360;
  return Math.max(field.min, Math.min(field.max, Math.round(value + amount)));
}
export function validatePfdPreferences(input = {}) {
  const references = {
      airspeed: null,
      altitude: null,
      heading: null,
      vsi: null
    },
    display = {
      ...displayDefaults
    };
  for (const key of Object.keys(references)) {
    try {
      references[key] = parseReference(key, input?.references?.[key]);
    } catch {}
  }
  for (const key of ['pitchLadder', 'secondary', 'syntheticVision', 'fdVisible'])
    if (typeof input?.display?.[key] === 'boolean') display[key] = input.display[key];
  for (const key of ['tapeOpacity', 'hsiOpacity'])
    if (Number.isFinite(input?.display?.[key])) display[key] = Math.max(.1, Math.min(1, input.display[key]));
  if (['components', 'vector', 'direction', 'off'].includes(input?.display?.windDisplay)) display.windDisplay = input.display.windDisplay;
  if (['vbar', 'crossbar'].includes(input?.display?.fdStyle)) display.fdStyle = input.display.fdStyle;
  if (['pfd', 'mfd', 'hidden'].includes(input?.display?.stripPlacement)) display.stripPlacement = input.display
    .stripPlacement;
  if (['split', 'pfd-wide', 'mfd-wide', 'swap'].includes(input?.display?.layout)) display.layout = input.display.layout;
  return {
    references,
    display
  };
}
export function missionAltitudeFt(item, home) {
  if (!item || !Number.isFinite(item.alt)) return null;
  if ([0, 5].includes(item.frame)) return item.alt * 3.280839895;
  if ([3, 6].includes(item.frame) && Number.isFinite(home?.alt)) return (home.alt + item.alt) * 3.280839895;
  return null; // Terrain-relative altitude needs a terrain reference at the target.
}
export function flightDirectorCue(flight) {
  if (!flight.attitudeValid || !flight.fdValid || !Number.isFinite(flight.navRoll) || !Number.isFinite(flight.navPitch))
    return null;
  const rollError = ((flight.navRoll - flight.roll + 540) % 360) - 180;
  const pitchError = flight.navPitch - flight.pitch;
  return {
    rollError,
    pitchError,
    x: Math.max(-55, Math.min(55, rollError * 2.2)),
    y: Math.max(-60, Math.min(60, -pitchError * 5)),
    rotation: Math.max(-30, Math.min(30, rollError))
  };
}
