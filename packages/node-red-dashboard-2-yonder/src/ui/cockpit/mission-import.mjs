const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 2000;

const GLOBAL_FRAMES = new Set([0, 3, 5, 6, 10, 11]);
const LOCAL_FRAMES = new Set([1, 4, 7, 8, 9]);
const POSITION_COMMANDS = new Set([16, 17, 18, 19, 21, 22, 31, 82, 84, 85, 94]);
const CURRENT_LOCATION_COMMANDS = new Set([21, 22, 84, 85]);

function fail(message) {
  throw new Error(`Mission import: ${message}`);
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isInteger(value)) {
    fail(`${label} must be an integer`);
  }
  return value;
}

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be finite`);
  }
  return value;
}

function requireFiniteOrNull(value, label) {
  if (value === null) return null;
  return requireFinite(value, label);
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    fail(`${label} must be boolean`);
  }
  return value;
}

function validateLatitude(value, label) {
  requireFinite(value, label);
  if (value < -90 || value > 90) fail(`${label} ${value} is outside -90..90`);
  return value;
}

function validateLongitude(value, label) {
  requireFinite(value, label);
  if (value < -180 || value > 180) fail(`${label} ${value} is outside -180..180`);
  return value;
}

function normalizeHome(home) {
  if (home === null || home === undefined) return null;
  requireObject(home, 'home');
  return {
    lat: validateLatitude(home.lat, 'home latitude'),
    lon: validateLongitude(home.lon, 'home longitude'),
    alt: requireFinite(home.alt, 'home altitude'),
  };
}

function normalizedFilename(filename) {
  const supplied = requireString(filename, 'filename');
  const leaf = supplied.replaceAll('\\', '/').split('/').pop();
  const withoutKnownExtension = leaf.replace(/\.(?:waypoints|plan)$/i, '');
  return withoutKnownExtension || 'Imported mission';
}

function validateItem(raw, label) {
  requireObject(raw, label);
  const seq = requireInteger(raw.seq, `${label} sequence`);
  if (seq < 0) fail(`${label} sequence must be non-negative`);

  const command = requireInteger(raw.command, `${label} command`);
  const frame = requireInteger(raw.frame, `${label} frame`);
  if (!Array.isArray(raw.params) || raw.params.length !== 4) {
    fail(`${label} must contain exactly four parameters`);
  }

  const item = {
    seq,
    command,
    frame,
    params: raw.params.map((value, index) => requireFiniteOrNull(value, `${label} parameter ${index + 1}`)),
    lat: requireFiniteOrNull(raw.lat, `${label} latitude`),
    lon: requireFiniteOrNull(raw.lon, `${label} longitude`),
    alt: requireFiniteOrNull(raw.alt, `${label} altitude`),
    current: requireBoolean(raw.current, `${label} current`),
    autocontinue: requireBoolean(raw.autocontinue, `${label} autocontinue`),
  };

  if (GLOBAL_FRAMES.has(frame) && POSITION_COMMANDS.has(command)) {
    validateLatitude(item.lat, `${label} latitude`);
    validateLongitude(item.lon, `${label} longitude`);
  }

  return item;
}

function frameWarnings(items) {
  const warnings = [];
  for (const item of items) {
    if (LOCAL_FRAMES.has(item.frame)) {
      warnings.push(
        `Sequence ${item.seq} uses local frame ${item.frame}; it is preserved but unavailable for map geometry.`);
    } else if (!GLOBAL_FRAMES.has(item.frame) && item.frame !== 2) {
      warnings.push(
        `Sequence ${item.seq} uses unknown frame ${item.frame}; it is preserved but unavailable for map geometry.`);
    }
  }
  return warnings;
}

function checkDuplicateSequences(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.seq)) fail(`duplicate sequence ${item.seq}`);
    seen.add(item.seq);
  }
}

function checkItems(items, allowEmpty = false) {
  if (items.length === 0 && !allowEmpty) fail('no mission items');
  if (items.length > MAX_ITEMS) fail(`mission contains more than ${MAX_ITEMS} items`);
  checkDuplicateSequences(items);
}

function makeMission({
  name,
  source,
  home,
  items,
  warnings
}, allowEmpty = false) {
  const normalizedItems = items.map((item, index) => {
    const label = Number.isInteger(item?.seq) ? `item sequence ${item.seq}` : `item ${index + 1}`;
    return validateItem(item, label);
  });
  checkItems(normalizedItems, allowEmpty);

  const suppliedWarnings = warnings.map((warning, index) => requireString(warning, `warning ${index + 1}`));
  const allWarnings = [...suppliedWarnings];
  for (const warning of frameWarnings(normalizedItems)) {
    if (!allWarnings.includes(warning)) allWarnings.push(warning);
  }

  return {
    name: requireString(name, 'name'),
    source: requireString(source, 'source'),
    home: normalizeHome(home),
    items: normalizedItems,
    warnings: allWarnings,
  };
}

function parseWplNumber(field, label) {
  if (field.trim() === '') fail(`${label} must be finite`);
  const value = Number(field);
  return requireFinite(value, label);
}

function parseWplInteger(field, label) {
  const value = parseWplNumber(field, label);
  return requireInteger(value, label);
}

function parseWplFlag(field, label) {
  const value = parseWplInteger(field, label);
  if (value !== 0 && value !== 1) fail(`${label} must be 0 or 1`);
  return value === 1;
}

function parseWpl(text, filename) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = lines.shift()?.trim();
  if (header !== 'QGC WPL 110') {
    fail(`unsupported WPL header ${JSON.stringify(header)}`);
  }

  const records = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    if (fields.length !== 12) {
      fail(`WPL line ${lineIndex + 2} must contain 12 tab-separated fields`);
    }
    const label = `WPL line ${lineIndex + 2}`;
    records.push({
      seq: parseWplInteger(fields[0], `${label} sequence`),
      current: parseWplFlag(fields[1], `${label} current flag`),
      frame: parseWplInteger(fields[2], `${label} frame`),
      command: parseWplInteger(fields[3], `${label} command`),
      params: fields.slice(4, 8).map((field, index) => parseWplNumber(field, `${label} parameter ${index + 1}`)),
      lat: parseWplNumber(fields[8], `${label} latitude`),
      lon: parseWplNumber(fields[9], `${label} longitude`),
      alt: parseWplNumber(fields[10], `${label} altitude`),
      autocontinue: parseWplFlag(fields[11], `${label} autocontinue flag`),
    });
  }

  if (records.length === 0) fail('no mission items');
  checkDuplicateSequences(records);
  const homeIndex = records.findIndex((item) =>
    item.seq === 0 && item.current && item.frame === 0 && item.command === 16);
  let home = null;
  const warnings = [];
  if (homeIndex !== -1) {
    const homeItem = records[homeIndex];
    home = {
      lat: homeItem.lat,
      lon: homeItem.lon,
      alt: homeItem.alt
    };
    records.splice(homeIndex, 1);
    warnings.push('WPL sequence 0 was recognized as the Mission Planner home record and excluded from mission items.');
  } else if (records.some((item) => item.seq === 0)) {
    warnings.push(
      'WPL sequence 0 did not match the Mission Planner home record signature and was preserved as a mission item.');
  }

  return makeMission({
    name: normalizedFilename(filename),
    source: 'Mission Planner QGC WPL 110',
    home,
    items: records,
    warnings,
  });
}

function qgcParam(value, label) {
  return requireFiniteOrNull(value, label);
}

function parseQgcPlan(plan, filename) {
  requireObject(plan, 'QGroundControl plan');
  if (plan.fileType !== 'Plan') fail('JSON fileType must be "Plan"');
  if (plan.version !== 1) fail(`unsupported QGroundControl Plan version ${JSON.stringify(plan.version)}`);

  const mission = requireObject(plan.mission, 'QGroundControl mission');
  if (mission.version !== 2) fail(`unsupported QGroundControl mission version ${JSON.stringify(mission.version)}`);
  if (!Array.isArray(mission.items)) fail('QGroundControl mission items must be an array');
  if (mission.items.length > MAX_ITEMS) fail(`mission contains more than ${MAX_ITEMS} items`);

  let home = null;
  if (mission.plannedHomePosition !== undefined && mission.plannedHomePosition !== null) {
    if (!Array.isArray(mission.plannedHomePosition) || mission.plannedHomePosition.length !== 3) {
      fail('QGroundControl plannedHomePosition must contain latitude, longitude, and altitude');
    }
    home = {
      lat: mission.plannedHomePosition[0],
      lon: mission.plannedHomePosition[1],
      alt: mission.plannedHomePosition[2],
    };
  }

  const items = mission.items.map((raw, index) => {
    requireObject(raw, `QGroundControl item ${index + 1}`);
    if (raw.type === 'ComplexItem') {
      const kind = typeof raw.complexItemType === 'string' ? raw.complexItemType : 'unknown';
      fail(`ComplexItem ${JSON.stringify(kind)} is unsupported; its generated mission geometry was not imported`);
    }
    if (raw.type !== 'SimpleItem') fail(
      `QGroundControl item ${index + 1} has unsupported type ${JSON.stringify(raw.type)}`);
    if (!Array.isArray(raw.params) || raw.params.length !== 7) {
      fail(`QGroundControl item ${index + 1} params must contain exactly seven values`);
    }

    return {
      seq: requireInteger(raw.doJumpId, `QGroundControl item ${index + 1} doJumpId`),
      command: requireInteger(raw.command, `QGroundControl item ${index + 1} command`),
      frame: requireInteger(raw.frame, `QGroundControl item ${index + 1} frame`),
      params: raw.params.slice(0, 4).map((value, paramIndex) => qgcParam(value,
        `QGroundControl item ${index + 1} parameter ${paramIndex + 1}`)),
      lat: qgcParam(raw.params[4], `QGroundControl item ${index + 1} latitude`),
      lon: qgcParam(raw.params[5], `QGroundControl item ${index + 1} longitude`),
      alt: qgcParam(raw.params[6], `QGroundControl item ${index + 1} altitude`),
      current: false,
      autocontinue: requireBoolean(raw.autoContinue, `QGroundControl item ${index + 1} autoContinue`),
    };
  });

  return makeMission({
    name: normalizedFilename(filename),
    source: 'QGroundControl Plan',
    home,
    items,
    warnings: [],
  });
}

export function isPositionItem(item) {
  if (item === null || typeof item !== 'object') return false;
  if (!GLOBAL_FRAMES.has(item.frame) || !POSITION_COMMANDS.has(item.command)) return false;
  if (typeof item.lat !== 'number' || !Number.isFinite(item.lat) || item.lat < -90 || item.lat > 90) return false;
  if (typeof item.lon !== 'number' || !Number.isFinite(item.lon) || item.lon < -180 || item.lon > 180) return false;
  if (CURRENT_LOCATION_COMMANDS.has(item.command) && item.lat === 0 && item.lon === 0) return false;
  return true;
}

export function normalizeMission(raw, {
  allowEmpty = false
} = {}) {
  requireObject(raw, 'mission');
  if (!Array.isArray(raw.items)) fail('items must be an array');
  if (!Array.isArray(raw.warnings)) fail('warnings must be an array');
  return makeMission({
    name: raw.name,
    source: raw.source,
    home: raw.home,
    items: raw.items,
    warnings: raw.warnings,
  }, allowEmpty === true);
}

export function parseMission(text, filename = 'Imported mission') {
  if (typeof text !== 'string') fail('input must be text');
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    fail(`file is too large (maximum ${MAX_TEXT_BYTES} bytes)`);
  }
  const trimmed = text.trim();
  if (trimmed === '') fail('file is empty');

  const withoutBom = trimmed.replace(/^\uFEFF/, '');
  if (withoutBom.startsWith('{') || withoutBom.startsWith('[')) {
    let decoded;
    try {
      decoded = JSON.parse(withoutBom);
    } catch (error) {
      fail(`invalid JSON (${error.message})`);
    }
    return parseQgcPlan(decoded, filename);
  }
  if (withoutBom.startsWith('QGC WPL')) return parseWpl(withoutBom, filename);
  fail('unsupported mission file; expected QGC WPL 110 text or a QGroundControl Plan JSON object');
}
