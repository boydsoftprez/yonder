<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<main
  class="y-cockpit"
  :data-layout="layout"
  :data-palette="palette"
  :data-background="background"
  :data-embedded="props.embedded||undefined"
  @keydown.esc="cancelPanel"
>
  <header class="cockpit-header"><a
      href="/dashboard/status"
      class="cockpit-brand"
      aria-label="Open systems settings"
    >YONDER <span>Systems ›</span></a><span
      class="cockpit-source"
      :class="{unavailable:!flight.live}"
    >{{ flight.live ? (telemetry.source || 'MAVLink') : 'FLIGHT DATA UNAVAILABLE' }}</span><button
      @click="openFlightControls('modes')"
    >{{ telemetry.mode || 'NO MODE' }} ·
      {{telemetry.armed===true?'ARMED':telemetry.armed===false?'DISARMED':'—'}}</button><button
      @click="panel='display'">Display & data</button><button
      @click="panel='status'"
      aria-label="Aircraft and command status"
    >{{snapshot.operations?.at(-1)?.state || 'Aircraft'}}</button></header>
  <FlightControlPanel
    ref="flightControls"
    :snapshot="agedSnapshot"
    :available="canCommand"
    :selected-target="selectedFlightTarget"
    @request="({action,label})=>review(action,label)"
    @pick-target="pickFlightTarget"
  />
  <div v-if="preferences.display.stripPlacement==='mfd'" class="cockpit-navigation-data" aria-label="Mission and navigation instrument data">
    <TelemetryStrip :telemetry="displayTelemetry" :live="flight.live" @open="panel='status'" />
  </div>
  <div class="cockpit-body">
    <PrimaryFlightDisplay
      ref="pfd"
      class="cockpit-primary"
      :flight="flight"
      :snapshot="agedSnapshot"
      :guidance="guidance"
      :telemetry="displayTelemetry"
      :mission="actualMission"
      :references="preferences.references"
      :options="{...preferences.display,syntheticVision:onlineTerrain}"
      :cdi-scale="cdiScale"
      :background-ready="backgroundReady"
      :background-label="backgroundLabel"
      :terrain-report="terrainReport"
      @flight-controls="openFlightControls"
      @reference="setReference"
      @option="setOption"
      @navigate="navigate"
    >
      <template #background="{pose,viewport}">
        <div class="cockpit-background">
          <template v-if="background==='terrain'">
            <slot
              name="terrain"
              :snapshot="snapshot"
              :pose="pose"
              :viewport="viewport"
            >
              <component
                v-if="terrainComponent"
                :is="terrainComponent"
                :snapshot="snapshot"
                :flight="flight"
                :telemetry="displayTelemetry"
                :display-pose="pose"
                :viewport="viewport"
                :data-provider="groundData"
                :enabled="onlineTerrain"
                :imagery-enabled="onlineMap"
                :lookahead-seconds="predicted.seconds||predictionSeconds"
                @status="terrainStatus=$event"
              />
            </slot>
          </template>
          <template v-else-if="cameraPath">
            <YonderPicture
              :id="id+'-camera'"
              :props="cameraProps"
              class="cockpit-camera"
            />
            <CameraTerrainOverlay
              v-if="background==='camera-overlay'"
              :camera="{...snapshot.camera,calibration:calibrationCandidate||snapshot.camera?.calibration}"
              :telemetry="displayTelemetry"
              :now="now"
              :data-provider="groundData"
              :enabled="onlineTerrain"
              @status="cameraRegistration=$event"
            />
          </template>
          <div
            v-else-if="background!=='terrain'"
            class="cockpit-empty-background"
          >Selected camera unavailable</div>
        </div>
      </template>
      <template #traffic="{pose,viewport}">
        <slot
          name="traffic-vision"
          :snapshot="snapshot"
          :pose="pose"
          :viewport="viewport"
          :tracks="trafficTracks"
          :range="trafficRange"
          :enabled="background==='terrain'"
        >
          <TrafficVision
            v-if="background==='terrain'&&onlineTraffic"
            :flight="flight"
            :telemetry="displayTelemetry"
            :tracks="trafficTracks"
            :options="{enabled:onlineTraffic,pfd:true,map:true,labels:true,trails:true,showGround:false,radiusNm:trafficRange,trailSeconds}"
            :selected-id="selectedTraffic?.id"
            :display-pose="pose"
            :viewport="viewport"
            :now="now"
            @select="selectedTraffic=trafficTracks.find(t=>t.id===$event);panel='traffic'"
          />
        </slot>
      </template>
    </PrimaryFlightDisplay>
    <section
      class="cockpit-mission"
      :class="{expanded:layout==='mission'}"
      aria-label="Mission inset"
    >
      <header>
        <strong>{{draft?(draftContextChanged?'DRAFT · CONTEXT CHANGED':'LOCAL DRAFT'):'AIRCRAFT MISSION'}}</strong><button
          v-if="layout==='mission'"
          aria-label="Return to full PFD"
          @click="layout='full'"
        >↙</button><button
          v-else
          aria-label="Expand mission"
          @click="layout='mission'"
        >↗</button></header>
      <div class="cockpit-mission-summary">
        <b>{{guidance.targetName||'No active item'}}</b><span>{{guidance.valid?fmt(guidance.distanceM/1852,2)+' NM':'Guidance unavailable'}}<template
            v-if="guidance.eteSeconds!==null&&guidance.eteSeconds!==undefined"
          > · ETE {{fmt(guidance.eteSeconds)}} s</template></span></div>
      <NavigationDeviation v-if="layout==='mission'" :guidance="guidance" :scale="cdiScale" />
      <div class="cockpit-mission-list"><button
          v-for="item in shownMission.items"
          :key="item.seq"
          :class="{active:!draft&&item.seq===snapshot.mission?.currentSeq}"
          @click="openMission({seq:item.seq})"
        ><b>{{String(item.seq).padStart(2,'0')}}</b><span>{{commandName(item)}}<small>{{[0,3,5,6,10,11].includes(item.frame)?fmt(item.alt)+' m '+datum(item.frame):'Command '+item.command}}</small></span></button>
        <p v-if="!shownMission.items.length">{{snapshot.mission?.message||'No received mission items'}}</p>
      </div>
      <nav><button @click="openMission(null)">Mission controls</button><button
          v-if="layout==='mission'"
          @click="$refs.importFile.click()"
        >Import</button><button
          v-if="layout==='mission'"
          @click="exportMission"
        >Export</button><button
          v-if="picking"
          @click="picking=null"
        >Cancel location</button></nav>
    </section>
    <section
      class="cockpit-map-pane"
      :class="{expanded:layout==='map'}"
      aria-label="Map inset"
    >
      <header><strong>MAP · TRAFFIC {{trafficRange}} NM</strong><button
          v-if="layout==='map'"
          aria-label="Return to full PFD"
          @click="layout='full'"
        >↙</button><button
          v-else
          aria-label="Expand map"
          @click="layout='map'"
        >↗</button></header>
      <YonderCockpitMap
        :data-provider="groundData"
        :snapshot="agedSnapshot"
        :mission="shownMission"
        :prediction="predicted"
        :picking="!!picking||!!flightPicking"
        :online="onlineMap"
        :traffic="trafficReport"
        :range="trafficRange"
        :trail-seconds="trailSeconds"
        :own-trail="ownTrailDisplay"
        :now="now"
        @select="seq=>openMission({seq})"
        @location="mapLocation"
        @traffic-select="selectedTraffic=$event;panel='traffic'"
      />
      <div v-if="flightPicking" class="cockpit-target-prompt" role="status">Select {{flightPicking.kind==='loiter'?'loiter center':'Direct-To target'}} on the map<button @click="flightPicking=null">Cancel target selection</button></div>
      <footer><button aria-label="Aircraft breadcrumb settings" @click="panel='trail'">Trail</button><button @click="panel='traffic'">{{trafficReport.message||'Traffic feed off'}}</button><button
          v-if="layout==='map'"
          @click="openMission(null)"
        >Mission actions</button></footer>
    </section>
    <div v-if="background!=='terrain'&&!cameraPath" class="cockpit-camera-fallback" role="status"><span>Selected camera unavailable</span><button aria-label="Use synthetic terrain" @click="background='terrain';onlineTerrain=true">Use synthetic terrain</button></div>
    <div
      v-if="background==='camera-overlay'&&!registration.ready"
      class="cockpit-registration"
      role="status"
    >{{registration.reason}} · screen-fixed instruments remain available</div>
    <button
      v-if="onlineTerrain&&terrainReport.forecast"
      class="cockpit-forecast"
      :data-level="terrainReport.forecast.level"
      @click="panel='display'"
    >Current-motion forecast · {{terrainReport.forecast.level}}<small
        v-if="terrainReport.forecast.earliestWarningSeconds!==null"
      >Warning threshold in {{fmt(terrainReport.forecast.earliestWarningSeconds)}} s</small><small
        v-else-if="terrainReport.forecast.earliestCautionSeconds!==null"
      >Caution threshold in {{fmt(terrainReport.forecast.earliestCautionSeconds)}}
        s</small><small>{{terrainReport.forecast.coverage}} sampled coverage</small></button>
    <div
      v-if="error"
      class="cockpit-error"
      role="status"
    >{{error}}</div>
  </div>
  <nav class="cockpit-mobile-tabs"><button
      @click="mobileInset='mission'"
      :aria-pressed="mobileInset==='mission'"
    >Mission</button><button
      @click="mobileInset='map'"
      :aria-pressed="mobileInset==='map'"
    >Map</button></nav>
  <MissionTouch
    v-if="missionOpen"
    :mission="shownMission"
    :selection="selection"
    :sitl="vehicleControls"
    :busy="sending||snapshot.busy"
    :error="error"
    :draft="!!draft"
    :can-undo="history.length>0"
    @close="missionOpen=false"
    @edit="edit"
    @command="missionAction"
    @flight-controls="missionFlightControls"
    @upload="reviewUpload"
    @undo="undo"
    @export="exportMission"
    @use-live="draft=null;history=[];missionOpen=false"
    @pick-location="pickLocation"
    @start="review({kind:'mission-start'},'Start aircraft mission')"
  />
  <div
    v-if="reviewing"
    class="cockpit-scrim"
    @click.self="reviewing=null"
  >
    <section
      ref="reviewDialog"
      class="cockpit-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Review aircraft command"
      @keydown="trap"
    >
      <header>
        <h2>Review aircraft command</h2><button
          @click="reviewing=null"
          aria-label="Cancel command review"
        >×</button>
      </header>
      <div class="cockpit-dialog-body">
        <h3>{{reviewing.label}}</h3>
        <dl>
          <div>
            <dt>Vehicle</dt>
            <dd>{{reviewing.generation}}</dd>
          </div>
          <div v-if="reviewing.revision">
            <dt>Mission revision</dt>
            <dd>{{reviewing.revision}}</dd>
          </div>
          <div v-if="reviewing.action.kind==='mission-upload'">
            <dt>Transfer</dt>
            <dd>{{reviewing.action.items.length}} wire items including home · {{shownMission.name}}</dd>
          </div>
          <div v-if="reviewing.action.kind==='mission-clear'">
            <dt>Removal</dt>
            <dd>{{snapshot.mission?.items?.length||0}} aircraft wire items</dd>
          </div><template v-if="reviewing.action.kind==='immediate'">
            <div>
              <dt>Command</dt>
              <dd>{{commandName(reviewing.action)}}</dd>
            </div>
            <div
              v-for="(value,index) in reviewing.action.params"
              :key="index"
            >
              <dt>Parameter {{index+1}}</dt>
              <dd>{{value===null?'Default':value}}</dd>
            </div>
          </template><template v-if="reviewing.action.target">
            <div>
              <dt>Position</dt>
              <dd>{{fmt(reviewing.action.target.lat,7)}}°, {{fmt(reviewing.action.target.lon,7)}}°</dd>
            </div>
            <div>
              <dt>Altitude</dt>
              <dd>{{reviewing.action.target.altitudeM}} m {{reviewing.action.target.datum}}</dd>
            </div>
          </template>
        </dl>
        <p>The autopilot validates and executes this request. Acceptance and observed effect are reported separately.
        </p>
        <p
          v-if="contextChanged"
          role="alert"
        >The aircraft or mission changed. Cancel and review the current state.</p>
        <div class="cockpit-actions"><button @click="reviewing=null">Cancel</button><button
            class="cockpit-confirm"
            :disabled="sending||contextChanged||!canCommand"
            @click="confirmCommand"
          >Confirm & send</button></div>
      </div>
    </section>
  </div>
  <div
    v-if="panel"
    class="cockpit-scrim"
    @click.self="panel=null"
  >
    <section
      ref="settingsDialog"
      class="cockpit-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="panel==='display'?'Cockpit display and data sources':panel==='traffic'?'Traffic display':panel==='trail'?'Aircraft breadcrumb settings':'Aircraft status'"
      @keydown="trap"
    >
      <header>
        <h2>{{panel==='display'?'Display & data':panel==='traffic'?'Traffic':panel==='trail'?'Aircraft breadcrumbs':'Aircraft status'}}</h2><button
          @click="panel=null"
          aria-label="Close cockpit panel"
        >×</button>
      </header>
      <div class="cockpit-dialog-body">
        <template v-if="panel==='display'">
          <OwnTrailSettings :options="ownTrailOptions" :status="ownTrailDisplay" @change="setOwnTrailOptions" @clear="clearOwnTrail" @restore="restoreOwnTrail" />
          <fieldset class="cockpit-data-settings"><legend>Connection & offline data</legend>
            <label>Public data connection<select v-model="sourceMode" aria-label="Public data connection">
              <option value="ground">Ground browser internet</option>
              <option value="offline">Offline browser packs</option>
              <option value="aircraft">Aircraft proxy · uses aircraft bandwidth</option>
            </select></label>
            <p>{{sourceMode==='aircraft'?'Public data is explicitly routed through the aircraft server.':sourceMode==='offline'?'Map and terrain use imported browser packs. Live internet traffic is off.':'Imagery, terrain and ADS-B use this browser’s internet connection or your ground relay. There is no automatic aircraft proxy fallback.'}}</p>
            <p v-if="sourceMode==='ground'">The device’s network route still matters: connect the iPad or laptop to ground internet if its default connection would otherwise use the aircraft modem.</p>
            <label v-if="sourceMode==='ground'">Optional ground relay origin<input v-model="groundRelayInput" type="url" placeholder="https://ground.example" aria-label="Ground relay origin" /></label>
            <button v-if="sourceMode==='ground'" @click="applyGroundRelay">Apply ground relay</button>
            <label>Display telemetry updates<select v-model.number="telemetryRate" aria-label="Display telemetry updates">
              <option v-for="rate in [1,2,4,8]" :key="rate" :value="rate">{{rate}} / second</option>
            </select></label>
            <p v-if="connectionStats">Flight payload {{fmt(connectionStats.flightBytes)}} bytes · received JSON {{fmt(connectionStats.bytesPerSecond/1024,1)}} KiB/s. Mission transfers {{connectionStats.missionTransfers}}; detail transfers {{connectionStats.detailsTransfers}}. Excludes HTTP overhead, video and public data.</p>
            <div class="cockpit-actions">
              <button :disabled="dataBusy" @click="$refs.terrainPackFiles.click()">Import terrain folder</button>
              <button :disabled="dataBusy" @click="$refs.offlineMapFiles.click()">Import offline map folder</button>
              <button :disabled="dataBusy" @click="$refs.geoidFile.click()">Import EGM96 geoid</button>
              <p v-if="groundRelayUrl&&sourceMode==='ground'">Detailed terrain streams from the selected ground relay as needed. Look-ahead loads follow measured motion up to 30 seconds ahead. Preload the whole pack only for offline use.</p>
              <button :disabled="dataBusy||!groundRelayUrl||sourceMode!=='ground'" @click="preloadGroundTerrain">Preload terrain from ground relay</button>
            </div>
            <p v-if="groundStatus.offlineTerrain">Saved terrain: {{groundStatus.offlineTerrain.title||groundStatus.offlineTerrain.id}} · {{groundStatus.offlineTerrain.tiles}} tiles.</p>
            <p v-if="groundStatus.offlineMap">Saved map: {{groundStatus.offlineMap.title||groundStatus.offlineMap.id}} · {{groundStatus.offlineMap.tiles}} tiles.</p>
            <p v-if="groundStatus.geoid">Traffic height conversion: {{groundStatus.geoid}}.</p>
            <p v-if="dataMessage" role="status">{{dataMessage}}</p>
            <p v-if="groundStatus.error" role="status">{{groundStatus.error}}</p>
            <p v-if="snapshot.detailError" role="status">Aircraft details: {{snapshot.detailError}}</p>
          </fieldset>
          <label>Palette<select
              aria-label="Palette"
              v-model="palette"
            >
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select></label><label>Background<select v-model="background">
              <option value="terrain">Synthetic terrain</option>
              <option value="camera">Camera</option>
              <option value="camera-overlay">Camera + registered terrain</option>
            </select></label>
          <p>{{backgroundLabel}}</p><template v-if="terrainReport.terrainManifest">
            <p>Survey {{terrainReport.terrainManifest.sources[0]?.surveyStart}} to
              {{terrainReport.terrainManifest.sources[0]?.surveyEnd}} ·
              {{terrainReport.terrainManifest.surfaceDescription}}</p>
            <p>{{terrainReport.terrainManifest.verticalTransform.description}}</p>
            <p
              v-for="limitation in terrainReport.terrainManifest.limitations"
              :key="limitation"
            >{{limitation}}</p>
          </template>
          <p v-if="terrainReport.forecast">{{terrainReport.forecast.reason}}. Minimum ground / mapped-surface clearance:
            {{fmt(terrainReport.forecast.minimumGroundClearanceM)}} /
            {{fmt(terrainReport.forecast.minimumSurfaceClearanceM)}} m. Closure:
            {{fmt(terrainReport.forecast.closureMps,1)}} m/s. Checked
            {{fmt(terrainReport.forecast.evaluatedUntilSeconds)}} of {{fmt(terrainReport.forecast.lookaheadSeconds)}}
            seconds, {{terrainReport.forecast.samples}} samples. Sampled corridor ±20 m; 30 m warning / 90 m caution.
            This extrapolates measured track, speed and climb; it does not predict autopilot turns.</p>
          <label>Camera<select v-model="cameraId">
              <option :value="null">Automatic identified / sole camera</option>
              <option
                v-for="camera in snapshot.cameras||[]"
                :key="camera.id"
                :value="camera.id"
              >{{camera.name||camera.id}}{{camera.detected?'':' · not detected'}}</option>
            </select></label><label>Verified aircraft height datum<select v-model="aircraftDatum">
              <option value="UNKNOWN">Unknown</option>
              <option value="EGM96">EGM96</option>
              <option value="NAVD88">NAVD88</option>
              <option value="WGS84_ELLIPSOID">WGS84 ellipsoid</option>
            </select></label>
          <p>Declare a datum only from the receiver configuration. Camera overlays also require measured calibration and
            capture-time pose.</p><button @click="$refs.calibrationFile.click()">Import camera calibration JSON</button>
          <p v-if="calibrationCandidate">Calibration candidate: {{calibrationCandidate.id}} · {{registration.reason}}
          </p><label><input
              type="checkbox"
              v-model="onlineTerrain"
            /> Enable terrain data</label><label><input
              type="checkbox"
              v-model="onlineMap"
            /> Enable hybrid imagery data</label><label><input
              type="checkbox"
              v-model="onlineTraffic"
            /> Enable internet ADS-B traffic</label>
          <p>Data sources are optional. Executable display assets are served by this device.</p><label>Motion
            estimate<select v-model="predictionMode">
              <option value="time">Time vector</option>
              <option value="distance">Distance vector</option>
            </select></label><label v-if="predictionMode==='time'">Prediction time<select
              v-model.number="predictionSeconds"
            >
              <option :value="10">10 seconds</option>
              <option :value="30">30 seconds</option>
              <option :value="60">60 seconds</option>
              <option :value="120">120 seconds</option>
            </select></label><label v-else>Prediction distance<select v-model.number="predictionDistance">
              <option :value="500">500 m</option>
              <option :value="1000">1 km</option>
              <option :value="1852">1 NM</option>
            </select></label>
          <p>Vectors estimate measured motion. ETE is time to the selected point, not a turn countdown.</p><label>CDI
            full scale<select v-model.number="cdiScale">
              <option :value="100">100 m</option>
              <option :value="250">250 m</option>
              <option :value="500">500 m</option>
            </select></label><button @click="panel=null;$refs.pfd.open('attitude')">Instrument transparency &
            settings</button><button @click="panel=null;$refs.pfd.open('director')">Flight director
            settings</button><button @click="$refs.importFile.click()">Import WPL / QGC plan</button><button
            @click="newMission"
          >Create empty local mission</button><button @click="loadDemo()">Load cove example as local draft</button>
          <button @click="loadDemo(true)">Load VTOL cove example as local draft</button>
          <p>VTOL example: QuadPlane vertical takeoff to 180 ft above home, then transition toward item 02 and climb to the 300 ft route. Requires a configured QuadPlane simulator or aircraft.</p>
        </template>
        <template v-else-if="panel==='draft-conflict'">
          <h3>Draft context changed</h3>
          <p>This local draft began on vehicle {{draftContext?.generation||'unavailable'}}, mission
            {{draftContext?.revision||'unknown'}}. The current aircraft is
            {{snapshot.identity?.generation||'unavailable'}}, mission {{snapshot.mission?.revision||'unknown'}}.</p>
          <p>Compare the current aircraft mission with this local draft before replacing it. Keeping the draft for this
            aircraft adopts its current home record during upload; all existing draft parameters remain as authored.</p>
          <p>Draft: {{draft?.items.length}} authored items. Aircraft: {{actualMission.items.length}} authored items.
            Current home: {{actualMission.home?.lat}}, {{actualMission.home?.lon}}, {{actualMission.home?.alt}} m MSL.
          </p><button @click="panel=null;draft=null;draftContext=null;history=[]">Use current aircraft
            mission</button><button
            :disabled="!canCommand"
            @click="captureDraftContext();panel=null;reviewUpload()"
          >Keep this draft for the current aircraft and review upload</button>
        </template><template v-else-if="panel==='trail'">
          <OwnTrailSettings :options="ownTrailOptions" :status="ownTrailDisplay" @change="setOwnTrailOptions" @clear="clearOwnTrail" @restore="restoreOwnTrail" />
        </template><template v-else-if="panel==='traffic'">
          <label><input v-model="onlineTraffic" type="checkbox" />Enable internet ADS-B traffic</label>
          <label>Display range<select v-model.number="trafficRange">
              <option
                v-for="range in [1,2,5,10,25,50,100]"
                :key="range"
                :value="range"
              >{{range}} NM</option>
            </select></label><label>Observed trail<select v-model.number="trailSeconds">
              <option :value="60">60 seconds</option>
              <option :value="120">120 seconds</option>
              <option :value="300">300 seconds</option>
            </select></label>
          <p>{{trafficReport.message||'Traffic feed off'}}</p>
          <p v-if="onlineTraffic&&trafficMapOnlyCount">{{trafficMapOnlyCount}} target{{trafficMapOnlyCount===1?'':'s'}} on map only: geometric altitude or height conversion is unavailable.</p>
          <p v-if="onlineTraffic&&!trafficReport.altitudeModel&&sourceMode==='ground'">Import the EGM96 geoid in data setup to enable synthetic-vision placement for targets reporting geometric altitude. Targets must also be in the forward view.</p>
          <p>Use Fit {{trafficRange}} NM on the map to show the selected traffic range. Follow keeps your chosen zoom.</p>
          <button @click="panel='display'">Traffic data setup</button>
          <p v-if="selectedTraffic"><b>{{selectedTraffic.callSign||selectedTraffic.id}}</b> ·
            {{selectedTraffic.altitudeMslM==null?'Altitude datum unknown: map only':fmt(selectedTraffic.altitudeMslM/.3048)+' ft MSL'}}
          </p>
          <p>Breadcrumbs are observed positions; gaps break the trail. Traffic expires after one minute. No targets is
            not a statement that the airspace is clear.</p>
          <p>{{trafficReport.attribution||'Source attribution appears with an enabled feed'}}</p>
        </template>
        <template v-else>
          <dl>
            <div>
              <dt>Telemetry</dt>
              <dd>{{flight.live?'Live':'Unavailable'}}</dd>
            </div>
            <div>
              <dt>GPS altitude</dt>
              <dd>{{fmt(telemetry.gpsAltitudeM)}} m</dd>
            </div>
            <div>
              <dt>Fused global altitude</dt>
              <dd>{{fmt(telemetry.globalAltitudeM)}} m MSL</dd>
            </div>
            <div>
              <dt>Relative home</dt>
              <dd>{{fmt(telemetry.relativeAltitudeM)}} m</dd>
            </div>
            <div>
              <dt>Desired pitch / bank</dt>
              <dd>{{fmt(flight.navPitch,1)}}° / {{fmt(flight.navRoll,1)}}°</dd>
            </div>
          </dl>
          <div class="cockpit-actions"><button
              :disabled="!canCommand"
              @click="sendReadAction('stream-setup')"
            >Request flight telemetry</button><button
              :disabled="!canCommand"
              @click="sendReadAction('mission-download')"
            >Read aircraft mission</button><button @click="openFlightControls('modes')">Autopilot controls</button>
          </div>
          <article
            v-for="op in snapshot.operations||[]"
            :key="op.id"
          ><b>{{op.state}}</b>
            <p>{{op.message}}</p><small>{{op.effect?.message}}</small>
          </article>
        </template>
      </div>
    </section>
  </div>
  <input ref="terrainPackFiles" type="file" multiple webkitdirectory hidden @change="importGroundFiles('terrain',$event)" />
  <input ref="offlineMapFiles" type="file" multiple webkitdirectory hidden @change="importGroundFiles('map',$event)" />
  <input ref="geoidFile" type="file" accept=".pgm" hidden @change="importGroundFiles('geoid',$event)" />
  <input
    ref="calibrationFile"
    type="file"
    accept=".json"
    hidden
    @change="importCalibration"
  /><input
    ref="importFile"
    type="file"
    accept=".waypoints,.plan,.json"
    hidden
    @change="importMission"
  />
</main>
</template>
<script>
import { markRaw } from 'vue'
import { createGroundDataProvider } from './cockpit/ground-data.mjs'
import {
  validateCameraCalibration
} from 'yonder-core/terrain'
import coveDemo from './cockpit/data/cove-demo.json'
import coveVtolDemo from './cockpit/data/cove-vtol-demo.mjs'
import CameraTerrainOverlay from './cockpit/CameraTerrainOverlay.vue'
import TrafficVision from './cockpit/TrafficVision.vue'
import TerrainVision from './cockpit/TerrainVision.vue'
import TelemetryStrip from './cockpit/TelemetryStrip.vue'
import NavigationDeviation from './cockpit/NavigationDeviation.vue'
import PrimaryFlightDisplay from './cockpit/PrimaryFlightDisplay.vue'
import FlightControlPanel from './cockpit/FlightControlPanel.vue'
import MissionTouch from './cockpit/MissionTouch.vue'
import YonderCockpitMap from './cockpit/YonderCockpitMap.vue'
import OwnTrailSettings from './cockpit/OwnTrailSettings.vue'
import {selectOwnTrail,trailPreferences} from './cockpit/own-trail.mjs'
import YonderPicture from './YonderPicture.vue'
import {
  agedTelemetry,
  flightView,
  fmt,
  prediction,
  aircraftMission,
  missionWire,
  targetAction,
  cameraOverlayGate,
  createCockpitApi
} from './cockpit/cockpit-state.mjs'
import {
  navigationView
} from './cockpit/navigation-view.mjs'
import {
  validatePfdPreferences
} from './cockpit/pfd-controls.mjs'
import {
  getCommand
} from './cockpit/mission-commands.mjs'
import {
  parseMission
} from './cockpit/mission-import.mjs'
import {
  editMission,
  exportWpl
} from './cockpit/mission-edit.mjs'
const empty = () => ({
  telemetry: {
    ready: false
  },
  mission: {
    items: [],
    message: 'Waiting for aircraft mission'
  },
  capabilities: {
    modes: [],
    commands: []
  },
  operations: []
})
const clone = value => JSON.parse(JSON.stringify(value))
export default {
  name: 'YonderCockpit',
  components: {
    TelemetryStrip,
    NavigationDeviation,
    CameraTerrainOverlay,
    TrafficVision,
    PrimaryFlightDisplay,
    FlightControlPanel,
    MissionTouch,
    YonderCockpitMap,
    OwnTrailSettings,
    YonderPicture
  },
  inject: {
    $socket: {
      default: null
    },
    $dataTracker: {
      default: null
    }
  },
  props: {
    id: {
      type: String,
      required: true
    },
    props: {
      type: Object,
      default: () => ({})
    },
    state: Object,
    report: {
      type: Object,
      default: null
    },
    api: {
      type: Object,
      default: null
    },
    dataProvider: { type: Object, default: null },
    terrainComponent: {
      default: () => TerrainVision
    }
  },
  data() {
    return {
      snapshot: this.report || this.props.report || empty(),
      layout: 'full',
      palette: document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night',
      mobileInset: 'map',
      preferences: validatePfdPreferences(),
      background: 'terrain',
      onlineTerrain: false,
      onlineMap: false,
      onlineTraffic: false,
      groundData: markRaw(this.dataProvider || createGroundDataProvider()),
      sourceMode: 'ground',
      groundRelayUrl: '',
      groundRelayInput: '',
      groundStatus: {},
      dataMessage: '',
      dataBusy: false,
      hydratingOptions: false,
      editedOptions: {},
      dataOptionTimer: null,
      dataSyncing: false,
      dataSyncPending: false,
      telemetryRate: 4,
      connectionStats: null,
      trafficReport: {
        tracks: [],
        message: 'Traffic feed off'
      },
      cameraId: null,
      aircraftDatum: 'UNKNOWN',
      calibrationCandidate: null,
      trafficRange: 10,
      trailSeconds: 120,
      ownTrailOptions:trailPreferences(),
      ownTrailCleared:null,
      optionsLoaded: false,
      selectedTraffic: null,
      terrainStatus: null,
      cameraRegistration: null,
      now: Date.now(),
      receivedAt: Date.now(),
      timer: null,
      pollTimer: null,
      viewportObserver: null,
      source: null,
      disposed: false,
      panel: null,
      selection: null,
      missionOpen: false,
      draft: null,
      draftContext: null,
      history: [],
      picking: null,
      flightPicking: null,
      reviewing: null,
      pendingOperationId: null,
      sending: false,
      error: '',
      pollError: null,
      predictionMode: 'time',
      predictionSeconds: 30,
      predictionDistance: 1000,
      cdiScale: 250,
      previousFocus: null
    }
  },
  computed: {
    trafficMapOnlyCount(){return (this.trafficReport.tracks||[]).filter(track=>!Number.isFinite(track.altitudeMslM)).length},
    ownTrailDisplay(){return selectOwnTrail(this.snapshot.ownTrail,this.ownTrailOptions,this.ownTrailCleared,this.snapshot.at+Math.floor(Math.max(0,this.elapsed)/1000)*1000)},
    draftContextChanged(){return !!this.draft&&(!this.draftContext||this.draftContext.generation!==(this.snapshot.identity?.generation||null)||this.draftContext.revision!==(this.snapshot.mission?.revision||null))},
    telemetry() {
      return agedTelemetry(this.snapshot.telemetry || {}, this.elapsed)
    },
    elapsed() {
      return Math.max(0, this.now - this.receivedAt)
    },
    flight() {
      return flightView({
        telemetry: this.telemetry
      })
    },
    agedSnapshot() {
      return {
        ...this.snapshot,
        telemetry: {
          ...this.telemetry,
          ready: this.flight.live
        }
      }
    },
    displayTelemetry() {
      return {
        ...this.telemetry,
        ready: this.flight.live,
        gpsAltitudeM: this.telemetry.gpsAltitudeM
      }
    },
    actualMission() {
      return aircraftMission(this.snapshot)
    },
    shownMission() {
      return this.draft || this.actualMission
    },
    guidance() {
      return navigationView(this.agedSnapshot)
    },
    predicted() {
      return prediction({
        ...this.telemetry,
        ready: this.flight.live
      }, this.predictionMode === 'time' ? {
        seconds: this.predictionSeconds
      } : {
        distanceM: this.predictionDistance
      })
    },
    cameraPath() {
      return this.snapshot.camera?.path || this.props.cameraPath || ''
    },
    cameraProps() {
      return {
        path: this.cameraPath,
        label: this.snapshot.camera?.name || 'Selected camera',
        report: {
          ...this.snapshot.camera,
          aim: {
            state: 'not-offered'
          }
        },
        stillsUrl: this.snapshot.camera?.stillsUrl || ''
      }
    },
    terrainReport() {
      return this.terrainStatus || this.snapshot.terrain || {
        state: 'unavailable',
        message: 'Terrain data unavailable · conventional horizon'
      }
    },
    backgroundReady() {
      return this.background === 'terrain' ? this.terrainReport.state === 'ready' : !!this.cameraPath
    },
    backgroundLabel() {
      return this.background === 'terrain' ? (this.terrainReport.message || 'Synthetic terrain') : (this.cameraPath ? (
        this.snapshot.camera?.name || 'Selected camera') : 'Camera unavailable')
    },
    registration() {
      return this.cameraRegistration || cameraOverlayGate(this.snapshot.camera)
    },
    trafficTracks() {
      return this.trafficReport.tracks || []
    },
    selectedFlightTarget() {
      const item=this.shownMission.items.find(item=>item.seq===this.selection?.seq);
      const command=getCommand(item?.command);
      if(!item||!command?.location||!command?.altitude||![0,3,5,6].includes(item.frame)||![item.lat,item.lon,item.alt].every(Number.isFinite))return null;
      return {lat:item.lat,lon:item.lon,altitudeM:item.alt,datum:[0,5].includes(item.frame)?'msl':'home'}
    },
    canCommand() {
      return !!this.source?.command && !!this.snapshot.identity?.generation && this.snapshot.connected === true && this.snapshot._detailsReady !== false
    },
    contextChanged() {
      return !!this.reviewing && (this.reviewing.generation !== this.snapshot.identity?.generation || this.reviewing
        .revision !== (this.snapshot.mission?.revision || null))
    },
    vehicleControls() {
      const last = this.snapshot.operations?.at(-1);
      return {
        available: !!this.source?.command,
        connected: this.snapshot.connected,
        mode: this.telemetry.mode,
        armed: this.telemetry.armed,
        busy: this.snapshot.busy,
        modes: (this.snapshot.capabilities?.modes || []).map(m => m.name),
        immediateCommands: this.snapshot.capabilities?.commands || [],
        lastResult: last ? {
          state: last.state,
          message: last.message
        } : null
      }
    }
  },
  watch: {
    sourceMode() { this.dataOptions('sourceMode') },
    report: {
      handler(v) {
        if (v) this.ingest(v)
      },
      deep: true
    },
    'props.report': {
      handler(v) {
        if (v) this.ingest(v)
      },
      deep: true
    },
    panel(value) {
      if (value) this.focusDialog('settingsDialog');
      else this.previousFocus?.focus?.()
    },
    reviewing(value) {
      if (value) this.focusDialog('reviewDialog');
      else this.previousFocus?.focus?.()
    },
    mobileInset(value) {
      this.$el?.setAttribute('data-mobile-inset', value)
    },
    onlineTerrain() {
      this.dataOptions('terrain')
    },
    onlineMap() {
      this.dataOptions('imagery')
    },
    onlineTraffic() {
      this.dataOptions('traffic')
    },
    trafficRange() {
      this.dataOptions('trafficRadiusNm')
    },
    cameraId() {
      this.dataOptions('cameraId')
    },
    aircraftDatum() {
      this.dataOptions('aircraftDatum')
    }
  },
  mounted() {
    this.palette = getComputedStyle(document.documentElement).getPropertyValue('--yonder-theme').includes('day') ?
      'day' : this.palette;
    this.$nextTick(() => {
      this.fitViewport();
      if (typeof ResizeObserver !== 'undefined') {
        this.viewportObserver = new ResizeObserver(() => this.fitViewport());
        this.viewportObserver.observe(this.$el.parentElement)
      }
    });
    window.addEventListener('resize', this.fitViewport);
    if (this.report || this.props.report) this.ingest(this.report || this.props.report);
    this.source = this.api || (!this.report && !this.props.report ? createCockpitApi() : null);
    this.$el.setAttribute('data-mobile-inset', this.mobileInset);
    this.groundData.refreshOffline().then(()=>{ if(!this.disposed)this.groundStatus=this.groundData.status() }).catch(e=>{this.dataMessage='Browser storage unavailable: '+e.message});
    try {
      const saved = JSON.parse(localStorage.getItem('yonder-cockpit-v1') || 'null');
      if (saved) this.preferences = validatePfdPreferences(saved)
      const trail=JSON.parse(localStorage.getItem('yonder-own-trail-v1')||'null');
      if(trail){this.ownTrailOptions=trailPreferences(trail.options);this.ownTrailCleared=trail.cleared}
      const relay=localStorage.getItem('yonder-ground-relay-v1');
      if(relay){this.groundRelayInput=relay;this.applyGroundRelay()}
    } catch {}
    this.source?.setTrailOptions?.(this.ownTrailOptions);
    this.timer = setInterval(() => {
      this.now = Date.now();
      this.connectionStats=this.source?.stats?.()||null;
      this.refreshGroundTraffic();
      this.groundStatus=this.groundData.status()
    }, 200);
    if (this.source?.state && !this.report && !this.props.report) this.poll()
  },
  beforeUnmount() {
    this.viewportObserver?.disconnect();
    window.removeEventListener('resize', this.fitViewport);
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.dataOptionTimer);
    this.source?.close?.();
    this.groundData.close()
  },
  methods: {
    saveOwnTrail(){try{localStorage.setItem('yonder-own-trail-v1',JSON.stringify({options:this.ownTrailOptions,cleared:this.ownTrailCleared}))}catch{this.error='Trail preferences could not be saved; this session still works'}},
    setOwnTrailOptions(options){this.ownTrailOptions=trailPreferences(options);this.source?.setTrailOptions?.(this.ownTrailOptions);this.saveOwnTrail()},
    clearOwnTrail(){const trail=this.snapshot.ownTrail;if(trail)this.ownTrailCleared={epoch:trail.epoch,after:trail.latest};this.saveOwnTrail()},
    restoreOwnTrail(){this.ownTrailCleared=null;this.saveOwnTrail()},
    fitViewport() {
      if (!this.$el || this.props.embedded) return;
      const top = this.$el.getBoundingClientRect().top;
      let bottomSpacing = 4;
      // Dashboard groups and pages add padding outside the widget's own box.
      for (let ancestor = this.$el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        bottomSpacing += ['paddingBottom', 'borderBottomWidth', 'marginBottom']
          .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
      }
      const height = Math.max(360, window.innerHeight - Math.max(0, top) - bottomSpacing);
      this.$el.style.setProperty('--cockpit-height', height + 'px')
    },
    fmt,
    missionWire,
    commandName: item => getCommand(item.command)?.label || `Command ${item.command}`,
    datum: frame => ({
      0: 'MSL',
      5: 'MSL',
      3: 'above home',
      6: 'above home',
      10: 'above terrain',
      11: 'above terrain'
    } [frame] || `frame ${frame}`),
    ingest(value) {
      this.snapshot = value.ownTrail?{...value,ownTrail:markRaw(value.ownTrail)}:value;
      this.receivedAt = Date.now();
      if(this.pendingOperationId){
        const operation=value.operations?.find(op=>op.id===this.pendingOperationId);
        if(operation){this.error=operation.state+' · '+operation.message;if(['observed','accepted','rejected','failed','unknown'].includes(operation.state))this.pendingOperationId=null}
      }
      if (value.traffic) this.trafficReport = value.traffic;
      if (!this.optionsLoaded && value.dataOptions) {
        this.hydratingOptions = true;
        this.optionsLoaded = true;
        if(!this.editedOptions.terrain)this.onlineTerrain = value.dataOptions.terrain === true;
        if(!this.editedOptions.imagery)this.onlineMap = value.dataOptions.imagery === true;
        if(!this.editedOptions.traffic)this.onlineTraffic = value.dataOptions.traffic === true;
        if(!this.editedOptions.cameraId)this.cameraId = value.dataOptions.cameraId ?? null;
        if(!this.editedOptions.aircraftDatum)this.aircraftDatum = value.dataOptions.aircraftDatum || 'UNKNOWN';
        this.configureGroundData();
        this.$nextTick(()=>{this.hydratingOptions=false;if(Object.keys(this.editedOptions).length)this.dataOptions()})
      }
    },
    async poll() {
      if (this.disposed) return;
      try {
        const state = await this.source.state();
        if (this.error === this.pollError) this.error = '';
        this.pollError = null;
        this.ingest(state)
      } catch (e) {
        this.pollError = e.name === 'AbortError' ? 'Telemetry request timed out' : e.message;
        this.error = this.pollError
      } finally {
        if (!this.disposed) this.pollTimer = setTimeout(() => this.poll(), 1000/this.telemetryRate)
      }
    },
    persist() {
      try {
        localStorage.setItem('yonder-cockpit-v1', JSON.stringify(this.preferences))
      } catch {
        this.error = 'Display preferences could not be saved; this session still works'
      }
    },
    setReference(key, value) {
      this.preferences.references[key] = value;
      this.persist()
    },
    setOption(key, value) {
      if (key === 'syntheticVision') {
        this.onlineTerrain = value;
        return
      }
      this.preferences = validatePfdPreferences({
        ...this.preferences,
        display: {
          ...this.preferences.display,
          [key]: value
        }
      });
      this.persist()
    },
    navigate(target) {
      if (target === 'display' || target === 'settings') {
        this.panel = 'display';
        return
      }
      if (target === 'status') {
        this.panel = 'status';
        return
      }
      this.layout = 'mission';
      this.openMission(null)
    },
    openMission(selection) {
      this.selection = selection;
      this.missionOpen = true;
      this.error = ''
    },
    edit(operation) {
      try {
        const previous = clone(this.shownMission),
          next = editMission(previous, operation);
        this.history.push(previous);
        if (this.history.length > 50) this.history.shift();
        if(!this.draft)this.captureDraftContext();
        this.draft = next;
        this.missionOpen = false;
        this.selection = null
      } catch (e) {
        this.error = e.message
      }
    },
    undo() {
      if (this.history.length) this.draft = this.history.pop()
    },
    loadDemo(vtol = false) {
      this.captureDraftContext();
      this.draft = clone(vtol ? coveVtolDemo : coveDemo);
      this.draft.source = vtol ? 'Local QuadPlane cove example' : 'Local cove example';
      this.history = [];
      this.panel = null;
      this.layout = 'mission';
      this.error = `${vtol ? 'VTOL cove' : 'Cove'} example loaded locally; aircraft mission is unchanged`
    },
    newMission() {
      this.captureDraftContext();
      this.draft = {
        name: 'New mission',
        source: 'Local draft',
        home: this.actualMission.home,
        items: [],
        warnings: []
      };
      this.history = [];
      this.panel = null;
      this.layout = 'mission';
      this.openMission(null)
    },
    async importMission(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('Mission file exceeds 2 MiB');
        const imported=parseMission(await file.text(), file.name);
        this.captureDraftContext();
        this.draft = imported;
        this.history = [];
        this.layout = 'mission';
        this.panel = null
      } catch (e) {
        this.error = e.message
      }
      event.target.value = ''
    },
    exportMission() {
      try {
        const body = exportWpl(this.shownMission),
          url = URL.createObjectURL(new Blob([body], {
            type: 'text/plain'
          })),
          link = document.createElement('a');
        link.href = url;
        link.download = 'mission.waypoints';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (e) {
        this.error = e.message
      }
    },
    openFlightControls(kind,target) {
      this.panel=null;
      this.missionOpen=false;
      this.$refs.flightControls?.open(kind,target)
    },
    missionFlightControls(payload) {
      const target={lat:payload.lat,lon:payload.lon};
      if(Number.isFinite(payload.alt)&&[0,3,5,6].includes(payload.frame))Object.assign(target,{altitudeM:payload.alt,datum:[0,5].includes(payload.frame)?'msl':'home'});
      this.openFlightControls(payload.kind,target)
    },
    pickFlightTarget(intent) {
      this.flightPicking={...intent,generation:this.snapshot.identity?.generation};
      this.picking=null;
      this.missionOpen=false;
      this.layout='map'
    },
    pickLocation(intent) {
      this.flightPicking=null;
      this.picking = intent;
      this.missionOpen = false;
      this.layout = 'map'
    },
    mapLocation(point) {
      if(this.flightPicking){
        const intent=this.flightPicking;
        this.flightPicking=null;
        if(intent.generation!==this.snapshot.identity?.generation){this.error='The aircraft changed while selecting a target. Choose a new flight target.';return;}
        this.openFlightControls(intent.kind,{...intent.target,...point});
        return;
      }
      if (this.picking) {
        const intent = this.picking;
        this.picking = null;
        this.openMission({
          ...intent,
          ...point,
          action: intent.seq !== undefined ? 'replace' : 'insert',
          item: intent.item ? {
            ...intent.item,
            lat: point.lat,
            lon: point.lon
          } : undefined
        })
      } else this.openMission(point)
    },
    missionAction(payload) {
      try {
        let action, label;
        if (payload.action === 'goto') {
          action = targetAction({
            lat: payload.lat,
            lon: payload.lon,
            altitudeM: payload.alt,
            datum: [0, 5].includes(payload.frame) ? 'msl' : [3, 6].includes(payload.frame) ? 'home' : 'terrain'
          });
          if (action.target.datum === 'terrain' && !this.snapshot.capabilities?.terrainTargets) throw new Error(
            'This aircraft does not support terrain-relative targets');
          label = 'Fly to position / GUIDED loiter'
        } else if (payload.action === 'mode') {
          const mode = this.snapshot.capabilities?.modes?.find(m => m.name === payload.mode);
          if (!mode) throw new Error('This mode is not available');
          action = {
            kind: 'mode',
            customMode: mode.customMode
          };
          label = `Select ${mode.name}`
        } else if (['arm', 'disarm'].includes(payload.action)) {
          action = {
            kind: 'arm',
            armed: payload.action === 'arm'
          };
          label = payload.action === 'arm' ? 'Arm aircraft' : 'Disarm aircraft'
        } else if (payload.action === 'set-current') {
          action = {
            kind: 'set-current',
            seq: payload.seq
          };
          label = `Set current mission item ${payload.seq}`
        } else if (payload.action === 'mission-clear') {
          action = {
            kind: 'mission-clear'
          };
          label = 'Clear aircraft mission and verify readback'
        } else if (payload.action === 'continue-auto') {
          const mode = this.snapshot.capabilities?.modes?.find(m => m.name === 'AUTO');
          if (!mode) throw new Error('AUTO is unavailable');
          action = {
            kind: 'continue-auto',
            seq: payload.seq,
            autoMode: mode.customMode
          };
          label = `Continue AUTO from item ${payload.seq}`
        } else if (payload.action === 'command') {
          action = {
            kind: 'immediate',
            command: payload.command,
            params: payload.params,
            frame: payload.frame
          };
          label = `Send command ${payload.command}`
        } else throw new Error('Unsupported action');
        this.review(action, label)
      } catch (e) {
        this.error = e.message
      }
    },
    captureDraftContext(){this.draftContext={generation:this.snapshot.identity?.generation||null,revision:this.snapshot.mission?.revision||null}},
    reviewUpload() {
      if(this.draftContextChanged){this.missionOpen=false;this.panel='draft-conflict';return;}
      try {
        this.review({
          kind: 'mission-upload',
          items: missionWire(this.shownMission, this.snapshot)
        }, 'Upload draft and verify readback')
      } catch (e) {
        this.error = e.message
      }
    },
    review(action, label) {
      if (!this.canCommand) {
        this.error = 'Aircraft command transport unavailable';
        return
      }
      this.reviewing = {
        action: clone(action),
        label,
        generation: this.snapshot.identity.generation,
        revision: this.snapshot.mission?.revision || null
      };
      this.missionOpen = false;
      this.$refs.flightControls?.close();
      this.panel = null
    },
    async confirmCommand() {
      if (!this.reviewing || this.contextChanged || this.sending || !this.canCommand) return;
      const current = this.reviewing;
      this.sending = true;
      try {
        const response = await this.source.command({
          id: crypto.randomUUID(),
          vehicleGeneration: current.generation,
          ...(current.revision ? {
            expectedMissionRevision: current.revision
          } : {}),
          confirmed: true,
          action: current.action
        });
        if (response.accepted !== true) {
          this.error = 'Request rejected: ' + (response.message || 'Command was not admitted');
          this.reviewing = null;
          return
        }
        this.pendingOperationId=response.operationId;
        this.error = `Request queued · ${response.operationId}. Awaiting aircraft result.`;
        this.reviewing = null
      } catch (e) {
        this.reviewing = null;
        this.error = e.admissionRejected ? 'Request rejected: ' + e.message :
          `Command outcome unknown: ${e.message}. Check aircraft status before repeating.`
      } finally {
        this.sending = false
      }
    },
    async sendReadAction(kind) {
      if (!this.canCommand || this.sending) return;
      this.sending = true;
      try {
        const response = await this.source.command({
          id: crypto.randomUUID(),
          vehicleGeneration: this.snapshot.identity.generation,
          confirmed: false,
          action: {
            kind
          }
        });
        if (response.accepted !== true) throw new Error(response.message || 'Request unavailable');
        this.pendingOperationId=response.operationId;
        this.error = 'Request queued; awaiting aircraft response'
      } catch (e) {
        this.error = e.message
      } finally {
        this.sending = false
      }
    },
    async importCalibration(event) {
      try {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 65536) throw new Error('Calibration file exceeds 64 KiB');
        const profile = JSON.parse(await file.text());
        if (!validateCameraCalibration(profile) || typeof profile.id !== 'string' || profile.cameraId !== this
          .snapshot.camera?.id || profile.profileId !== this.snapshot.camera?.profileId || !Array.isArray(profile
            .bodyToCamera) || profile.bodyToCamera.length !== 9 || !Array.isArray(profile.cameraOffsetBodyM) ||
          profile.cameraOffsetBodyM.length !== 3 || !profile.distortion) throw new Error(
          'Calibration must match the selected camera and current capture profile');
        this.calibrationCandidate = profile;
        this.error =
          'Calibration candidate loaded locally. Registration still requires valid geometry, datum and frame timing.'
      } catch (e) {
        this.error = e.message
      }
      event.target.value = ''
    },
    configureGroundData() {
      this.groundData.configure({mode:this.sourceMode,terrain:this.onlineTerrain,imagery:this.onlineMap,traffic:this.onlineTraffic,trafficRadiusNm:this.trafficRange,groundRelayUrl:this.groundRelayUrl});
      this.groundStatus=this.groundData.status()
    },
    dataOptions(key) {
      if(this.hydratingOptions||this.disposed)return;
      if(key)this.editedOptions[key]=true;
      try{this.configureGroundData()}catch(e){this.dataMessage=e.message;return}
      if(!this.optionsLoaded)return;
      clearTimeout(this.dataOptionTimer);
      this.dataOptionTimer=setTimeout(()=>this.syncDataOptions(),0)
    },
    async syncDataOptions() {
      if(this.dataSyncing){this.dataSyncPending=true;return}
      this.dataSyncing=true;
      do{
        this.dataSyncPending=false;
        const options={sourceMode:this.sourceMode,cameraId:this.cameraId,aircraftDatum:this.aircraftDatum,terrain:this.onlineTerrain,imagery:this.onlineMap,traffic:this.onlineTraffic,trafficRadiusNm:this.trafficRange};
        this.$emit('data-options',options);
        try{if(this.source?.dataOptions)await this.source.dataOptions(options)}
        catch(e){if(!this.disposed)this.dataMessage='Aircraft data configuration failed: '+e.message}
      }while(this.dataSyncPending&&!this.disposed);
      this.dataSyncing=false
    },
    refreshGroundTraffic() {
      if(this.report||this.props.report)return;
      const center=this.flight.live&&Number.isFinite(this.telemetry.latitude)&&Number.isFinite(this.telemetry.longitude)?{lat:this.telemetry.latitude,lon:this.telemetry.longitude}:null;
      this.groundData.pollTraffic(center).catch(e=>{if(!this.disposed)this.dataMessage=e.message});
      this.trafficReport=this.groundData.trafficSnapshot(center)
    },
    applyGroundRelay() {
      const previous=this.groundRelayUrl;
      try{this.groundRelayUrl=this.groundRelayInput.trim();this.configureGroundData();try{localStorage.setItem('yonder-ground-relay-v1',this.groundRelayUrl)}catch{};this.dataMessage=this.groundRelayUrl?'Ground relay selected':'Direct browser providers selected'}
      catch(e){this.groundRelayUrl=previous;this.dataMessage=e.message}
    },
    async importGroundFiles(kind,event) {
      const files=Array.from(event.target.files||[]);if(!files.length)return;
      this.dataBusy=true;this.dataMessage='Verifying and saving browser data…';
      try{
        const result=kind==='terrain'?await this.groundData.importTerrainPack(files):kind==='map'?await this.groundData.importOfflineMap(files):await this.groundData.importGeoid(files[0]);
        this.groundStatus=this.groundData.status();this.dataMessage=(result.title||result.id||result.model||'Data')+(kind==='geoid'?' loaded for this session':' saved in this browser');
      }catch(e){this.dataMessage='Import failed: '+e.message}
      finally{this.dataBusy=false;event.target.value=''}
    },
    async preloadGroundTerrain() {
      this.dataBusy=true;this.dataMessage='Downloading terrain from the selected ground relay into browser storage…';
      try{const result=await this.groundData.preloadTerrainPack(this.groundRelayUrl);this.groundStatus=this.groundData.status();this.dataMessage=(result.title||result.id)+' saved in this browser'}
      catch(e){this.dataMessage='Ground preload failed: '+e.message}
      finally{this.dataBusy=false}
    },
    cancelPanel() {
      this.panel = null;
      this.reviewing = null;
      this.missionOpen = false
    },
    focusDialog(ref) {
      this.previousFocus = document.activeElement;
      this.$nextTick(() => this.$refs[ref]?.querySelector('button,input,select')?.focus())
    },
    trap(event) {
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')],
        first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus()
      }
    }
  }
}
</script>
<style src="./cockpit/prototype.css"></style>
<style src="./cockpit/cockpit.css"></style>
<style scoped>
.cockpit-data-settings { border: 1px solid var(--cockpit-border, #52616e); padding: 12px; margin-bottom: 16px; min-width: 0; }
.cockpit-data-settings legend { font-weight: 700; padding: 0 6px; }
.cockpit-data-settings p { overflow-wrap: anywhere; }
</style>
