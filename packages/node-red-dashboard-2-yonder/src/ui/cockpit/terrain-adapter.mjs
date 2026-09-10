// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: adapt measured terrain and capture-time camera geometry to the preserved display.
import {
  buildTerrainMesh,
  registrationValidity,
  latLonToUtm,
  bodyPointToCamera,
  projectCameraPoint,
  clearanceAdvisory,
  sampleTerrain
} from 'yonder-core/terrain';
import {
  cameraBasis
} from './terrain-state.mjs';
export function rendererMesh(tile, origin, layer = 'ground') {
  const mesh = buildTerrainMesh(tile, origin, layer),
    normals = new Float32Array(mesh.positions.length),
    uv = new Float32Array(mesh.positions.length / 3 * 2),
    t = tile.descriptor;
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    uv[i * 2] = (i % t.columns) / (t.columns - 1);
    uv[i * 2 + 1] = Math.floor(i / t.columns) / (t.rows - 1);
    for (let k = 0; k < 3; k++) {
      minimum[k] = Math.min(minimum[k], mesh.positions[i * 3 + k]);
      maximum[k] = Math.max(maximum[k], mesh.positions[i * 3 + k]);
    }
  }
  const h = mesh.heightsM;
  for (let row = 0; row < t.rows; row++)
    for (let col = 0; col < t.columns; col++) {
      const i = row * t.columns + col,
        left = Math.max(0, col - 1),
        right = Math.min(t.columns - 1, col + 1),
        top = Math.max(0, row - 1),
        bottom = Math.min(t.rows - 1, row + 1);
      const dx = (h[row * t.columns + right] - h[row * t.columns + left]) / ((right - left) * t.spacingM),
        dz = (h[bottom * t.columns + col] - h[top * t.columns + col]) / ((bottom - top) * t.spacingM),
        length = Math.hypot(dx, 1, dz);
      if (Number.isFinite(length)) {
        normals[i * 3] = -dx / length;
        normals[i * 3 + 1] = 1 / length;
        normals[i * 3 + 2] = -dz / length
      } else normals[i * 3 + 1] = 1;
    }
  return {
    ...mesh,
    normals,
    uv,
    x: t.id,
    y: 0,
    chunks: [{
      minimum,
      maximum,
      count: mesh.indices.length,
      offset: 0,
      coarseCount: 0
    }]
  };
}
export function cameraContext(camera, manifest, telemetry, now) {
  return {
    cameraId: camera?.id || '',
    profileId: camera?.profileId || '',
    nowMs: now,
    frameCaptureMs: camera?.frameCaptureMs ?? null,
    poseTimeMs: camera?.poseTimeMs ?? null,
    timeErrorMs: camera?.timeErrorMs ?? null,
    telemetryMaxAgeMs: 2000,
    frameMaxAgeMs: 1000,
    poseBracketed: camera?.poseBracketed === true && !!camera?.framePose,
    terrainDatum: manifest?.verticalDatum || 'UNKNOWN',
    aircraftDatum: telemetry?.altitudeDatum || 'UNKNOWN',
    verticalTransformVerified: manifest?.verticalTransform?.verified === true,
    terrainCovered: !!manifest
  };
}
/** No current-pose substitution: projection uses an explicitly bracketed capture-time pose. */
export function registeredPolygons({
  camera,
  manifest,
  tiles,
  telemetry,
  now,
  viewport,
  maxPolygons = 4000
}) {
  const no = reason => ({
    ready: false,
    reason,
    polygons: []
  });
  // Coarse maxima are a visual backdrop only; calibrated warning patches use observed native cells.
  tiles = tiles.filter(tile => tile.descriptor.level === 0);
  let gate;
  try {
    gate = registrationValidity(camera?.calibration || null, cameraContext(camera, manifest, telemetry, now));
  } catch {
    return no('Camera calibration invalid');
  }
  if (!gate.ready) return {
    ...gate,
    polygons: []
  };
  const pose = camera.framePose;
  if (![pose.lat, pose.lon, pose.altitudeM, pose.headingDeg, pose.pitchDeg, pose.rollDeg].every(Number.isFinite))
  return no('Capture-time pose incomplete');
  let position;
  try {
    position = latLonToUtm(pose.lat, pose.lon, manifest.horizontalCrs.zone);
  } catch {
    return no('Terrain coverage unavailable');
  }
  if (!tiles.some(tile => sampleTerrain(tile, position.eastingM, position.northingM).surfaceM !== null)) return no(
    'Observed terrain coverage unavailable');
  const north = latLonToUtm(pose.lat + .00001, pose.lon, manifest.horizontalCrs.zone),
    convergence = Math.atan2(north.eastingM - position.eastingM, north.northingM - position.northingM) * 180 / Math.PI;
  const basis = cameraBasis(pose.headingDeg + convergence, pose.pitchDeg, pose.rollDeg),
    dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0),
    polygons = [];
  const project = (east, north, height) => {
    const local = [east - position.eastingM, height - pose.altitudeM, position.northingM - north];
    return projectCameraPoint(bodyPointToCamera([dot(local, basis.forward), dot(local, basis.right), -dot(local, basis
      .up)], camera.calibration), camera.calibration, viewport);
  };
  const stride = 1; // Native cell geometry; never flatten an interior surface peak.
  outer: for (const tile of tiles) {
    const t = tile.descriptor;
    for (let row = 0; row < t.rows - 1; row += stride)
      for (let col = 0; col < t.columns - 1; col += stride) {
        const r = Math.min(row + stride, t.rows - 1),
          c = Math.min(col + stride, t.columns - 1),
          corners = [
            [row, col],
            [row, c],
            [r, c],
            [r, col]
          ];
        let observed = true;
        for (let y = row; y <= r && observed; y++)
          for (let x = col; x <= c; x++)
            if (!Number.isFinite(tile.surfaceM[y * t.columns + x])) {
              observed = false;
              break;
            } if (!observed) continue;
        const heights = corners.map(([y, x]) => tile.surfaceM[y * t.columns + x]),
          points = corners.map(([y, x], i) => project(t.originEastingM + x * t.spacingM, t.originNorthingM - y * t
            .spacingM, heights[i]));
        if (points.some(p => !p)) continue;
        const advisory = clearanceAdvisory({
          aircraftHeightM: pose.altitudeM,
          surfaceHeightM: Math.max(...heights),
          aircraftDatum: telemetry.altitudeDatum,
          terrainDatum: manifest.verticalDatum,
          transformVerified: true,
          telemetryFresh: true,
          coverageComplete: true,
          cautionClearanceM: 90,
          warningClearanceM: 30
        });
        if (advisory.level !== 'clear' && advisory.level !== 'unavailable') polygons.push({
          points,
          color: advisory.color,
          level: advisory.level
        });
        if (polygons.length >= maxPolygons) break outer;
      }
  }
  return {
    ready: true,
    reason: 'Registered mapped-surface advisory · 30 m warning / 90 m caution',
    polygons
  };
}
/** Invert the local UTM mapping for image coordinates, independently of height geometry. */
export function terrainImageCoordinate(eastingM, northingM, zone, seed) {
  let lat = seed.lat,
    lon = seed.lon;
  for (let n = 0; n < 4; n++) {
    const p = latLonToUtm(lat, lon, zone),
      a = latLonToUtm(lat + .00001, lon, zone),
      b = latLonToUtm(lat, lon + .00001, zone),
      ax = (a.eastingM - p.eastingM) / .00001,
      ay = (a.northingM - p.northingM) / .00001,
      bx = (b.eastingM - p.eastingM) / .00001,
      by = (b.northingM - p.northingM) / .00001,
      dx = eastingM - p.eastingM,
      dy = northingM - p.northingM,
      det = ax * by - bx * ay;
    lat += (dx * by - bx * dy) / det;
    lon += (ax * dy - dx * ay) / det;
  }
  return {
    lat,
    lon
  };
}
