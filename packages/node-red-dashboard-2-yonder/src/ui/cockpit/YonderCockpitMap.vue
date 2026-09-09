<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <div class="cockpit-map" aria-label="Mission and traffic map">
    <div ref="canvas" class="cockpit-map-canvas"></div>
    <div class="cockpit-map-tools">
      <button @click="zoom(1)" aria-label="Zoom map in">+</button
      ><button @click="zoom(-1)" aria-label="Zoom map out">−</button
      ><button @click="fitTrafficRange" :disabled="!aircraftPosition" aria-label="Fit traffic range">Fit {{range}} NM</button
      ><button
        @click="
          follow = !follow;
          render();
        "
        :aria-pressed="follow"
      >
        Follow</button
      ><select v-model="basemap" @change="layers" aria-label="Map layers">
        <option value="grid">Grid</option>
        <option value="hybrid" :disabled="!online">Hybrid</option>
        <option value="satellite" :disabled="!online">Satellite</option>
      </select>
    </div>
    <div class="cockpit-map-status" role="status" :title="status">
      {{ positionMessage || status
      }}<span v-if="aircraftPosition && prediction?.points.length"> · {{ prediction.label }}</span>
    </div>
    <div v-if="picking" class="cockpit-map-pick">
      Tap a location to choose the target
    </div>
  </div>
</template>
<script>
import { markRaw } from "vue";
let L = null;
import "leaflet/dist/leaflet.css";
import { createProviderTileLayer } from "./ground/leaflet-provider.mjs";
import { isPositionItem } from "./mission-import.mjs";
import { fmt, validPosition, distance, aircraftMapPosition, aircraftPositionMessage } from "./cockpit-state.mjs";
export default {
  name: "YonderCockpitMap",
  props: {
    snapshot: Object,
    mission: Object,
    prediction: Object,
    picking: Boolean,
    online: Boolean,
    dataProvider: Object,
    ownTrail: Object,
    traffic: {
      default: () => ({
        tracks: [],
      }),
    },
    range: {
      default: 10,
    },
    trailSeconds: {
      default: 120,
    },
    now: Number,
  },
  emits: ["select", "location", "traffic-select", "home-select"],
  computed: {
    aircraftPosition() { return aircraftMapPosition(this.snapshot?.telemetry); },
    positionMessage() { return aircraftPositionMessage(this.snapshot?.telemetry); },
  },
  data: () => ({
    map: null,
    route: null,
    tracks: null,
    ownTrailLine: null,
    ownTrailHalo: null,
    base: null,
    basemap: "grid",
    follow: true,
    centered: false,
    overviewCentered: false,
    status: "Local grid · data sources off",
    observer: null,
    hold: null,
    handlers: null,
    unsubscribeProvider: null,
  }),
  async mounted() {
    this.basemap = this.online ? 'hybrid' : 'grid';
    L = (await import("leaflet")).default;
    if (!this.$refs.canvas) return;
    this.map = markRaw(
      L.map(this.$refs.canvas, {
        zoomControl: false,
        attributionControl: true,
        tapHold: false,
        fadeAnimation: false,
        zoomAnimation: false,
        markerZoomAnimation: false,
      }).setView([0, 0], 2),
    );
    const trailPane=this.map.createPane('own-aircraft-trail');
    trailPane.style.zIndex='450';trailPane.style.pointerEvents='none';
    this.ownTrailHalo=markRaw(L.polyline([],{
      color:'#07131b',weight:6,opacity:.95,dashArray:'1 8',lineCap:'round',
      interactive:false,pane:'own-aircraft-trail',
    }).addTo(this.map));
    this.ownTrailLine=markRaw(L.polyline([],{
      color:'#ffd16b',weight:3,opacity:1,dashArray:'1 8',lineCap:'round',
      interactive:false,pane:'own-aircraft-trail',className:'cockpit-own-trail',
    }).addTo(this.map));
    this.renderOwnTrail();
    this.route = markRaw(L.layerGroup().addTo(this.map));
    this.tracks = markRaw(L.layerGroup().addTo(this.map));
    this.map.on("dragstart", () => {
      this.follow = false;
    });
    this.map.on("click", (e) => {
      if (this.picking)
        this.$emit("location", {
          lat: e.latlng.lat,
          lon: e.latlng.lng,
        });
    });
    this.map.on("contextmenu", (e) => {
      L.DomEvent.preventDefault(e.originalEvent);
      this.$emit("location", {
        lat: e.latlng.lat,
        lon: e.latlng.lng,
      });
    });
    let start = null;
    const cancel = () => {
      clearTimeout(this.hold);
      this.hold = null;
      start = null;
    };
    this.handlers = {
      pointerdown: (e) => {
        if (
          e.pointerType !== "touch" ||
          e.target.closest(".leaflet-interactive,.leaflet-control")
        )
          return;
        cancel();
        start = {
          x: e.clientX,
          y: e.clientY,
        };
        this.hold = setTimeout(() => {
          const p = this.map.mouseEventToLatLng(e);
          this.$emit("location", {
            lat: p.lat,
            lon: p.lng,
          });
          cancel();
        }, 650);
      },
      pointermove: (e) => {
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10)
          cancel();
      },
      pointerup: cancel,
      pointercancel: cancel,
    };
    for (const [name, fn] of Object.entries(this.handlers))
      this.$refs.canvas.addEventListener(name, fn);
    this.observer = new ResizeObserver(() => this.map?.invalidateSize());
    this.observer.observe(this.$refs.canvas);
    this.unsubscribeProvider = this.dataProvider?.subscribe(() =>
      this.layers(),
    );
    this.layers();
    this.render();
  },
  beforeUnmount() {
    clearTimeout(this.hold);
    this.observer?.disconnect();
    this.unsubscribeProvider?.();
    for (const [name, fn] of Object.entries(this.handlers || {}))
      this.$refs.canvas?.removeEventListener(name, fn);
    this.map?.remove();
    this.map = null;
  },
  watch: {
    ownTrail(value,previous){if(value?.key!==previous?.key)this.renderOwnTrail();},
    snapshot: {
      handler() {
        this.render();
      },
      deep: true,
    },
    mission: {
      handler() {
        this.render();
      },
      deep: true,
    },
    traffic: {
      handler() {
        this.render();
      },
      deep: true,
    },
    range() {
      this.render();
    },
    trailSeconds() {
      this.render();
    },
    now() {
      this.render();
    },
    online(value) {
      if (!value) this.basemap = "grid";
      else if (this.basemap === "grid") this.basemap = "hybrid";
      this.layers();
    },
  },
  methods: {
    fitTrafficRange(){
      const here=this.aircraftPosition;
      if(!this.map||!here)return;
      this.follow=true;this.centered=true;
      this.map.fitBounds(L.latLng(here.lat,here.lon).toBounds(this.range*1852*2),{animate:false,padding:[20,20]});
    },
    renderOwnTrail(){const segments=this.ownTrail?.segments||[];this.ownTrailHalo?.setLatLngs(segments);this.ownTrailLine?.setLatLngs(segments);},
    zoom(d) {
      this.map?.setZoom(this.map.getZoom() + d);
    },
    layers() {
      if (!this.map) return;
      this.base?.remove();
      const group = L.layerGroup();
      if (this.basemap === "grid" || !this.online) {
        const grid = L.gridLayer({
          attribution: "Local grid",
        });
        grid.createTile = () => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 256;
          const c = canvas.getContext("2d");
          c.fillStyle = "#102529";
          c.fillRect(0, 0, 256, 256);
          c.strokeStyle = "#274447";
          for (let n = 0; n <= 256; n += 64) {
            c.beginPath();
            c.moveTo(n, 0);
            c.lineTo(n, 256);
            c.moveTo(0, n);
            c.lineTo(256, n);
            c.stroke();
          }
          return canvas;
        };
        group.addLayer(grid);
        this.status = "Local grid · imagery off";
      } else {
        for (const kind of this.basemap === "hybrid"
          ? ["imagery", "places", "roads"]
          : ["imagery"]) {
          const layer = createProviderTileLayer(
            L,
            this.dataProvider,
            kind,
            () => {
              this.status = `${this.dataProvider?.options.mode || "Ground"} map data unavailable · mission geometry retained`;
            },
          );
          group.addLayer(layer);
        }
        this.status = `${this.dataProvider?.options.mode || "Ground"} · ${this.basemap === "hybrid" ? "Hybrid imagery + roads + labels" : "Satellite imagery"}`;
      }
      this.base = markRaw(group.addTo(this.map));
      this.render();
    },
    render() {
      if (!this.map) return;
      this.route.clearLayers();
      this.tracks.clearLayers();
      const t = this.snapshot?.telemetry || {},
        here = this.aircraftPosition,
        points = (this.mission?.items || []).filter(isPositionItem);
      const home=this.mission?.home;
      if(validPosition(home)){
        const marker=L.marker([home.lat,home.lon],{title:'Edit home on map',icon:L.divIcon({className:'cockpit-home-marker',html:'<span>H</span>',iconSize:[44,44],iconAnchor:[22,22]})}).addTo(this.route);
        marker.bindTooltip('HOME',{permanent:true,direction:'left'});
        marker.on('click',()=>this.$emit('home-select'));
      }
      if (points.length)
        L.polyline(
          points.map((p) => [p.lat, p.lon]),
          {
            color: "#ed62e4",
            weight: 2,
          },
        ).addTo(this.route);
      for (const p of points) {
        const marker = L.circleMarker([p.lat, p.lon], {
          radius: 6,
          color:
            p.seq === this.snapshot?.mission?.currentSeq
              ? "#ed62e4"
              : "#e4eaf0",
          fillOpacity: 0.75,
        }).addTo(this.route);
        const label = document.createElement("span");
        label.textContent = `${p.seq}`;
        marker.bindTooltip(label, {
          permanent: true,
          direction: "top",
        });
        marker.on("click", () => this.$emit("select", p.seq));
      }
      if (here) {
        const svg = `<svg viewBox="0 0 40 44" style="transform:rotate(${Number.isFinite(t.headingDeg) ? t.headingDeg : 0}deg)"><path fill="white" stroke="#152a38" d="M20 2L24 17L37 25V29L24 25L23 35L29 39V42L20 39L11 42V39L17 35L16 25L3 29V25L16 17Z"/></svg>`;
        L.marker([here.lat, here.lon], {
          icon: L.divIcon({
            className: "cockpit-aircraft",
            html: svg,
            iconSize: [32, 36],
          }),
        }).addTo(this.route);
        if (this.follow) {
          this.map.setView(
            [here.lat, here.lon],
            this.centered ? this.map.getZoom() : 14,
            {
              animate: false,
            },
          );
          this.centered=true;
        }
      }
      const overview=[...points,...(validPosition(home)?[home]:[])];
      if (!here && !this.centered && !this.overviewCentered && overview.length) {
        this.map.fitBounds(overview.map(p => [p.lat, p.lon]), {animate:false, padding:[20,20], maxZoom:14});
        this.overviewCentered = true;
        // This is a mission overview; acquiring a fix still centers ownship.
      }
      if (here && this.prediction?.points.length)
        L.polyline(
          this.prediction.points.map((p) => [p.lat, p.lon]),
          {
            color: "#72e4f2",
            weight: 2,
            dashArray: "5 7",
          },
        ).addTo(this.route);
      for (const track of this.traffic?.tracks || []) {
        if (
          !validPosition(track) ||
          !validPosition(here) ||
          !Number.isFinite(track.observedAtMs) ||
          this.now - track.observedAtMs > 60000 ||
          this.now - track.observedAtMs < -5000 ||
          distance(here, track) > this.range * 1852
        )
          continue;
        const stale = this.now - track.observedAtMs > 15000;
        const m = L.circleMarker([track.lat, track.lon], {
          radius: 5,
          color: stale ? "#d2a66e" : "#62e1ed",
          weight: 2,
          fillOpacity: 0.35,
        }).addTo(this.tracks);
        const label = document.createElement("span");
        label.textContent = track.callSign || track.registration || track.id;
        m.bindTooltip(label);
        m.on("click", () => this.$emit("traffic-select", track));
        let trail = [];
        const flush = () => {
          if (trail.length > 1)
            L.polyline(trail, {
              color: "#65adbb",
              weight: 1,
            }).addTo(this.tracks);
          trail = [];
        };
        let previous = null;
        for (const p of track.history || []) {
          if (
            !validPosition(p) ||
            !Number.isFinite(p.observedAtMs) ||
            this.now - p.observedAtMs > this.trailSeconds * 1000 ||
            distance(here, p) > this.range * 1852
          ) {
            flush();
            previous = null;
            continue;
          }
          if (
            previous &&
            (p.breakBefore ||
              p.observedAtMs - previous.observedAtMs > 30000 ||
              p.observedAtMs <= previous.observedAtMs)
          )
            flush();
          trail.push([p.lat, p.lon]);
          previous = p;
        }
        flush();
      }
    },
  },
};
</script>
<style>
.cockpit-home-marker { display:grid;place-items:center; }
.cockpit-home-marker span { display:grid;place-items:center;width:24px;height:24px;border:2px solid #74d7ed;border-radius:3px;background:#112d3d;color:white;font:bold 16px sans-serif;box-shadow:0 1px 5px #000; }
</style>
