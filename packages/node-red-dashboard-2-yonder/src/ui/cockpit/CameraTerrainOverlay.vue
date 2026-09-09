<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <canvas
    ref="canvas"
    class="camera-terrain-overlay"
    :data-registration-ready="status.ready"
    style="
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    "
    aria-hidden="true"
  />
</template>
<script>
import {
  validateTerrainManifest,
  decodeTerrainTile,
  selectTerrainTiles,
  latLonToUtm,
} from "yonder-core/terrain";
import { registeredPolygons } from "./terrain-adapter.mjs";
export default {
  props: {
    camera: Object,
    telemetry: Object,
    now: Number,
    enabled: Boolean,
    dataProvider: Object,
  },
  emits: ["status"],
  data: () => ({
    manifest: null,
    tiles: [],
    controller: null,
    timer: null,
    busy: false,
    key: "",
    unsubscribeProvider: null,
    status: {
      ready: false,
      reason: "Capture-time mapping unavailable",
    },
  }),
  mounted() {
    const reset = () => {
      this.controller?.abort();
      this.manifest = null;
      this.tiles = [];
      this.key = "";
      this.draw();
    };
    this.unsubscribeProvider = this.dataProvider?.subscribe(reset);
    this.timer = setInterval(() => this.draw(), 200);
    this.draw();
  },
  beforeUnmount() {
    clearInterval(this.timer);
    this.unsubscribeProvider?.();
    this.controller?.abort();
  },
  methods: {
    async load() {
      if (
        this.busy ||
        !this.enabled ||
        !this.camera?.framePose ||
        !this.camera?.calibration ||
        this.camera.frameCaptureMs == null
      )
        return;
      this.busy = true;
      this.controller = new AbortController();
      const timeout = setTimeout(() => this.controller?.abort(), 10000);
      try {
        if (!this.manifest) {
          const manifest = await this.dataProvider?.terrainManifest({
            signal: this.controller.signal,
          });
          if (!manifest) throw new Error("Import a ground terrain pack");
          this.manifest = validateTerrainManifest(manifest);
        }
        const pose = this.camera.framePose,
          point = latLonToUtm(
            pose.lat,
            pose.lon,
            this.manifest.horizontalCrs.zone,
          ),
          descriptors = selectTerrainTiles(
            {
              ...this.manifest,
              tiles: this.manifest.tiles.filter((tile) => tile.level === 0),
            },
            point.eastingM,
            point.northingM,
            200,
            9,
          ),
          key = descriptors.map((d) => d.id).join("|");
        if (key !== this.key) {
          const tiles = [];
          for (const descriptor of descriptors) {
            const bytes = await this.dataProvider.terrainTile(descriptor, {
              signal: this.controller.signal,
            });
            tiles.push(decodeTerrainTile(bytes, descriptor));
          }
          this.tiles = tiles;
          this.key = key;
        }
      } catch {
        this.tiles = [];
        this.manifest = null;
      } finally {
        clearTimeout(timeout);
        this.busy = false;
      }
    },
    draw() {
      const canvas = this.$refs.canvas;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect(),
        frame =
          canvas.parentElement
            .querySelector(".y-pic__frame")
            ?.getBoundingClientRect() || rect;
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!this.enabled) {
        this.status = {
          ready: false,
          reason: "Terrain data disabled",
        };
        this.$emit("status", this.status);
        return;
      }
      void this.load();
      const video = canvas.parentElement.querySelector("video");
      if (!video || video.readyState < 2) {
        this.status = {
          ready: false,
          reason: "Live decoded video frame unavailable",
        };
        this.$emit("status", this.status);
        return;
      }
      const result = registeredPolygons({
        camera: this.camera,
        manifest: this.manifest,
        tiles: this.tiles,
        telemetry: this.telemetry,
        now: this.now,
        viewport: {
          x: frame.left - rect.left,
          y: frame.top - rect.top,
          width: frame.width,
          height: frame.height,
        },
      });
      this.status = {
        ready: result.ready,
        reason: result.reason,
      };
      this.$emit("status", this.status);
      if (!result.ready) return;
      context.globalAlpha = 0.32;
      for (const polygon of result.polygons) {
        context.beginPath();
        polygon.points.forEach((p, i) =>
          i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
        );
        context.closePath();
        context.fillStyle = polygon.color;
        context.fill();
      }
    },
  },
};
</script>
