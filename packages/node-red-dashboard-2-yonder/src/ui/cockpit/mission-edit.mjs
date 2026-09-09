// Pure local draft operations; this module never communicates with an autopilot.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  validateMissionItem
} from './mission-commands.mjs';
import {planningHome} from './mission-home.mjs';

const fail = message => {
  throw new Error(`Mission draft: ${message}`);
};
const clone = value => structuredClone(value);

function checkMission(mission) {
  if (!mission || typeof mission !== 'object' || !Array.isArray(mission.items)) fail(
    'mission must contain an items array');
  if (mission.items.length > 2000) fail('mission contains more than 2000 items');
  const seen = new Set();
  for (const item of mission.items) {
    if (!item || !Number.isInteger(item.seq) || item.seq < 0) fail('item sequence must be a non-negative integer');
    if (seen.has(item.seq)) fail(`duplicate sequence ${item.seq}`);
    seen.add(item.seq);
    if (!Array.isArray(item.params) || item.params.length !== 4) fail(`sequence ${item.seq} needs four parameters`);
  }
}

function checkEdited(item) {
  const validation = validateMissionItem(item);
  if (!validation.valid) fail(validation.errors.join('; '));
}

function checkTags(items) {
  const tags = new Set(items.filter(item => item.command === 600).map(item => item.params[0]));
  for (const item of items)
    if (item.command === 601 && !tags.has(item.params[0])) fail(
      `DO_JUMP_TAG at sequence ${item.seq} references missing tag ${item.params[0]}`);
}

/** afterSeq=null inserts at the beginning. References supplied by the UI use the
 * current displayed sequence numbers. All surviving old items retain identity,
 * including a replacement. A newly inserted jump refers to an existing item.
 */
export function editMission(mission, operation) {
  checkMission(mission);
  if (!operation || typeof operation !== 'object') fail('operation must be an object');
  const draft = clone(mission);
  if(operation.kind==='set-home'){
    draft.home=planningHome(operation.home);
    draft.name=String(draft.name||'Mission').replace(/ \(draft\)$/,'')+' (draft)';
    draft.source='Local mission draft';
    return draft; // Home metadata does not renumber items or rewrite jump targets.
  }
  // Object identity is deliberately separate from a mutable mission sequence.
  const entries = draft.items.map(item => ({
    oldSeq: item.seq,
    item
  }));
  const original = new Map(entries.map(entry => [entry.oldSeq, entry]));
  const indexOf = seq => {
    const index = entries.findIndex(entry => entry.oldSeq === seq);
    if (index < 0) fail(`sequence ${seq} was not found`);
    return index;
  };
  let changed;
  switch (operation.kind) {
    case 'insert': {
      if (entries.length >= 2000) fail('mission contains more than 2000 items');
      const index = operation.afterSeq === null ? 0 : indexOf(operation.afterSeq) + 1;
      const item = clone(operation.item);
      // A caller's item.seq is not its identity for an insert.
      if (item && typeof item === 'object') item.seq = 1;
      checkEdited(item);
      changed = {
        oldSeq: null,
        item
      };
      entries.splice(index, 0, changed);
      break;
    }
    case 'replace': {
      const index = indexOf(operation.seq),
        entry = entries[index];
      if (!operation.item || typeof operation.item !== 'object') fail('replacement item must be an object');
      entry.item = {
        ...entry.item,
        ...clone(operation.item),
        seq: entry.oldSeq
      };
      checkEdited(entry.item);
      changed = entry;
      break;
    }
    case 'delete': {
      const index = indexOf(operation.seq);
      for (const entry of entries) {
        if (entry.oldSeq !== operation.seq && entry.item.command === 177 && entry.item.params[0] === operation.seq)
          fail(`sequence ${operation.seq} is a referenced DO_JUMP target; change or remove the jump first`);
      }
      entries.splice(index, 1);
      break;
    }
    case 'move': {
      if (![-1, 1].includes(operation.direction)) fail('move direction must be -1 or 1');
      const index = indexOf(operation.seq),
        destination = index + operation.direction;
      if (destination < 0) fail('the first item cannot move earlier');
      if (destination >= entries.length) fail('the last item cannot move later');
      [entries[index], entries[destination]] = [entries[destination], entries[index]];
      break;
    }
    default:
      fail(`unknown operation ${operation.kind}`);
  }
  const newSequences = new Map(entries.filter(entry => entry.oldSeq !== null).map((entry) => [entry.oldSeq, entries
    .indexOf(entry) + 1
  ]));
  for (const entry of entries) {
    if (entry.item.command !== 177) continue;
    const target = entry.item.params[0];
    if (!Number.isInteger(target) || target < 0) fail(`invalid DO_JUMP target ${target}`);
    if (newSequences.has(target)) entry.item.params[0] = newSequences.get(target);
    else if (target === 0 && draft.home && !original.has(0)) entry.item.params[0] = 0;
    else fail(`DO_JUMP target ${target} is missing or was removed`);
  }
  checkTags(entries.map(entry => entry.item));
  draft.items = entries.map((entry, index) => ({
    ...entry.item,
    seq: index + 1
  }));
  draft.name = String(draft.name || 'Mission').replace(/ \(draft\)$/, '') + ' (draft)';
  draft.source = 'Local mission draft';
  draft.warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  return draft;
}

/** QGC WPL 110 has numeric fields only. Null/unset MAVLink values cannot be
 * exported through the existing finite-number WPL import contract losslessly.
 * Reject them explicitly rather than silently turning an unset command into 0.
 */
export function exportWpl(mission) {
  checkMission(mission);
  if (!mission.items.length) fail('WPL export needs at least one mission item');
  const number = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(
      `WPL cannot represent null/unset or non-finite ${label}; keep the draft or set an explicit numeric value`);
    return String(value);
  };
  const record = item => {
    if (typeof item.current !== 'boolean' || typeof item.autocontinue !== 'boolean') fail(
    'WPL flags must be boolean');
    for (const key of ['seq', 'frame', 'command'])
      if (!Number.isInteger(item[key])) fail(`WPL ${key} must be an integer`);
    return [item.seq, item.current ? 1 : 0, item.frame, item.command, ...item.params, item.lat, item.lon, item.alt,
      item.autocontinue ? 1 : 0
    ].map((value, index) => number(value, `sequence ${item.seq} field ${index+1}`)).join('\t');
  };
  const lines = ['QGC WPL 110'];
  if (mission.home) {
    if (mission.items.some(item => item.seq === 0)) fail(
      'WPL home record conflicts with mission sequence zero; edit to normalize sequences first');
    lines.push(record({
      seq: 0,
      current: true,
      frame: 0,
      command: 16,
      params: [0, 0, 0, 0],
      ...mission.home,
      autocontinue: true
    }));
  }
  lines.push(...mission.items.map(record));
  return lines.join('\n') + '\n';
}
