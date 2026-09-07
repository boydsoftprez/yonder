// Geographic and camera math for the local research synthetic-vision display.
// SPDX-License-Identifier: GPL-3.0-or-later
const RAD = Math.PI / 180,
  EARTH_RADIUS = 6371008.8;
export const TERRAIN_ZOOM = 12;
// Near chunks sample essentially every source pixel; far chunks use alternate
// indices at half that density. 255×255 vertices fit WebGL 1 Uint16 indices.
export const TERRAIN_SEGMENTS = 254;
export function terrariumHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}
export function tilePosition(lat, lon, z = TERRAIN_ZOOM) {
  const n = 2 ** z,
    r = lat * RAD;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n
  };
}
export function tileCoordinate(x, y, z = TERRAIN_ZOOM) {
  const n = 2 ** z;
  return {
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / RAD,
    lon: x / n * 360 - 180
  };
}
export function localPosition(lat, lon, origin) {
  let longitude = lon - origin.lon;
  if (longitude > 180) longitude -= 360;
  if (longitude < -180) longitude += 360;
  return [longitude * RAD * EARTH_RADIUS * Math.cos(origin.lat * RAD), 0, -(lat - origin.lat) * RAD * EARTH_RADIUS];
}
export function cameraBasis(heading, pitch, roll) {
  const h = heading * RAD,
    p = pitch * RAD,
    r = roll * RAD;
  const forward = [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)];
  const right0 = [Math.cos(h), 0, Math.sin(h)],
    up0 = [-Math.sin(h) * Math.sin(p), Math.cos(p), Math.cos(h) * Math.sin(p)];
  return {
    forward,
    right: right0.map((x, i) => x * Math.cos(r) - up0[i] * Math.sin(r)),
    up: up0.map((x, i) => x * Math.cos(r) + right0[i] * Math.sin(r))
  };
}
export function viewMatrix(position, {
  right: r,
  up: u,
  forward: f
}) {
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, position), -dot(u,
    position), dot(f, position), 1]);
}
export function projectionMatrix(near = 2, far = 18000) {
  // Calibrated to the SVG's 640×650 viewport: zero-pitch horizon at y225,
  // and 5 vertical SVG pixels per degree close to the attitude reference.
  const focal = 5 / RAD,
    fx = 2 * focal / 640,
    fy = 2 * focal / 650,
    shift = 1 - 2 * 225 / 650;
  return new Float32Array([fx, 0, 0, 0, 0, fy, 0, 0, 0, -shift, -(far + near) / (far - near), -1, 0, 0, -2 * far *
    near / (far - near), 0
  ]);
}
export function transformPoint(m, p) {
  return [0, 1, 2, 3].map(row => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row] * p[3]);
}
// Conservative world-space AABB tests keep all potentially visible slopes.
export function terrainFrustum(view, projection) {
  const clip = new Float64Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let i = 0; i < 4; i++) clip[col * 4 + row] += projection[i * 4 + row] * view[col * 4 + i];
  const planes = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) planes.push([clip[3] + sign * clip[axis], clip[7] + sign * clip[4 + axis], clip[11] +
      sign * clip[8 + axis], clip[15] + sign * clip[12 + axis]
    ]);
  return planes;
}
export function terrainChunkVisible(chunk, planes) {
  for (const p of planes) {
    let distance = p[3];
    for (let axis = 0; axis < 3; axis++) distance += p[axis] * (p[axis] >= 0 ? chunk.maximum[axis] : chunk.minimum[
      axis]);
    if (distance < 0) return false;
  }
  return true;
}
export function terrainPose(f = {}, t = {}) {
  const good = f.live === true && f.attitudeValid === true && t.ready === true && t.fixType >= 3;
  const lat = t.latitude,
    lon = t.longitude,
    altitude = Number.isFinite(t.globalAltitudeM) ? t.globalAltitudeM : Number.isFinite(t.gpsAltitudeM) ? t
    .gpsAltitudeM : Number.isFinite(f.altitude) ? f.altitude * .3048 : null;
  if (!good || ![lat, lon, altitude, f.heading, f.pitch, f.roll].every(Number.isFinite) || Math.abs(lat) > 85 || Math
    .abs(lon) > 180 || Math.abs(f.pitch) > 90 || Math.abs(f.roll) > 180) return null;
  return {
    lat,
    lon,
    altitude,
    heading: f.heading,
    pitch: f.pitch,
    roll: f.roll
  };
}
// A 2048-pixel atlas provides metre-scale photographs within roughly 1 km of
// ownship. Recenter on z16 cells, keeping 48/64 images when crossing one cell.
export function terrainImageryPatch({
  lat,
  lon
}) {
  const z = 17,
    side = 8,
    world = 2 ** z,
    point = tilePosition(lat, lon, z),
    x = Math.floor(point.x / 2) * 2 - 3,
    y = Math.max(0, Math.min(world - side, Math.floor(point.y / 2) * 2 - 3));
  const tiles = [];
  for (let row = 0; row < side; row++)
    for (let col = 0; col < side; col++) tiles.push({
      x: ((x + col) % world + world) % world,
      y: y + row,
      z,
      col,
      row
    });
  return {
    x,
    y,
    z,
    side,
    key: `${z}/${x}/${y}`,
    tiles,
    metresPerPixel: 2 * Math.PI * EARTH_RADIUS * Math.cos(lat * RAD) / world / 256
  };
}
export function terrainImageryTransform(mesh, patch) {
  const scale = 2 ** (patch.z - TERRAIN_ZOOM),
    world = 2 ** TERRAIN_ZOOM;
  let delta = mesh.x - patch.x / scale;
  if (delta > world / 2) delta -= world;
  if (delta < -world / 2) delta += world;
  const factor = scale / patch.side;
  return [delta * factor, (mesh.y - patch.y / scale) * factor, factor, factor];
}
export function terrainClearance(pose, sampleHeight) {
  if (!pose || !sampleHeight) return null;
  const point = tilePosition(pose.lat, pose.lon),
    x = Math.floor(point.x),
    y = Math.floor(point.y),
    groundElevationM = sampleHeight(x, y, point.x - x, point.y - y);
  if (!Number.isFinite(groundElevationM)) return null;
  return {
    groundElevationM,
    estimatedAglM: pose.altitude - groundElevationM
  };
}
export function terrainTileSampler(tiles) {
  const tilesByKey = new Map(tiles.map(t => [`${t.x}/${t.y}`, t]));
  return (x, y, u, v) => {
    const fallback = tilesByKey.get(`${x}/${y}`),
      width = fallback.width,
      world = 2 ** fallback.z;
    // Terrarium pixels describe sample centers. Interpolate across adjacent tiles
    // so both meshes share the exact same elevations along their common edge.
    const px = (x + u) * width - .5,
      py = (y + v) * width - .5,
      a = Math.floor(px),
      b = Math.floor(py),
      dx = px - a,
      dy = py - b;
    const pixel = (column, row) => {
      const tileX = ((Math.floor(column / width) % world) + world) % world,
        tileY = Math.floor(row / width);
      let tile = tilesByKey.get(`${tileX}/${tileY}`);
      let c = ((column % width) + width) % width,
        r = ((row % width) + width) % width;
      if (!tile) {
        const distance = t => Math.min(Math.abs(t.x - tileX), world - Math.abs(t.x - tileX)) + Math.abs(t.y -
        tileY);
        tile = tiles.reduce((best, t) => distance(t) < distance(best) ? t : best, tiles[0]);
        let delta = column - tile.x * width;
        if (delta > world * width / 2) delta -= world * width;
        if (delta < -world * width / 2) delta += world * width;
        c = Math.max(0, Math.min(width - 1, delta));
        r = Math.max(0, Math.min(width - 1, row - tile.y * width));
      }
      const data = tile.rgba,
        at = (r * width + c) * 4;
      if (data[at + 3] === 0) throw new Error('Terrain has missing elevation cells');
      return terrariumHeight(data[at], data[at + 1], data[at + 2]);
    };
    return (pixel(a, b) * (1 - dx) + pixel(a + 1, b) * dx) * (1 - dy) + (pixel(a, b + 1) * (1 - dx) + pixel(a + 1, b +
      1) * dx) * dy;
  };
}
export function buildTerrainMesh({
  rgba,
  width,
  height,
  x,
  y,
  z = TERRAIN_ZOOM,
  segments = TERRAIN_SEGMENTS,
  origin,
  sampleHeight
}) {
  if (segments < 1 || segments > 254 || !Number.isInteger(segments)) throw new Error(
    'Terrain mesh resolution out of range');
  const refined = segments > 128 && segments % 2 === 0,
    side = segments + 1,
    count = side * side,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uv = new Float32Array(count * 2),
    indices = new Uint16Array(segments * segments * (refined ? 7.5 : 6));
  let minimum = Infinity,
    maximum = -Infinity;
  const elevation = (column, row) => {
    const at = (row * width + column) * 4;
    if (rgba[at + 3] === 0) throw new Error('Terrain has missing elevation cells');
    return terrariumHeight(rgba[at], rgba[at + 1], rgba[at + 2]);
  };
  const eastings = new Float64Array(side),
    southings = new Float64Array(side);
  for (let i = 0; i < side; i++) {
    const geo = tileCoordinate(x + i / segments, y + i / segments, z),
      position = localPosition(geo.lat, geo.lon, origin);
    eastings[i] = position[0];
    southings[i] = position[2];
  }
  for (let row = 0; row < side; row++)
    for (let column = 0; column < side; column++) {
      const u = column / segments,
        v = row / segments,
        px = u * (width - 1),
        py = v * (height - 1),
        a = Math.floor(px),
        b = Math.floor(py),
        dx = px - a,
        dy = py - b;
      const h0 = sampleHeight ? 0 : elevation(a, b) * (1 - dx) + elevation(Math.min(width - 1, a + 1), b) * dx;
      const h1 = sampleHeight ? 0 : elevation(a, Math.min(height - 1, b + 1)) * (1 - dx) + elevation(Math.min(width - 1,
        a + 1), Math.min(height - 1, b + 1)) * dx;
      const elevationM = sampleHeight ? sampleHeight(x, y, u, v) : h0 * (1 - dy) + h1 * dy;
      if (!Number.isFinite(elevationM) || elevationM < -12000 || elevationM > 10000) throw new Error(
        'Terrain contains invalid elevation');
      const index = row * side + column;
      positions[index * 3] = eastings[column];
      positions[index * 3 + 1] = elevationM;
      positions[index * 3 + 2] = southings[row];
      uv[index * 2] = u;
      uv[index * 2 + 1] = v;
      minimum = Math.min(minimum, elevationM);
      maximum = Math.max(maximum, elevationM);
    }
  for (let row = 0; row < side; row++)
    for (let column = 0; column < side; column++) {
      const l = (row * side + Math.max(0, column - 1)) * 3,
        r = (row * side + Math.min(segments, column + 1)) * 3,
        n = (Math.max(0, row - 1) * side + column) * 3,
        s = (Math.min(segments, row + 1) * side + column) * 3;
      const dx = positions[r] - positions[l],
        dz = positions[s + 2] - positions[n + 2],
        dhx = positions[r + 1] - positions[l + 1],
        dhz = positions[s + 1] - positions[n + 1];
      const nx = -dhx / dx,
        nz = -dhz / dz,
        length = Math.hypot(nx, 1, nz),
        index = (row * side + column) * 3;
      normals[index] = nx / length;
      normals[index + 1] = 1 / length;
      normals[index + 2] = nz / length;
    }
  // Small draw ranges avoid transforming all nine map tiles on every frame.
  const chunks = [];
  let at = 0;
  const chunkSize = refined ? 32 : 16;
  for (let north = 0; north < segments; north += chunkSize)
    for (let west = 0; west < segments; west += chunkSize) {
      const south = Math.min(segments, north + chunkSize),
        east = Math.min(segments, west + chunkSize),
        chunk = {
          offset: at,
          count: 0,
          minimum: [Infinity, Infinity, Infinity],
          maximum: [-Infinity, -Infinity, -Infinity]
        };
      for (let row = north; row <= south; row++)
        for (let column = west; column <= east; column++)
          for (let axis = 0; axis < 3; axis++) {
            const value = positions[(row * side + column) * 3 + axis];
            chunk.minimum[axis] = Math.min(chunk.minimum[axis], value);
            chunk.maximum[axis] = Math.max(chunk.maximum[axis], value);
          }
      const triangle = (a, b, c) => {
        if (a === b || b === c || a === c) return;
        indices[at++] = a;
        indices[at++] = b;
        indices[at++] = c;
      };
      // Both resolutions use the same every-second-vertex boundary. Collapsing
      // odd edge vertices prevents cracks when neighboring chunks change detail.
      const vertex = (row, column) => {
        if (refined) {
          if ((row === north || row === south) && column % 2) column--;
          if ((column === west || column === east) && row % 2) row--;
        }
        return row * side + column;
      };
      for (let row = north; row < south; row++)
        for (let column = west; column < east; column++) {
          const a = vertex(row, column),
            b = vertex(row, column + 1),
            c = vertex(row + 1, column),
            d = vertex(row + 1, column + 1);
          triangle(a, c, b);
          triangle(b, c, d);
        }
      chunk.count = at - chunk.offset;
      if (refined) {
        chunk.coarseOffset = at;
        for (let row = north; row < south; row += 2)
          for (let column = west; column < east; column += 2) {
            const a = row * side + column,
              b = a + 2,
              c = a + 2 * side,
              d = c + 2;
            triangle(a, c, b);
            triangle(b, c, d);
          }
        chunk.coarseCount = at - chunk.coarseOffset;
      }
      chunks.push(chunk);
    }
  return {
    x,
    y,
    z,
    positions,
    normals,
    uv,
    indices: indices.subarray(0, at),
    chunks,
    minimum,
    maximum
  };
}
