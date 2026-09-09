<template>
<svg v-if="options.enabled&&options.pfd" viewBox="0 0 640 650" class="pfd-traffic-overlay" role="group" aria-label="Traffic in synthetic vision">
  <defs><clipPath id="pfd-traffic-area"><rect x="128" y="84" width="366" height="276"/></clipPath></defs>
  <g clip-path="url(#pfd-traffic-area)"><polyline v-for="(path,index) in paths" :key="path.id+'-'+index" :points="path.points" class="pfd-traffic-breadcrumb" :class="{selected:path.id===selectedId}"/></g>
  <g v-for="(item,index) in targets" :key="item.track.id" :transform="'translate('+item.point.x+' '+item.point.y+')'" class="pfd-traffic-target" :class="{selected:item.track.id===selectedId}" :data-traffic-id="item.track.id" role="button" tabindex="0" :aria-label="'Traffic '+label(item)" @click.stop="$emit('select',item.track.id)" @keydown.enter.prevent="$emit('select',item.track.id)" @keydown.space.prevent="$emit('select',item.track.id)">
   <rect x="-16" y="-16" width="32" height="32" fill="transparent"/>
   <path d="M0 -8 L8 0 L0 8 L-8 0 Z"/>
   <text v-if="item.labelBox" :x="item.labelBox.left-item.point.x" :y="item.labelBox.top+13-item.point.y" class="traffic-call-sign">{{label(item)}}</text>
  </g>
 </svg>
</template>
<script>
// Perspective traffic symbols and real observed breadcrumbs over the PFD.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  computed
} from 'vue';
import {
  trafficOwnship,
  visibleTracks,
  projectTrafficPoint,
  trailSegments,
  trafficName,
  trafficLabel,
  layoutTrafficLabels
} from './traffic-state.mjs';
export default {
  props: ['flight', 'telemetry', 'tracks', 'options', 'selectedId', 'now', 'displayPose'],
  emits: ['select'],
  setup(props) {
    const own = computed(() => {
      const base = trafficOwnship(props.flight, props.telemetry),
        pose = props.displayPose;
      return base && pose ? {
        ...base,
        lat: pose.lat,
        lon: pose.lon,
        altitudeMslM: pose.altitude,
        heading: pose.heading,
        pitch: pose.pitch,
        roll: pose.roll
      } : base
    });
    const targets = computed(() => {
      if (!props.options.enabled || !props.options.pfd || !own.value) return [];
      const items = visibleTracks(props.tracks, props.options, props.now, own.value).filter(t => !t.stale && !t
        .ground).map(t => ({
        track: t,
        point: projectTrafficPoint(t, own.value)
      })).filter(({
        point: p
      }) => p && p.x >= 138 && p.x <= 484 && p.y >= 94 && p.y <= 350).slice(0, 40);
      return layoutTrafficLabels(items, props.options.labels, props.selectedId);
    });
    const paths = computed(() => {
      if (!props.options.trails || !own.value) return [];
      const output = [];
      for (const {
          track
        }
        of targets.value)
        for (const segment of trailSegments(track.history, props.now, props.options.trailSeconds, own.value, props
            .options.radiusNm)) {
          let points = [];
          const finish = () => {
            if (points.length >= 2) output.push({
              id: track.id,
              points: points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
            });
            points = [];
          };
          for (const p of segment) {
            const point = projectTrafficPoint(p, own.value);
            if (!point) finish();
            else points.push(point);
          }
          finish();
        }
      return output;
    });
    return {
      targets,
      paths,
      label: trafficLabel,
      trafficName
    };
  }
}
</script>