<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<section class="pfd-panel display" aria-label="Primary flight display">
    <header class="screen-title"><strong>PFD</strong><span>Primary flight display</span><button class="pfd-mode-button" @click="open('status')" aria-label="PFD mode and data status" :class="{unavailable:!flight.live}">{{flight.live?telemetry.mode:'NO DATA'}}</button></header>
    <TelemetryStrip v-if="options.stripPlacement==='pfd'" :telemetry="telemetry" :live="flight.live" @open="open('status')"/>
    <div class="pfd-screen" :class="{stale:!flight.live}">
    <div ref="canvas" class="pfd-instrument-canvas">
    <slot name="traffic" :pose="displayPose" :viewport="viewport"/>
    <slot name="background" :pose="displayPose" :viewport="viewport"/>
    <FlightModeAnnunciator :snapshot="modeSnapshot" :options="options" :director-label="options.fdVisible?(director?'FD CUES':'FD NO DATA'):'FD OFF'" @open="$emit('flight-controls',$event)" @director="open('director')"/>
    <svg :viewBox="viewport.viewBox" class="pfd-svg" role="img" aria-label="Artificial horizon, airspeed and altitude tapes, vertical speed and heading">
      <defs>
        <linearGradient id="pfd-sky" x2="0" y2="1"><stop stop-color="#075096"/><stop offset="1" stop-color="#388eda"/></linearGradient>
        <linearGradient id="pfd-earth" x2="0" y2="1"><stop stop-color="#a97839"/><stop offset="1" stop-color="#51351c"/></linearGradient>
        <clipPath id="pfd-attitude-clip"><rect :x="viewport.x" :y="viewport.y" :width="viewport.width" :height="viewport.height"/></clipPath>
        <clipPath id="pfd-pitch-clip"><rect x="205" y="108" width="230" height="230"/></clipPath>
        <linearGradient id="pfd-pitch-fade" x1="0" y1="108" x2="0" y2="338" gradientUnits="userSpaceOnUse"><stop stop-color="white" stop-opacity="0"/><stop offset=".15" stop-color="white"/><stop offset=".85" stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient>
        <mask id="pfd-pitch-mask"><rect x="205" y="108" width="230" height="230" fill="url(#pfd-pitch-fade)"/></mask>
        <clipPath id="pfd-speed-clip"><rect x="24" y="91" width="88" height="268"/></clipPath>
        <clipPath id="pfd-altitude-clip"><rect x="508" y="91" width="104" height="268"/></clipPath>
      </defs>
      <rect :x="viewport.x" :y="viewport.y" :width="viewport.width" :height="viewport.height" fill="#04090f" :fill-opacity="terrainReady?0:1"/>
      <g clip-path="url(#pfd-attitude-clip)" :opacity="flight.attitudeValid?1:.18">
        <g class="pfd-horizon" :transform="horizon" :opacity="terrainReady?0:1">
          <rect :x="320-sceneExtent" :y="225-sceneExtent" :width="sceneExtent*2" :height="sceneExtent" fill="url(#pfd-sky)"/>
          <rect :x="320-sceneExtent" y="225" :width="sceneExtent*2" :height="sceneExtent" fill="url(#pfd-earth)"/>
          <line :x1="320-sceneExtent" y1="225" :x2="320+sceneExtent" y2="225" stroke="white" stroke-width="3"/>
        </g>
        <g v-if="options.pitchLadder" clip-path="url(#pfd-pitch-clip)" mask="url(#pfd-pitch-mask)"><g :transform="horizon">
          <g v-for="mark in pitchMarks" :key="mark" :transform="'translate(320 '+(225-mark*5)+')'" class="pitch-mark">
            <path :d="'M'+(mark%10===0?-43:-22)+' 0 H'+(mark%10===0?43:22)"/>
            <path v-if="mark%10===0" :d="'M-43 0 v'+(mark>0?6:-6)+' M43 0 v'+(mark>0?6:-6)"/>
            <text v-if="mark%10===0" x="-56" y="5" text-anchor="end">{{Math.abs(mark)}}</text>
            <text v-if="mark%10===0" x="56" y="5">{{Math.abs(mark)}}</text>
          </g>
        </g></g>
      </g>
      <g v-if="director" class="pfd-flight-director" stroke="#ff70ed" stroke-width="5" fill="none" stroke-linejoin="round">
        <g v-if="options.fdStyle==='crossbar'"><path :d="'M'+(320+director.x)+' 180 V270 M267 '+(225+director.y)+' H373'"/></g>
        <path v-else d="M226 249 L320 221 L414 249 V257 L320 229 L226 257 Z" :transform="'translate(0 '+director.y+') rotate('+director.rotation+' 320 225)'" stroke-width="2" fill="#ff70ed"/>
      </g>
      <g class="pfd-bank-scale" stroke="white" stroke-width="2">
        <path d="M181.436 145 A160 160 0 0 1 458.564 145" fill="none"/>
        <line v-for="mark in bankMarks" :key="mark" x1="320" y1="65" x2="320" :y2="mark%30===0?44:53" :transform="'rotate('+mark+' 320 225)'"/>
        <path d="M312 36 L328 36 L320 48 Z" fill="white" stroke="none"/>
        <g v-if="options.standardRatePointers!==false&&turnCues.bankDeg!==null" class="pfd-standard-rate-bank" :aria-label="`Standard-rate bank ${turnCues.bankDeg.toFixed(1)} degrees, based on estimated true airspeed`">
          <path v-for="side in [-1,1]" :key="side" d="M320 64 L313 52 H327 Z" :transform="`rotate(${side*turnCues.bankDeg} 320 225)`" fill="#51ff68" stroke="#09280f" stroke-width="1.5"/>
          <text x="320" y="96" text-anchor="middle" fill="#51ff68" stroke="#09280f" stroke-width="2" paint-order="stroke" font-size="10">STD · EST TAS</text>
        </g>
        <path v-if="flight.attitudeValid" d="M320 65 L311 80 L329 80 Z" fill="white" stroke="#263744" :transform="'rotate('+(-displayFlight.roll)+' 320 225)'"/>
      </g>
      <g class="pfd-aircraft-reference" fill="#fff348" stroke="#26210a" stroke-width="2.5">
        <!-- Fixed aircraft wedges adapted from SDU460 ADI.svg (GPL-3.0-or-later). -->
        <g v-if="options.fdStyle==='vbar'" class="pfd-aircraft-vbar" transform="translate(320 225)" stroke-width="1.5">
          <path d="M-85 25 L0 0 L-65 25 Z M85 25 L0 0 L65 25 Z"/>
          <path d="M-65 25 L0 0 L-40 25 Z M65 25 L0 0 L40 25 Z" fill="#8b8520"/>
        </g>
        <g v-else><path d="M203 220 H276 V231 H268 V228 H203 Z M437 220 H364 V231 H372 V228 H437 Z"/><path d="M305 226 L320 218 L335 226 L320 223 Z"/></g>
      </g>
      <g class="pfd-tapes"><g :transform="'translate('+(-viewport.edgeShift)+' 0)'">
        <rect x="24" y="63" width="88" height="296" rx="5" class="pfd-tape-background" :fill-opacity="options.tapeOpacity"/>
        <path d="M29 63 H107 Q112 63 112 68 V91 H24 V68 Q24 63 29 63 Z" class="pfd-tape-cap"/>
        <text x="30" y="82" class="pfd-small">IAS</text><text x="105" y="82" text-anchor="end" class="pfd-unit">{{unitLabels[selectedUnits.speedUnit]}}</text>
        <g clip-path="url(#pfd-speed-clip)" class="pfd-scale-label">
          <line v-for="tick in speedMinorTicks" :key="tick.value" x1="105" x2="112" :y1="225+tick.offset" :y2="225+tick.offset"/>
          <g v-for="tick in speedTicks" :key="tick.value" :transform="'translate(0 '+(225+tick.offset)+')'"><line x1="94" x2="112" y1="0" y2="0"/><text x="85" y="8" text-anchor="end">{{tick.value}}</text></g>
        </g>
        <path d="M20 204 H73 V194 H99 V210 L114 225 L99 240 V256 H73 V246 H20 Z" class="pfd-readout-box"/>
        <text x="69" y="238" text-anchor="middle" class="pfd-speed-value">{{reading('airspeed',flight.airspeed)}}</text>
        <path v-if="refOffset('airspeed',3)!==null" class="pfd-reference-bug" :transform="'translate(0 '+(225+refOffset('airspeed',3))+')'" d="M112 0 L125 -7 V7 Z"/>
        <text x="26" y="382" class="pfd-unit">GS <tspan fill="white">{{reading('airspeed',flight.groundspeed)}} {{unitLabels[selectedUnits.speedUnit]}}</tspan></text>
        </g><g class="pfd-altimeter" :transform="'translate('+(viewport.edgeShift-26)+' 0)'">
        <rect x="508" y="63" width="104" height="296" rx="5" class="pfd-tape-background" :fill-opacity="options.tapeOpacity"/>
        <path d="M513 63 H607 Q612 63 612 68 V91 H508 V68 Q508 63 513 63 Z" class="pfd-tape-cap"/>
        <text x="514" y="82" class="pfd-small">MSL</text><text x="606" y="82" text-anchor="end" class="pfd-unit">{{unitLabels[selectedUnits.altitudeUnit]}}</text>
        <g clip-path="url(#pfd-altitude-clip)" class="pfd-scale-label">
          <line v-for="tick in altitudeMinorTicks" :key="tick.value" x1="508" x2="517" :y1="225+tick.offset" :y2="225+tick.offset"/>
          <g v-for="tick in altitudeTicks" :key="tick.value" :transform="'translate(0 '+(225+tick.offset)+')'"><line x1="508" x2="523" y1="0" y2="0"/><text x="606" y="7" text-anchor="end" font-size="20">{{tick.value.toLocaleString('en-US')}}</text></g>
        </g>
        <path d="M616 194 H583 V204 H523 L505 225 L523 246 H583 V256 H616 Z" class="pfd-readout-box"/>
        <text x="565" y="235" text-anchor="middle" class="pfd-altitude-value">{{fixed(shown('altitude',flight.altitude))}}</text>
        <path v-if="refOffset('altitude',altitudeScale)!==null" class="pfd-reference-bug" :transform="'translate(0 '+(225+refOffset('altitude',altitudeScale))+')'" d="M508 0 L495 -7 V7 Z"/>
        <text x="558" y="382" text-anchor="middle" class="pfd-unit pfd-agl-value" :aria-label="estimatedAgl===null?'AGL unavailable: fresh compatible terrain required':'Estimated height above terrain '+fixed(shown('altitude',estimatedAgl))+' '+unitLabels[selectedUnits.altitudeUnit]">{{estimatedAgl!==null?'EST AGL '+fixed(shown('altitude',estimatedAgl))+' '+unitLabels[selectedUnits.altitudeUnit]:'AGL —'}}</text>
        </g>
      </g>
      <!-- Scale and pointer adapted from Peter Heinrich's SDU460 PFD/VSI.svg,
           copyright 2024, GPL-3.0-or-later. See PROVENANCE.md. -->
      <g class="pfd-vsi" :transform="'translate('+(590+viewport.edgeShift)+' 225)'" :aria-label="flight.vsi===null?'Vertical speed unavailable':'Vertical speed '+reading('vsi',flight.vsi)+' '+unitLabels[selectedUnits.verticalSpeedUnit]">
        <path d="M0 -128 H38 Q44 -128 44 -122 V-23 Q44 -13 24 -7 L12 0 L24 7 Q44 13 44 23 V122 Q44 128 38 128 H0 Z" class="pfd-tape-background" :fill-opacity="options.tapeOpacity"/>
        <path d="M0 -121 V121 M0 0 L14 -7 M0 0 L14 7" class="pfd-vsi-scale-line"/>
        <g v-for="tick in vsiTicks" :key="tick.value" :transform="'translate(0 '+(-tick.offset)+')'">
          <line v-if="tick.value!==0" x1="0" :x2="tick.value%500===0?11:5" y1="0" y2="0" class="pfd-vsi-scale-line"/>
          <text v-if="tick.label" x="17" y="6" class="pfd-vsi-scale-label">{{tick.label}}</text>
        </g>
        <g v-if="vsiOffset!==null" class="pfd-vsi-pointer" :transform="'translate(0 '+(-vsiOffset)+')'">
          <path d="M3 0 L17 -8 V8 Z" fill="white" stroke="#090a0c" stroke-width="2"/>
          <path d="M7 -3 L1 0 L7 3" fill="none" stroke="#f477ee" stroke-width="2"/>
          <path v-if="Math.abs(flight.vsi)>2000" class="pfd-vsi-overrange" :d="flight.vsi>0?'M4 -10 L10 -16 L16 -10':'M4 10 L10 16 L16 10'" fill="none" stroke="white" stroke-width="2"/>
        </g>
        <path v-if="vsiReferenceOffset!==null" class="pfd-reference-bug pfd-vsi-reference" :transform="'translate(0 '+(-vsiReferenceOffset)+')'" d="M35 0 L44 -6 V6 Z"/>
        <text x="21" y="-141" text-anchor="middle" class="pfd-small">VS</text>
        <text x="21" y="145" text-anchor="middle" class="pfd-unit">{{selectedUnits.verticalSpeedUnit==='fpm'?'×1000':''}}</text><text x="21" y="158" text-anchor="middle" class="pfd-unit">{{selectedUnits.verticalSpeedUnit==='fpm'?'FPM':'m/s'}}</text>
      </g>
      <g v-if="!flight.attitudeValid" class="pfd-attitude-fail"><path d="M170 120 L470 320 M470 120 L170 320" stroke="#ff5353" stroke-width="5"/><rect x="219" y="270" width="202" height="33" fill="#210c0c"/><text x="320" y="293" text-anchor="middle" fill="#ffd28e">ATTITUDE UNAVAILABLE</text></g>
      <line :x1="viewport.x" y1="396" :x2="viewport.x+viewport.width" y2="396" stroke="#394b5d" stroke-opacity=".25"/>
      <g class="pfd-hsi" transform="translate(320 518)">
        <circle r="108" fill="#08131f" :fill-opacity="options.hsiOpacity" stroke="#d4dee4" stroke-width="3"/>
        <circle r="59" fill="none" stroke="#d4dee4" stroke-opacity=".7" stroke-width="1.5"/>
        <g class="pfd-compass-card" :transform="'rotate('+(-(displayFlight.heading??0))+')'" :opacity="flight.heading===null?.2:1">
          <g v-for="tick in compass" :key="tick.angle" :transform="'rotate('+tick.angle+')'" stroke="#e1eaf1" stroke-width="3"><line x1="0" x2="0" y1="-107" :y2="tick.angle%30===0?-89:tick.angle%10===0?-96:-101"/><text v-if="tick.label" x="0" y="-73" text-anchor="middle" stroke="none" fill="white" font-size="21" font-weight="700">{{tick.label}}</text></g>
        </g>
        <g v-if="radialValid" class="pfd-radial-pointer" :transform="'rotate('+(guidance.pathBearingDeg-displayFlight.heading)+')'" stroke="#f477ee" stroke-width="4" fill="none">
          <path d="M0 -94 V-62 M-8 -81 L0 -94 L8 -81 M0 63 V92"/>
          <circle v-for="y in [-48,-24,24,48]" cx="0" :cy="y" r="2.5" stroke="#edf5fa" stroke-width="1.5"/>
          <line class="pfd-radial-bar" x1="-26" x2="26" :y1="-cdiOffset" :y2="-cdiOffset" stroke-width="5"/>
        </g>
        <g v-if="references.heading!==null&&flight.heading!==null" :transform="'rotate('+(references.heading-displayFlight.heading)+')'" class="pfd-heading-bug"><path d="M-8 -110 L0 -99 L8 -110 V-117 H-8 Z" class="pfd-reference-bug"/></g>
        <g v-if="navValid" class="pfd-course-pointer" :transform="'rotate('+(guidance.desiredTrackDeg-displayFlight.heading)+')'" stroke="#f477ee" stroke-width="4.5" fill="none">
          <path d="M0 -92 V-28 M-8 -78 L0 -92 L8 -78 M0 28 V87"/><line class="pfd-cdi-bar" :x1="cdiOffset" :x2="cdiOffset" y1="-27" y2="27"/>
          <path d="M0 -41 L-5 -33 H5 Z" fill="#f477ee" stroke="none"/>
          <circle v-for="x in [-48,-24,24,48]" :cx="x" cy="0" r="2" stroke="#edf5fa" stroke-width="1"/>
        </g>
        <g v-if="bearingValid" class="pfd-bearing-pointer" :transform="'rotate('+(guidance.bearingDeg-displayFlight.heading)+')'" stroke="#63e5f0" stroke-width="3" fill="none"><path d="M0 -93 V-26 M-7 -81 L0 -93 L7 -81 M0 28 V88"/></g>
        <g v-if="homeNavigation&&Number.isFinite(homeNavigation.bearingDeg)&&flight.heading!==null" class="pfd-home-pointer" :transform="'rotate('+(homeNavigation.bearingDeg-displayFlight.heading)+')'" :data-bearing="homeNavigation.bearingDeg" aria-label="Bearing to reported home; not commanded guidance"><path d="M0 -98L-8 -117H8Z"/><text x="0" y="-107" text-anchor="middle">H</text></g>
        <path d="M0 -15 L4 -3 L19 6 V9 L3 4 L3 18 L8 22 V24 L0 21 L-8 24 V22 L-3 18 L-3 4 L-19 9 V6 L-4 -3 Z" fill="white" stroke="#08111c"/>
        <path d="M0 -109 L-7 -120 H7 Z" fill="white"/>
        <text v-if="radialValid" x="0" y="42" text-anchor="middle" class="pfd-radial-label">LOITER</text>
        <PfdTurnRate v-if="options.turnRate!==false" :state="turnCues"/>
      </g>
      <rect x="272" y="402" width="96" height="31" class="pfd-readout-box"/><text x="320" y="425" text-anchor="middle" class="pfd-heading-value">{{angle(flight.heading)}}</text>
      <g class="pfd-secondary">
        <rect x="17" y="420" width="168" height="85" rx="5" fill="black" :fill-opacity="options.tapeOpacity"/>
        <text x="25" y="443">VERTICAL SPEED</text><text x="25" y="474" class="pfd-vsi-value">{{flight.vsi===null?'—':(flight.vsi>0?'+':'')+reading('vsi',flight.vsi)}}<tspan font-size="12"> {{unitLabels[selectedUnits.verticalSpeedUnit]}}</tspan></text>
        <g v-if="options.secondary"><text x="25" y="530">PITCH / BANK</text><text x="25" y="556" class="pfd-secondary-value">{{flight.attitudeValid?fixed(flight.pitch)+'° / '+fixed(flight.roll)+'°':'—'}}</text></g>
        <text x="616" y="443" text-anchor="end">{{guidance.preview?'PREVIEW':guidance.targetName?'FLIGHT MODE':'MISSION'}} GPS</text><text x="616" y="474" text-anchor="end" class="pfd-fix-value">{{guidance.targetName||(guidance.target?'WP'+String(guidance.seq).padStart(3,'0'):'—')}}</text>
        <g v-if="options.secondary"><text x="616" y="530" text-anchor="end">{{bearingValid?'BEARING':guidance.trackTitle||'DESIRED TRACK'}}</text><text x="616" y="556" text-anchor="end" class="pfd-secondary-value">{{navValid?angle(guidance.desiredTrackDeg):radialValid?angle(guidance.pathBearingDeg):bearingValid?angle(guidance.bearingDeg):'—'}}</text></g>
        <text x="320" y="638" text-anchor="middle">{{homeNavigation?.distanceM!==null&&homeNavigation?.distanceM!==undefined?'HOME '+homeNavigation.label+' · '+(Number.isFinite(homeNavigation.bearingDeg)?angle(homeNavigation.bearingDeg)+' T':'AT HOME'):'HEADING · TRUE NORTH'}}</text>
      </g>
      <g class="pfd-reference-labels"><text v-if="references.airspeed!==null" :x="25-viewport.edgeShift" y="22">REF {{fixed(shown('airspeed',references.airspeed))}} {{unitLabels[selectedUnits.speedUnit]}}</text><text v-if="references.altitude!==null" :x="587+viewport.edgeShift" y="22" text-anchor="end">REF {{fixed(shown('altitude',references.altitude))}} {{unitLabels[selectedUnits.altitudeUnit]}}</text><text v-if="references.heading!==null" x="424" y="382" text-anchor="middle">HDG REF {{angle(references.heading)}}</text><text v-if="references.vsi!==null" x="25" y="495">REF {{fixed(shown('vsi',references.vsi))}} {{unitLabels[selectedUnits.verticalSpeedUnit]}}</text></g>
    </svg>
    <div v-if="reportedFlightState" class="pfd-reported-flight-state" aria-label="Reported aircraft flight state">{{reportedFlightState}}</div>
    <div class="pfd-touch-surfaces" role="group" aria-label="Touch flight instruments">
      <button class="pfd-hotspot pfd-touch-speed" :style="hit([6-viewport.edgeShift,35,124,355])" aria-label="Airspeed controls" @click="open('airspeed')"><span>IAS</span></button>
      <button class="pfd-hotspot pfd-touch-altitude" :style="hit([477+viewport.edgeShift,35,110,355])" aria-label="Set altitude reference" @click="open('altitude')"><span>ALT</span></button>
      <button class="pfd-hotspot pfd-touch-attitude" :style="hit([135,98,342,275])" aria-label="Attitude and display settings" @click="open('attitude')"><span>DISPLAY</span></button>
      <button class="pfd-hotspot pfd-touch-vsi" :style="hit([6,416,184,92])" aria-label="Set vertical speed reference" @click="open('vsi')"><span>VS</span></button>
      <button class="pfd-hotspot pfd-touch-vsi-scale" :style="hit([588+viewport.edgeShift,96,52,270])" aria-label="Vertical speed scale reference" @click="open('vsi')"><span>VS</span></button>
      <button class="pfd-hotspot pfd-touch-heading" :style="hit([204,398,232,240])" aria-label="Set heading reference" @click="open('heading')"><span>HEADING</span></button>
      <button class="pfd-hotspot pfd-touch-navigation" :style="hit([446,418,188,170])" aria-label="PFD mission navigation" @click="open('nav')"><span>NAVIGATION</span></button>
      <button class="pfd-hotspot pfd-touch-bank" :style="hit([6,514,185,77])" aria-label="Pitch and bank display settings" @click="open('attitude')"><span>ATTITUDE</span></button>
    </div>
    <PfdSkidBall v-if="options.skidBall!==false" :telemetry="telemetry" :style="{...hit([264,365,112,44]),transform:'translateY(-50%)'}" @open="open('slip')"/>
    <PfdWindDisplay v-if="options.windDisplay!=='off'" :telemetry="telemetry" :mode="options.windDisplay||'components'" :speed-unit="selectedUnits.speedUnit" :style="hit([130-viewport.edgeShift,302,128,86])" @open="open('wind')"/>
    <div v-if="!flight.live" class="pfd-loss" role="status">Flight instruments unavailable</div>
    </div>
    </div>
    <nav class="pfd-menu-strip" aria-label="PFD touch menu"><button @click="open('menu')">PFD Menu</button><button @click="open('nav')">Mission</button><button @click="open('director')">FD</button><button @click="open('attitude')">Display</button></nav>
    <footer class="display-foot"><span>Touch an instrument · cyan = local reference</span><span>{{backgroundLabel||'Conventional horizon'}}</span></footer>
    <PfdControlPanel v-if="panel" :key="panel" :kind="panel" :flight="flight" :guidance="guidance" :telemetry="telemetry" :references="references" :options="options" :mission="mission" :terrain-status="terrainStatus" @close="panel=null" @panel="open" @reference="(key,value)=>$emit('reference',key,value)" @option="(key,value)=>$emit('option',key,value)" @navigate="$emit('navigate',$event)"/>
  </section>
</template>
<script>
import {units,unitLabels,flightValue,toDisplay} from './flight-units.mjs';
import { frameCadence } from "./frame-cadence.mjs";
// SVG primary flight display, authored for the Yonder community navigation host.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  computed,
  ref,
  shallowRef,
  watch,
  onMounted,
  onBeforeUnmount
} from 'vue';
import {
  attitudeTransform,
  tapeTicks,
  verticalSpeedOffset
} from './pfd-state.mjs';
import {
  flightDirectorCue
} from './pfd-controls.mjs';
import PfdControlPanel from './PfdControlPanel.vue';
import TelemetryStrip from './TelemetryStrip.vue';
import FlightModeAnnunciator from './FlightModeAnnunciator.vue';
import PfdWindDisplay from './PfdWindDisplay.vue';
import PfdSkidBall from './PfdSkidBall.vue';
import PfdTurnRate from './PfdTurnRate.vue';
import {turnCueState} from './turn-cues.mjs';
import {pfdViewport,pfdHitRegion} from './flight-workflow.mjs';

import {
  cdiDeflection
} from './navigation-view.mjs';
import {
  terrainPose
} from './terrain-state.mjs';
import {
  PosePresentation
} from './presentation-pose.mjs';
export default {
  components: {
    PfdControlPanel,
    TelemetryStrip,
    FlightModeAnnunciator,
    PfdWindDisplay,
    PfdSkidBall,
    PfdTurnRate
  },
  props: ['flight', 'guidance', 'telemetry', 'cdiScale', 'references', 'options', 'mission', 'trafficTracks', 'homeNavigation', 'reportedFlightState',
    'trafficOptions', 'trafficSelected', 'trafficNow', 'backgroundReady', 'backgroundLabel', 'terrainReport', 'snapshot'
  ],
  emits: ['reference', 'option', 'navigate', 'traffic-select', 'flight-controls'],
  setup(props, {
    expose
  }) {
    const canvas = ref(null), viewport = ref(pfdViewport(640,650));
    let resizeObserver;
    const sceneExtent = computed(()=>Math.hypot(viewport.value.width,viewport.value.height)+1000);
    const hit = box => pfdHitRegion(viewport.value,box);
    const modeSnapshot = computed(()=>props.snapshot||{connected:props.flight.live,telemetry:props.telemetry});
    onMounted(()=>{
      const measure=()=>{const bounds=canvas.value?.getBoundingClientRect();if(bounds?.width&&bounds?.height)viewport.value=pfdViewport(bounds.width,bounds.height)};
      measure();
      if(typeof ResizeObserver!=='undefined'){resizeObserver=new ResizeObserver(measure);resizeObserver.observe(canvas.value)}
    });
    onBeforeUnmount(()=>resizeObserver?.disconnect());
    const panel = ref(null),
      terrainStatus = computed(() => props.terrainReport || {
        state: 'unavailable',
        message: 'Terrain unavailable'
      });
    const displayPose = shallowRef(null),
      presentation = new PosePresentation(null);
    let animation = 0;
    const updatePresentation = () => {
      const next = presentation.at(performance.now()),
        previous = displayPose.value;
      if (next === null || previous === null || Object.keys(next).some(key => next[key] !== previous[key]))
        displayPose.value = next;
    };
    watch([() => props.snapshot?.identity?.generation, () => props.telemetry.altitudeDatum], () => presentation.reset());
    watch([() => props.telemetry, () => props.flight.live, () => props.flight.attitudeValid], () => {
      const pose = terrainPose(props.flight, props.telemetry);
      presentation.push(pose ? {
        ...pose,
        navPitch: props.flight.navPitch,
        navRoll: props.flight.navRoll
      } : null, performance.now(), props.snapshot?.at);
      updatePresentation();
    }, {
      immediate: true
    });
    onMounted(() => {
      const due = frameCadence();
      const animate = time => {
        if (due(time)) updatePresentation();
        animation = requestAnimationFrame(animate);
      };
      animation = requestAnimationFrame(animate);
    });
    onBeforeUnmount(() => cancelAnimationFrame(animation));
    const displayFlight = computed(() => displayPose.value && props.flight.live ? {
      ...props.flight,
      roll: displayPose.value.roll,
      pitch: displayPose.value.pitch,
      heading: displayPose.value.heading,
      navPitch: displayPose.value.navPitch,
      navRoll: displayPose.value.navRoll
    } : props.flight);
    const displayTelemetry = computed(() => displayPose.value && props.flight.live ? {
      ...props.telemetry,
      latitude: displayPose.value.lat,
      longitude: displayPose.value.lon,
      gpsAltitudeM: displayPose.value.altitude
    } : props.telemetry);
    const selectedUnits=computed(()=>units(props.options));
    const shown=(key,value)=>flightValue(key,value,props.options);
    const reading=(key,value)=>{const v=shown(key,value);return Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:({vsi:selectedUnits.value.verticalSpeedUnit,airspeed:selectedUnits.value.speedUnit}[key])==='mps'?1:0}):'—'};
    const altitudeScale=computed(()=>selectedUnits.value.altitudeUnit==='ft'?.35:1.2);
    const terrainReady = computed(() => props.backgroundReady === true);
    const director = computed(() => props.options.fdVisible ? flightDirectorCue(displayFlight.value) : null);
    const refOffset = (key, scale) => Number.isFinite(props.references[key]) && Number.isFinite(props.flight[key]) ?
      Math.max(-126, Math.min(126, (shown(key,props.flight[key]) - shown(key,props.references[key])) * scale)) : null;
    const open = kind => panel.value = kind;
    expose({
      open
    });
    const speedTicks = computed(() => tapeTicks(shown('airspeed',props.flight.airspeed), 10, 3).filter(x => x.value >= 0));
    const altitudeTicks = computed(() => tapeTicks(shown('altitude',props.flight.altitude), selectedUnits.value.altitudeUnit==='ft'?100:20, altitudeScale.value));
    const speedMinorTicks = computed(() => tapeTicks(shown('airspeed',props.flight.airspeed), 2, 3).filter(x => x.value >= 0 && x.value %
      10 !== 0));
    const altitudeMinorTicks = computed(() => tapeTicks(shown('altitude',props.flight.altitude), selectedUnits.value.altitudeUnit==='ft'?20:5, altitudeScale.value).filter(x => x.value % (selectedUnits.value.altitudeUnit==='ft'?100:20) !==
      0));
    const vsiTicks = computed(()=>[-2000, -1500, ...Array.from({
      length: 21
    }, (_, i) => (i - 10) * 100), 1500, 2000].map(value => ({
      value,
      offset: verticalSpeedOffset(value),
      label: [500,1000,2000].includes(Math.abs(value)) ? (selectedUnits.value.verticalSpeedUnit==='fpm'?(Math.abs(value)===500?'.5':String(Math.abs(value)/1000)):shown('vsi',Math.abs(value)).toFixed(1)) : ''
    })));
    const vsiOffset = computed(() => verticalSpeedOffset(props.flight.vsi));
    const vsiReferenceOffset = computed(() => verticalSpeedOffset(props.references.vsi));
    const horizon = computed(() => attitudeTransform(displayFlight.value));
    const pitchMarks = Array.from({
      length: 21
    }, (_, i) => (i - 10) * 5).filter(x => x !== 0);
    const compass = Array.from({
      length: 72
    }, (_, i) => ({
      angle: i * 5,
      label: ({
        0: 'N',
        90: 'E',
        180: 'S',
        270: 'W'
      } [i * 5] ?? (i % 6 === 0 ? String(i * 5 / 10) : ''))
    }));
    const bankMarks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
    const fixed = value => Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
    const angle = value => Number.isFinite(value) ? String(Math.round(value) % 360).padStart(3, '0') + '°' : '—';
    const navValid = computed(() => cdiDeflection(props.guidance, props.cdiScale) !== null && Number.isFinite(props
      .guidance.desiredTrackDeg) && props.flight.heading !== null);
    const radialValid = computed(() => props.guidance.valid && props.guidance.radialValid && Number.isFinite(props
      .guidance.pathBearingDeg) && props.flight.heading !== null);
    const cdiOffset = computed(() => (cdiDeflection(props.guidance, props.cdiScale) ?? 0) * 48);
    const bearingValid = computed(() => !navValid.value && !radialValid.value && props.guidance.valid && Number
      .isFinite(props.guidance.bearingDeg) && props.flight.heading !== null);
    const estimatedAgl = computed(() => terrainReady.value && props.flight.live && Number.isFinite(terrainStatus.value
      .estimatedAglM) ? terrainStatus.value.estimatedAglM / .3048 : null);
    return {
      selectedUnits,unitLabels,shown,altitudeScale,reading,
      canvas,
      viewport,
      sceneExtent,
      hit,
      modeSnapshot,
      displayPose,
      displayFlight,
      displayTelemetry,
      speedTicks,
      altitudeTicks,
      speedMinorTicks,
      altitudeMinorTicks,
      vsiTicks,
      vsiOffset,
      vsiReferenceOffset,
      horizon,
      pitchMarks,
      compass,
      bankMarks,
      fixed,
      angle,
      navValid,
      radialValid,
      cdiOffset,
      bearingValid,
      estimatedAgl,
      panel,
      open,
      terrainStatus,
      terrainReady,
      director,
      turnCues: computed(()=>turnCueState(props.telemetry)),
      refOffset
    };
  }
}
</script>
