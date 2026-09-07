<template>
  <div
    class="terrain-vision"
    :data-terrain-ready="visible"
    :data-terrain-status="message"
    :data-terrain-imagery="imageryState"
    :data-terrain-imagery-tiles="imageryCount"
    :data-terrain-detail="detailState"
    :data-terrain-detail-resolution="detailMetresPerPixel"
    style="position: absolute; inset: 0; pointer-events: none; overflow: hidden"
    aria-hidden="true"
  >
    <canvas
      ref="canvas"
      class="terrain-canvas"
      :style="{ visibility: visible ? 'visible' : 'hidden' }"
      style="display: block; width: 100%; height: 100%"
    ></canvas>
    <div
      v-if="visible && (imageryCount || detailState === 'ready')"
      style="
        position: absolute;
        bottom: 2px;
        left: 4px;
        right: 4px;
        color: #d7e3ec;
        text-shadow: 0 1px 2px #000;
        font: 9px sans-serif;
        text-align: right;
      "
    >
      {{ imageryAttribution }}
    </div>
  </div>
</template>
<script>
// Optional real-elevation synthetic vision for the disposable browser cockpit.
// Terrain source: Mapzen Terrain Tiles on AWS; USGS NED/3DEP in the demo region.
// SPDX-License-Identifier: GPL-3.0-or-later
import { latLonToUtm, evaluateTerrainPath } from "yonder-core/terrain";
import { loadTerrainPack } from "./terrain-pack-client.mjs";
import { viewportProjection } from "./terrain-viewport.mjs";
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import {
  TERRAIN_ZOOM,
  tilePosition,
  tileCoordinate,
  localPosition,
  cameraBasis,
  viewMatrix,
  projectionMatrix,
  terrainPose,
  buildTerrainMesh,
  terrainTileSampler,
  terrainImageryPatch,
  terrainImageryTransform,
  terrainClearance,
  terrainFrustum,
  terrainChunkVisible,
} from "./terrain-state.mjs";
const ATTRIBUTION = "Mapzen terrain · USGS and other elevation providers";
const ATTRIBUTION_URL =
  "https://github.com/tilezen/joerd/blob/master/docs/attribution.md";
const IMAGERY_ATTRIBUTION =
  "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const IMAGERY_ATTRIBUTION_URL =
  "https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9";
const MAX_CACHED_TILES = 36;
const elevationMemories = new WeakMap();
async function imageryTile(x, y, z, signal, provider) {
  if (!provider) throw new Error("Ground imagery provider unavailable");
  return provider.tile("imagery", z, x, y, { signal });
}
async function imagerySurface(tile, signal, provider) {
  // Coarse photographs cover the full elevation region. A separate atlas follows
  // the aircraft across these tile boundaries, without changing the geometry.
  const detail = 1,
    side = 2 ** detail;
  const surface = document.createElement("canvas");
  surface.width = surface.height = 256 * side;
  const context = surface.getContext("2d");
  if (!context) throw new Error("Surface imagery decoding unavailable");
  let next = 0;
  await Promise.all(
    Array.from(
      {
        length: Math.min(4, side * side),
      },
      async () => {
        while (next < side * side) {
          const index = next++,
            row = Math.floor(index / side),
            col = index % side;
          const blob = await imageryTile(
              tile.x * side + col,
              tile.y * side + row,
              tile.z + detail,
              signal,
              provider,
            ),
            bitmap = await createImageBitmap(blob);
          try {
            if (bitmap.width !== 256 || bitmap.height !== 256)
              throw new Error("Unexpected imagery tile size");
            context.drawImage(bitmap, col * 256, row * 256);
          } finally {
            bitmap.close();
          }
        }
      },
    ),
  );
  return {
    x: tile.x,
    y: tile.y,
    surface,
  };
}
async function imageryPatchSurface(patch, signal, provider) {
  const surface = document.createElement("canvas");
  surface.width = surface.height = patch.side * 256;
  const context = surface.getContext("2d");
  if (!context) throw new Error("Surface imagery decoding unavailable");
  let next = 0;
  await Promise.all(
    Array.from(
      {
        length: 6,
      },
      async () => {
        while (next < patch.tiles.length) {
          const tile = patch.tiles[next++],
            blob = await imageryTile(tile.x, tile.y, tile.z, signal, provider),
            bitmap = await createImageBitmap(blob);
          try {
            if (bitmap.width !== 256 || bitmap.height !== 256)
              throw new Error("Unexpected imagery tile size");
            context.drawImage(bitmap, tile.col * 256, tile.row * 256);
          } finally {
            bitmap.close();
          }
        }
      },
    ),
  );
  return {
    patch,
    surface,
  };
}
async function elevationTile(x, y, z, signal, provider) {
  if (!provider) throw new Error("Ground terrain provider unavailable");
  let state = elevationMemories.get(provider);
  if (!state || state.revision !== provider.revision) {
    state = { revision: provider.revision, tiles: new Map() };
    elevationMemories.set(provider, state);
  }
  const tileMemory = state.tiles;
  const key = `${z}/${x}/${y}`;
  if (tileMemory.has(key)) {
    const stored = tileMemory.get(key);
    tileMemory.delete(key);
    tileMemory.set(key, stored);
    return stored;
  }
  const work = (async () => {
    const blob = await provider.tile("elevation", z, x, y, { signal }),
      bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
    try {
      if (bitmap.width !== 256 || bitmap.height !== 256)
        throw new Error("Unexpected terrain tile size");
      const surface = document.createElement("canvas");
      surface.width = bitmap.width;
      surface.height = bitmap.height;
      const context = surface.getContext("2d", {
        willReadFrequently: true,
      });
      if (!context) throw new Error("Elevation decoding unavailable");
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return {
        x,
        y,
        z,
        width: bitmap.width,
        height: bitmap.height,
        rgba,
      };
    } finally {
      bitmap.close();
    }
  })();
  tileMemory.set(key, work);
  while (tileMemory.size > MAX_CACHED_TILES)
    tileMemory.delete(tileMemory.keys().next().value);
  try {
    return await work;
  } catch (error) {
    if (tileMemory.get(key) === work) tileMemory.delete(key);
    throw error;
  }
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function program(gl, vertex, fragment) {
  const p = gl.createProgram(),
    v = compile(gl, gl.VERTEX_SHADER, vertex),
    f = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function createRenderer(canvas) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: true,
    powerPreference: "low-power",
  });
  if (!gl || gl.isContextLost()) throw new Error("WebGL unavailable");
  const index32 = gl.getExtension("OES_element_index_uint");
  const requireContext = () => {
    if (gl.isContextLost()) throw new Error("WebGL context lost");
  };
  const terrainProgram = program(
    gl,
    `
  attribute vec3 position;attribute vec3 normal;attribute vec2 uv;uniform mat4 view;uniform mat4 projection;
  varying vec3 vNormal;varying vec2 vUv;varying float vElevation;varying float vDistance;
  void main(){vec4 p=view*vec4(position,1.0);gl_Position=projection*p;vNormal=normal;vUv=uv;vElevation=position.y;vDistance=length(p.xyz);}
 `,
    `
  precision highp float;varying vec3 vNormal;varying vec2 vUv;varying float vElevation;varying float vDistance;
  uniform bool mappedSurface;uniform float aircraftHeight;uniform sampler2D imagery;uniform bool textured;uniform sampler2D detailImagery;uniform bool detailed;uniform vec4 detailTransform;
  void main(){
   vec3 low=vec3(.31,.36,.20),high=vec3(.49,.39,.25);
   vec3 color=mix(low,high,smoothstep(250.0,1500.0,vElevation));
   if(textured)color=texture2D(imagery,vUv).rgb;
   vec2 nearUv=vUv*detailTransform.zw+detailTransform.xy;
   if(detailed&&nearUv.x>=0.0&&nearUv.x<=1.0&&nearUv.y>=0.0&&nearUv.y<=1.0){
    float edge=min(min(nearUv.x,1.0-nearUv.x),min(nearUv.y,1.0-nearUv.y));
    color=mix(color,texture2D(detailImagery,nearUv).rgb,smoothstep(0.0,.04,edge));
   }
   float light=.62+.38*max(0.0,dot(normalize(vNormal),normalize(vec3(-.55,.85,-.35))));
   color*=light;
   if(mappedSurface){float clearance=aircraftHeight-vElevation;if(clearance<30.0)color=mix(color,vec3(1.0,.23,.19),.65);else if(clearance<90.0)color=mix(color,vec3(1.0,.75,.23),.55);}
   float fog=smoothstep(4500.0,10500.0,vDistance);color=mix(color,vec3(.62,.68,.69),fog);
   gl_FragColor=vec4(color,1.0);
  }
 `,
  );
  const skyProgram = program(
    gl,
    `
  attribute vec2 position;varying vec2 screen;void main(){screen=position;gl_Position=vec4(position,1.0,1.0);}
 `,
    `
  precision mediump float;varying vec2 screen;uniform vec3 right;uniform vec3 up;uniform vec3 forward;uniform vec2 clipScale;
  void main(){
   vec3 ray=normalize(right*(screen.x/(.8952466*clipScale.x))+up*((screen.y-.3076923*clipScale.y)/(.8814735*clipScale.y))+forward);
   float sky=smoothstep(-.012,.008,ray.y);
   vec3 horizon=vec3(.62,.68,.69),zenith=vec3(.035,.24,.48);
   vec3 color=mix(horizon,zenith,smoothstep(0.0,.85,max(0.0,ray.y)));
   gl_FragColor=vec4(mix(vec3(.62,.68,.69),color,sky),1.0);
  }
 `,
  );
  const skyBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const fallbackTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fallbackTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  const location = (p, name) => gl.getUniformLocation(p, name),
    terrain = {
      mappedSurface: location(terrainProgram, "mappedSurface"),
      aircraftHeight: location(terrainProgram, "aircraftHeight"),
      position: gl.getAttribLocation(terrainProgram, "position"),
      normal: gl.getAttribLocation(terrainProgram, "normal"),
      uv: gl.getAttribLocation(terrainProgram, "uv"),
      imagery: location(terrainProgram, "imagery"),
      textured: location(terrainProgram, "textured"),
      detailImagery: location(terrainProgram, "detailImagery"),
      detailed: location(terrainProgram, "detailed"),
      detailTransform: location(terrainProgram, "detailTransform"),
      view: location(terrainProgram, "view"),
      projection: location(terrainProgram, "projection"),
    };
  const sky = {
    clipScale: location(skyProgram, "clipScale"),
    position: gl.getAttribLocation(skyProgram, "position"),
    right: location(skyProgram, "right"),
    up: location(skyProgram, "up"),
    forward: location(skyProgram, "forward"),
  };
  let meshes = [],
    detailTexture = null,
    detailPatch = null;
  const clearDetail = () => {
    if (detailTexture) gl.deleteTexture(detailTexture);
    detailTexture = null;
    detailPatch = null;
  };
  const uploadTexture = (surface) => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      surface,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
    if (anisotropy)
      gl.texParameterf(
        gl.TEXTURE_2D,
        anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)),
      );
    return texture;
  };
  const disposeMeshes = () => {
    for (const mesh of meshes) {
      for (const buffer of [mesh.position, mesh.normal, mesh.uv, mesh.indices])
        gl.deleteBuffer(buffer);
      if (mesh.texture) gl.deleteTexture(mesh.texture);
    }
    meshes = [];
  };
  const buffer = (target, data) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };
  return {
    isContextLost: () => gl.isContextLost(),
    replace(data) {
      requireContext();
      disposeMeshes();
      clearDetail();
      if (data.some((m) => m.indices instanceof Uint32Array) && !index32)
        throw new Error("32-bit terrain indices unavailable");
      meshes = data.map((mesh) => ({
        packImagery: mesh.packImagery === true,
        surface: mesh.surface === true,
        indexType:
          mesh.indices instanceof Uint32Array
            ? gl.UNSIGNED_INT
            : gl.UNSIGNED_SHORT,
        indexBytes: mesh.indices.BYTES_PER_ELEMENT,
        x: mesh.x,
        y: mesh.y,
        position: buffer(gl.ARRAY_BUFFER, mesh.positions),
        normal: buffer(gl.ARRAY_BUFFER, mesh.normals),
        uv: buffer(gl.ARRAY_BUFFER, mesh.uv),
        indices: buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices),
        count: mesh.indices.length,
        chunks: mesh.chunks,
        texture: null,
      }));
    },
    texture({ x, y, surface }) {
      requireContext();
      const mesh = meshes.find((mesh) => mesh.x === x && mesh.y === y);
      if (!mesh) return;
      const texture = uploadTexture(surface);
      if (mesh.texture) gl.deleteTexture(mesh.texture);
      mesh.texture = texture;
    },
    detail({ patch, surface }) {
      requireContext();
      const texture = uploadTexture(surface);
      clearDetail();
      detailTexture = texture;
      detailPatch = patch;
    },
    draw(pose, origin, optics) {
      requireContext();
      const pixelRatio = Math.min(1.5, window.devicePixelRatio || 1),
        width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio)),
        height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      const grid = origin.utm
          ? latLonToUtm(pose.lat, pose.lon, origin.zone)
          : null,
        north = origin.utm
          ? latLonToUtm(pose.lat + 0.00001, pose.lon, origin.zone)
          : null,
        convergence = grid
          ? (Math.atan2(
              north.eastingM - grid.eastingM,
              north.northingM - grid.northingM,
            ) *
              180) /
            Math.PI
          : 0;
      const basis = cameraBasis(
          pose.heading + convergence,
          pose.pitch,
          pose.roll,
        ),
        viewport = viewportProjection(width, height, optics);
      gl.useProgram(skyProgram);
      gl.uniform2fv(sky.clipScale, viewport.scale);
      gl.uniform3fv(sky.right, basis.right);
      gl.uniform3fv(sky.up, basis.up);
      gl.uniform3fv(sky.forward, basis.forward);
      gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
      gl.enableVertexAttribArray(sky.position);
      gl.vertexAttribPointer(sky.position, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(sky.position);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(terrainProgram);
      const position = grid
        ? [
            grid.eastingM - origin.eastingM,
            0,
            origin.northingM - grid.northingM,
          ]
        : localPosition(pose.lat, pose.lon, origin);
      position[1] = pose.altitude;
      const view = viewMatrix(position, basis),
        projection = viewport.matrix,
        frustum = terrainFrustum(view, projection);
      gl.uniformMatrix4fv(terrain.view, false, view);
      gl.uniformMatrix4fv(terrain.projection, false, projection);
      gl.enableVertexAttribArray(terrain.position);
      gl.enableVertexAttribArray(terrain.normal);
      gl.enableVertexAttribArray(terrain.uv);
      gl.uniform1i(terrain.imagery, 0);
      gl.uniform1i(terrain.detailImagery, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, detailTexture || fallbackTexture);
      gl.uniform1i(terrain.detailed, detailTexture ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(terrain.aircraftHeight, pose.altitude);
      for (const mesh of meshes) {
        gl.uniform1i(terrain.mappedSurface, mesh.surface ? 1 : 0);
        gl.uniform4fv(
          terrain.detailTransform,
          detailPatch
            ? mesh.packImagery
              ? [
                  -detailPatch.x / detailPatch.side,
                  -detailPatch.y / detailPatch.side,
                  1 / detailPatch.side,
                  1 / detailPatch.side,
                ]
              : terrainImageryTransform(mesh, detailPatch)
            : [0, 0, 0, 0],
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.position);
        gl.vertexAttribPointer(terrain.position, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
        gl.vertexAttribPointer(terrain.normal, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
        gl.vertexAttribPointer(terrain.uv, 2, gl.FLOAT, false, 0, 0);
        gl.bindTexture(gl.TEXTURE_2D, mesh.texture || fallbackTexture);
        gl.uniform1i(terrain.textured, mesh.texture ? 1 : 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
        for (const chunk of mesh.chunks)
          if (terrainChunkVisible(chunk, frustum)) {
            const dx = Math.max(
                chunk.minimum[0] - position[0],
                0,
                position[0] - chunk.maximum[0],
              ),
              dz = Math.max(
                chunk.minimum[2] - position[2],
                0,
                position[2] - chunk.maximum[2],
              );
            const coarse = chunk.coarseCount && Math.hypot(dx, dz) > 1500;
            gl.drawElements(
              gl.TRIANGLES,
              coarse ? chunk.coarseCount : chunk.count,
              mesh.indexType,
              (coarse ? chunk.coarseOffset : chunk.offset) * mesh.indexBytes,
            );
          }
      }
      gl.disableVertexAttribArray(terrain.position);
      gl.disableVertexAttribArray(terrain.normal);
      gl.disableVertexAttribArray(terrain.uv);
    },
    dispose() {
      disposeMeshes();
      clearDetail();
      gl.deleteTexture(fallbackTexture);
      gl.deleteBuffer(skyBuffer);
      gl.deleteProgram(terrainProgram);
      gl.deleteProgram(skyProgram);
    },
  };
}
export default {
  props: [
    "flight",
    "telemetry",
    "enabled",
    "displayPose",
    "imageryEnabled",
    "lookaheadSeconds",
    "dataProvider",
    "viewport",
  ],
  emits: ["status"],
  setup(props, { emit }) {
    const canvas = ref(null),
      visible = ref(false),
      message = ref("Synthetic vision off"),
      imageryState = ref("disabled"),
      imageryCount = ref(0),
      detailState = ref("disabled"),
      detailMetresPerPixel = ref(null),
      clearance = ref(null);
    let lastForecast = -Infinity,
      forecast = null,
      lastDraw = -Infinity,
      pack = null,
      renderer = null,
      frame = 0,
      regionKey = "",
      loadingKey = "",
      origin = null,
      controller = null,
      generation = 0,
      failedUntil = 0,
      disposed = false,
      wasEnabled = false,
      graphicsUnavailable = false,
      lastStatus = "",
      groundSampler = null,
      detailController = null,
      detailGeneration = 0,
      detailKey = "",
      detailLoadingKey = "",
      detailFailedUntil = 0;
    const status = (state, text) => {
      if (state !== "ready") forecast = null;
      visible.value = state === "ready";
      message.value = text;
      const ground = visible.value ? clearance.value : null;
      const key = [
        JSON.stringify(forecast),
        state,
        text,
        imageryState.value,
        imageryCount.value,
        detailState.value,
        Math.round((ground?.estimatedAglM ?? 0) / 0.3048),
        Math.round(ground?.groundElevationM ?? 0),
      ].join("|");
      if (key === lastStatus) return;
      lastStatus = key;
      emit("status", {
        forecast,
        ready: visible.value,
        state,
        message: text,
        imageryState: imageryState.value,
        imageryTiles: imageryCount.value,
        detailState: detailState.value,
        detailMetresPerPixel: detailMetresPerPixel.value,
        groundElevationM: ground?.groundElevationM ?? null,
        estimatedAglM: ground?.estimatedAglM ?? null,
        attribution: pack
          ? pack.manifest.sources.map((s) => s.attribution).join(" · ")
          : ATTRIBUTION,
        terrainManifest: pack?.manifest || null,
        attributionUrl: pack ? pack.manifest.sources[0]?.url : ATTRIBUTION_URL,
        imageryAttribution: IMAGERY_ATTRIBUTION,
        imageryAttributionUrl: IMAGERY_ATTRIBUTION_URL,
      });
    };
    const loadDetail = async (pose) => {
      const patch = terrainImageryPatch(pose),
        token = ++detailGeneration;
      detailController?.abort();
      detailController = new AbortController();
      const active = detailController,
        timeout = setTimeout(() => active.abort(), 25000);
      detailLoadingKey = patch.key;
      detailState.value = "loading";
      try {
        const image = await imageryPatchSurface(
          patch,
          active.signal,
          props.dataProvider,
        );
        if (disposed || token !== detailGeneration) return;
        renderer.detail(image);
        detailKey = patch.key;
        detailState.value = "ready";
        if (!pack) detailMetresPerPixel.value = patch.metresPerPixel;
        detailFailedUntil = 0;
      } catch {
        if (disposed || token !== detailGeneration) return;
        detailState.value = "unavailable";
        detailFailedUntil = performance.now() + 30000;
      } finally {
        clearTimeout(timeout);
        if (token === detailGeneration) detailLoadingKey = "";
      }
    };
    const loadImagery = async (tiles, token, currentController) => {
      imageryState.value = "loading";
      imageryCount.value = 0;
      const timeout = setTimeout(() => currentController.abort(), 25000);
      let next = 0,
        failed = 0;
      try {
        // Start around the aircraft before peripheral tiles become visible.
        await Promise.all(
          Array.from(
            {
              length: 3,
            },
            async () => {
              while (next < tiles.length) {
                const tile = tiles[next++];
                try {
                  const image = await imagerySurface(
                    tile,
                    currentController.signal,
                    props.dataProvider,
                  );
                  if (disposed || token !== generation) return;
                  renderer.texture(image);
                  imageryCount.value++;
                } catch {
                  if (disposed || token !== generation) return;
                  failed++;
                }
              }
            },
          ),
        );
        if (disposed || token !== generation) return;
        imageryState.value = failed
          ? imageryCount.value
            ? "partial"
            : "unavailable"
          : "ready";
      } finally {
        clearTimeout(timeout);
      }
    };
    const load = async (pose, key, center) => {
      loadingKey = key;
      const token = ++generation;
      controller?.abort();
      controller = new AbortController();
      const currentController = controller,
        timeout = setTimeout(() => currentController.abort(), 15000);
      status(
        origin ? "ready" : "loading",
        origin ? "Updating terrain region…" : "Loading elevation terrain…",
      );
      try {
        let candidate = null;
        try {
          candidate = await loadTerrainPack(
            pose,
            props.telemetry?.altitudeDatum || "UNKNOWN",
            currentController.signal,
            props.dataProvider,
          );
        } catch {
          /* Named Terrarium fallback remains available. */
        }
        if (disposed || token !== generation) return;
        if (candidate) {
          pack = candidate;
          renderer.replace(candidate.meshes);
          origin = candidate.origin;
          groundSampler = candidate.groundSampler;
          regionKey = key;
          loadingKey = "";
          failedUntil = 0;
          detailState.value = "native";
          detailMetresPerPixel.value = candidate.spacingM;
          imageryState.value = "disabled";
          imageryCount.value = 0;
          if (props.imageryEnabled) void loadDetail(pose);
          return;
        }
        pack = null;
        const requests = [];
        for (let row = -1; row <= 1; row++)
          for (let col = -1; col <= 1; col++)
            requests.push({
              x: (center.x + col + 2 ** TERRAIN_ZOOM) % 2 ** TERRAIN_ZOOM,
              y: center.y + row,
            });
        if (requests.some((t) => t.y < 0 || t.y >= 2 ** TERRAIN_ZOOM))
          throw new Error("Terrain coverage unavailable at this latitude");
        const tiles = [];
        let next = 0;
        await Promise.all(
          Array.from(
            {
              length: 3,
            },
            async () => {
              while (next < requests.length) {
                const tile = requests[next++];
                tiles.push(
                  await elevationTile(
                    tile.x,
                    tile.y,
                    TERRAIN_ZOOM,
                    currentController.signal,
                    props.dataProvider,
                  ),
                );
              }
            },
          ),
        );
        if (disposed || token !== generation) return;
        const newOrigin = tileCoordinate(
            center.x + 0.5,
            center.y + 0.5,
            TERRAIN_ZOOM,
          ),
          sampleHeight = terrainTileSampler(tiles),
          mesh = [];
        for (const tile of tiles) {
          // A region rebuild must not monopolize input/attitude updates for nine tiles.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (disposed || token !== generation) return;
          mesh.push(
            buildTerrainMesh({
              ...tile,
              origin: newOrigin,
              sampleHeight,
            }),
          );
        }
        detailGeneration++;
        detailController?.abort();
        detailKey = "";
        detailLoadingKey = "";
        detailFailedUntil = 0;
        detailState.value = "disabled";
        detailMetresPerPixel.value = null;
        renderer.replace(mesh);
        groundSampler = sampleHeight;
        origin = newOrigin;
        regionKey = key;
        loadingKey = "";
        failedUntil = 0;
        tiles.sort(
          (a, b) =>
            Math.abs(a.x - center.x) +
            Math.abs(a.y - center.y) -
            (Math.abs(b.x - center.x) + Math.abs(b.y - center.y)),
        );
        if (props.imageryEnabled) {
          void loadDetail(pose);
          void loadImagery(tiles, token, currentController);
        }
      } catch (error) {
        if (disposed || token !== generation) return;
        loadingKey = "";
        failedUntil = performance.now() + 30000;
        if (renderer?.isContextLost()) {
          graphicsUnavailable = true;
          status("unavailable", "Graphics unavailable · conventional horizon");
        } else
          status(
            "unavailable",
            navigator.onLine
              ? "Elevation unavailable · conventional horizon"
              : "Offline · elevation not cached",
          );
      } finally {
        clearTimeout(timeout);
      }
    };
    const animate = (time) => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      if (!props.enabled) {
        if (wasEnabled) {
          generation++;
          controller?.abort();
          loadingKey = "";
          detailGeneration++;
          detailController?.abort();
          detailLoadingKey = "";
          if (detailState.value === "loading") {
            detailKey = "";
            detailState.value = "disabled";
          }
          if (imageryState.value === "loading") {
            regionKey = "";
            origin = null;
          }
        }
        wasEnabled = false;
        failedUntil = 0;
        status("disabled", "Synthetic vision off");
        return;
      }
      wasEnabled = true;
      const pose = terrainPose(props.flight, props.telemetry);
      if (!pose) {
        status("unavailable", "Waiting for fresh GPS, altitude and attitude");
        return;
      }
      if (graphicsUnavailable) {
        status("unavailable", "Graphics unavailable · conventional horizon");
        return;
      }
      if (!renderer) {
        try {
          renderer = createRenderer(canvas.value);
        } catch {
          graphicsUnavailable = true;
          status("unavailable", "WebGL unavailable · conventional horizon");
          return;
        }
      }
      const tile = tilePosition(pose.lat, pose.lon, TERRAIN_ZOOM),
        center = {
          x: Math.floor(tile.x),
          y: Math.floor(tile.y),
        },
        key = `${props.dataProvider?.revision}/${center.x}/${center.y}/${Math.floor(pose.lat * 1000)}/${Math.floor(pose.lon * 1000)}/${props.telemetry?.altitudeDatum}`;
      if (regionKey !== key) {
        if (!loadingKey && time >= failedUntil) void load(pose, key, center);
        else if (loadingKey)
          status(
            origin ? "ready" : "loading",
            origin ? "Updating terrain region…" : "Loading elevation terrain…",
          );
        if (!origin) return;
      }
      if (
        pack &&
        pack.manifest.verticalDatum !== props.telemetry?.altitudeDatum
      ) {
        clearance.value = null;
        status(
          "unavailable",
          "Height reference changed · awaiting compatible terrain",
        );
        return;
      }
      if (
        !Number.isFinite(props.flight.vsi) ||
        !Number.isFinite(props.flight.groundspeed) ||
        !Number.isFinite(props.telemetry.trackDeg)
      )
        forecast = null;
      try {
        clearance.value = pack ? terrainClearance(pose, groundSampler) : null;
        if (time - lastForecast >= 500) {
          forecast = pack
            ? evaluateTerrainPath({
                lat: pose.lat,
                lon: pose.lon,
                altitudeM: pose.altitude,
                datum: props.telemetry?.altitudeDatum || "UNKNOWN",
                groundspeedMps: (props.flight.groundspeed * 1852) / 3600,
                trackDeg: props.telemetry.trackDeg,
                verticalSpeedMps: props.flight.vsi / 196.8503937,
                telemetryFresh:
                  props.flight.live &&
                  Number.isFinite(props.flight.groundspeed) &&
                  Number.isFinite(props.flight.vsi),
                transformVerified: pack.manifest.verticalTransform.verified,
                sample: pack.sampleBoth,
                lookaheadSeconds: Math.max(
                  1,
                  Math.min(120, props.lookaheadSeconds || 30),
                ),
                stepSeconds: 1,
                maxAlongTrackStepM: 10,
                corridorHalfWidthM: 20,
                lateralStepM: 10,
                maxSamples: 1500,
              })
            : null;
          lastForecast = time;
        }
        if (
          props.imageryEnabled &&
          detailKey !== terrainImageryPatch(pose).key &&
          !detailLoadingKey &&
          time >= detailFailedUntil
        )
          void loadDetail(pose);
        if (time - lastDraw >= 50) {
          renderer.draw(props.displayPose || pose, origin, props.viewport);
          lastDraw = time;
        }
        status(
          "ready",
          pack
            ? `Cove terrain · ${pack.spacingM} m nearby / ${pack.farSpacingM} m distant · mapped surface · ${pack.manifest.verticalDatum}`
            : "Terrarium elevation · assumed MSL · " +
                (detailState.value === "ready"
                  ? "nearby surface detail"
                  : {
                      ready: "surface imagery",
                      loading: "loading imagery",
                      partial: "partial imagery",
                      unavailable: "imagery unavailable",
                    }[imageryState.value] || "shaded terrain"),
        );
      } catch {
        graphicsUnavailable = true;
        status("unavailable", "Graphics unavailable · conventional horizon");
      }
    };
    const invalidateRegion = () => {
      generation++;
      controller?.abort();
      detailGeneration++;
      detailController?.abort();
      detailKey = "";
      detailLoadingKey = "";
      detailFailedUntil = 0;
      detailState.value = "disabled";
      detailMetresPerPixel.value = null;
      clearance.value = null;
      groundSampler = null;
      loadingKey = "";
      regionKey = "";
      origin = null;
      failedUntil = 0;
      imageryState.value = "disabled";
      imageryCount.value = 0;
    };
    let unsubscribeProvider = null;
    watch(
      () => props.dataProvider,
      (provider) => {
        unsubscribeProvider?.();
        const changed = () => {
          invalidateRegion();
          pack = null;
          forecast = null;
          status("loading", "Ground source changed");
        };
        unsubscribeProvider = provider?.subscribe(changed) || null;
        changed();
      },
      { immediate: true },
    );
    const lost = (event) => {
      event.preventDefault();
      invalidateRegion();
      graphicsUnavailable = true;
      status("unavailable", "Graphics unavailable · conventional horizon");
    };
    const restored = () => {
      invalidateRegion();
      renderer = null;
      graphicsUnavailable = false;
    };
    onMounted(() => {
      canvas.value.addEventListener("webglcontextlost", lost);
      canvas.value.addEventListener("webglcontextrestored", restored);
      frame = requestAnimationFrame(animate);
    });
    onBeforeUnmount(() => {
      disposed = true;
      unsubscribeProvider?.();
      generation++;
      controller?.abort();
      detailGeneration++;
      detailController?.abort();
      cancelAnimationFrame(frame);
      canvas.value?.removeEventListener("webglcontextlost", lost);
      canvas.value?.removeEventListener("webglcontextrestored", restored);
      renderer?.dispose();
    });
    return {
      canvas,
      visible,
      message,
      imageryState,
      imageryCount,
      detailState,
      detailMetresPerPixel,
      clearance,
      attribution: ATTRIBUTION,
      attributionUrl: ATTRIBUTION_URL,
      imageryAttribution: IMAGERY_ATTRIBUTION,
      imageryAttributionUrl: IMAGERY_ATTRIBUTION_URL,
    };
  },
};
</script>
