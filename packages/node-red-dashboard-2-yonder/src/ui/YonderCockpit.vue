<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<main
  class="y-cockpit"
  :data-layout="layout"
  :data-arrangement="displayConfig.arrangement"
  :data-bank-placement="bankPlacement"
  :data-mfd-open="mfdOpen||undefined"
  :data-mfd-page="mfdPage"
  :data-custom-instruments="customInstrumentSlot||undefined"
  :style="{'--cockpit-bank-count':Math.max(1,bankInstrumentConfig.length)}"
  :data-palette="palette"
  :data-fullscreen="fullscreen||undefined"
  :data-background="background"
  :data-embedded="props.embedded||undefined"
  @keydown.esc="cancelPanel"
>
  <Teleport :to="headerDocked?headerActions:'body'" :disabled="!headerDocked">
   <div class="y-cockpit cockpit-chrome" :data-palette="palette" :data-docked="headerDocked">
    <span v-if="telemetry.source?.includes('FIXTURE')" class="cockpit-fixture-label">SYNTHETIC<br>FIXTURE</span>
    <FlightControlPanel ref="flightControls" compact :snapshot="agedSnapshot" :available="canCommand" :selected-target="selectedFlightTarget" :options="preferences.display" @option="setOption" @request="({action,label})=>review(action,label)" @pick-target="pickFlightTarget"/>
    <nav class="cockpit-utilities" aria-label="Cockpit pages and display controls">
     <button class="utility-extra" @click="showFlightPlan">Flight plan</button>
     <button class="utility-display" aria-label="Display menu" @click="panel='display-menu'">Display</button>
     <button class="utility-extra cockpit-terrain-entry" aria-label="Official terrain service" @click="openOfficialTerrain">Terrain<small>{{officialTerrainCompact}}</small></button>
     <button class="utility-extra" aria-label="Aircraft and command status" @click="panel='status'">Aircraft<small>{{flight.live?(telemetry.mode||'MAVLink'):'No data'}}<template v-if="connectionStats&&Number.isFinite(connectionStats.flightHz)"> · {{connectionStats.flightHz.toFixed(1)}} Hz</template></small></button>
     <button v-if="instrumentAlerts.length" class="cockpit-alert-summary" aria-label="Show aircraft notices" @click="panel='alerts'">{{instrumentAlerts.length}} !</button>
     <button class="utility-extra cockpit-camera-toggle" aria-label="Camera view" :aria-pressed="!!cameraPath&&cameraView==='window'" :disabled="!cameraPath" @click="toggleCameraView"><span class="cockpit-camera-glyph" aria-hidden="true">⟲</span>Camera<small>{{cameraToggleState}}</small></button>
     <button class="utility-extra cockpit-fullscreen" :aria-label="fullscreen?'Exit full screen':'Enter full screen'" :title="fullscreen?'Exit full screen':'Full screen'" :aria-pressed="fullscreen" :disabled="fullscreenBusy" @click="toggleFullscreen">{{fullscreen?'↙':'⛶'}}</button>
     <button class="utility-more" aria-label="Cockpit menu" @click="panel='cockpit-menu'">Menu</button>
    </nav>
   </div>
  </Teleport>
  <FlightDataBar v-if="!customInstrumentSlot&&displayConfig.showDataBar" :items="instrumentItems" :config="topInstrumentConfig" @select="openInstrument" @update:config="setTopInstrumentConfig"/>
  <div v-if="customInstrumentSlot?preferences.display.stripPlacement==='mfd':['side','top'].includes(bankPlacement)" class="cockpit-navigation-data" aria-label="Mission and navigation instrument data">
    <slot name="instrument-strip" :telemetry="displayTelemetry" :live="flight.live">
      <InstrumentBank :items="instrumentItems" :config="bankInstrumentConfig" :placement="bankPlacement" @select="openInstrument" @update:config="setBankInstrumentConfig"/>
    </slot>
  </div>
  <div class="cockpit-body" :tabindex="mfdOpen?0:undefined" :role="mfdOpen?'region':undefined" :aria-label="mfdOpen?'PFD and MFD displays':undefined">
    <nav v-if="mfdOpen" class="cockpit-mfd-pages" aria-label="Multifunction display pages"><button v-for="page in mfdPages" :key="page.id" :aria-pressed="mfdPage===page.id" @click="openMfdPage(page.id)">{{page.label}}</button><button aria-label="Close multifunction display" @click="closeMfd">×</button></nav>
    <InstrumentBank v-if="mfdOpen&&['mfd','mfd-left'].includes(bankPlacement)" class="cockpit-mfd-bank" :items="instrumentItems" :config="bankInstrumentConfig" :placement="bankPlacement==='mfd-left'?'side':'top'" @select="openInstrument" @update:config="setBankInstrumentConfig"/>
    <section v-if="mfdOpen&&['systems','inspector'].includes(mfdPage)" class="cockpit-systems-pane" aria-label="Multifunction systems"><InstrumentationPanel :items="instrumentItems" :history="instrumentHistory" :selected-id="selectedInstrument" :bank-config="bankInstrumentConfig" :top-config="topInstrumentConfig" :view="mfdPage==='inspector'||selectedInstrument?'inspector':'systems'" @select="selectedInstrument=$event" @update:bankConfig="setBankInstrumentConfig" @update:topConfig="setTopInstrumentConfig"/><p v-if="instrumentError" class="cockpit-instrument-error" role="status">{{instrumentError}}</p></section>
    <PrimaryFlightDisplay
      ref="pfd"
      class="cockpit-primary"
      :flight="flight"
      :snapshot="agedSnapshot"
      :guidance="guidance"
      :telemetry="displayTelemetry"
      :mission="actualMission"
      :references="preferences.references"
      :options="{...preferences.display,stripPlacement:customInstrumentSlot?preferences.display.stripPlacement:'hidden',syntheticVision:onlineTerrain,menuStrip:false}"
      :home-navigation="displayConfig.homePointer?homeInfo:null"
      :reported-flight-state="reportedFlightState"
      :cdi-scale="cdiScale"
      :background-ready="backgroundReady"
      :background-label="backgroundLabel"
      :terrain-report="terrainReport"
      :camera-background="background!=='terrain'"
      :stale-label="footerStaleLabel"
      @flight-controls="openFlightControls"
      @reference="setReference"
      @option="setOption"
      @navigate="navigate"
    >
      <template #background="{pose,viewport}">
        <div class="cockpit-background">
          <!-- R-FLT-29/K-68: terrain stays mounted regardless of which
               background is chosen, so height above ground and the
               clearance forecast keep reporting while a camera fills the
               scene (design decision 9) — only `draw` changes with the
               choice: terrain paints in the window state, which is the
               `terrain` background itself, and stops in the full state.
               The picture (below) is a later sibling, so it paints over
               this on an equal z-index without either needing one. -->
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
              :draw="background==='terrain'"
              @status="terrainStatus=$event"
            />
          </slot>
          <!-- The window has its own PFD-scene layer below, so only the
               `full` state draws the picture in this background slot. -->
          <template v-if="background!=='terrain'">
            <template v-if="cameraPath">
              <!-- `reason-line` only here, not on the window's copy below:
                   the scene is the box that can show a sentence whole. See
                   `YonderPicture`'s own `reasonLine` doc comment. -->
              <YonderPicture
                :id="id+'-camera'"
                :props="cameraProps"
                :scene="true"
                :reason-line="true"
                class="cockpit-camera"
                @stale="pictureStale=$event"
                @aspect="setPictureAspect"
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
              v-else
              class="cockpit-empty-background"
            >Selected camera unavailable</div>
          </template>
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
      <template #camera-overlay>
        <!-- The window is constrained by the PFD scene itself. It must never
             use the wider cockpit grid as a positioning box when an MFD is
             adjacent or stacked beside this display. -->
        <CameraWindow
          v-if="cameraPath&&cameraView==='window'"
          :aspect="pictureAspect"
          :geometry="preferences.display.cameraWindow"
          label="CAMERA"
          :stale="pictureStale"
          @update:geometry="value=>setOption('cameraWindow',value)"
          @maximize="showCameraFull"
        >
          <!-- `unavailable-mark`, not `reason-line`: this box is too small
               for a sentence, so a window with no picture reads as one more
               instrument with no data. -->
          <YonderPicture
            :id="id+'-camera'"
            :props="cameraProps"
            :scene="true"
            :unavailable-mark="true"
            @stale="pictureStale=$event"
            @aspect="setPictureAspect"
          />
        </CameraWindow>
      </template>
    </PrimaryFlightDisplay>
    <section
      v-show="!mfdOpen||mfdPage==='mission'"
      class="cockpit-mission"
      :class="{expanded:mfdOpen&&mfdPage==='mission'}"
      aria-label="Mission inset"
    >
      <header>
        <strong>{{draft?(draftContextChanged?'DRAFT · CONTEXT CHANGED':'LOCAL DRAFT'):'AIRCRAFT MISSION'}}</strong><button
          v-if="mfdOpen"
          aria-label="Return to full PFD"
          @click="closeMfd"
        >↙</button><button
          v-else
          aria-label="Expand mission"
          @click="layout='mission'"
        >↗</button></header>
      <div class="cockpit-mission-summary">
        <div class="cockpit-mission-sequence"><b v-if="!draft&&missionProgress.activeSeq!==null">{{missionProgress.fromName||'ACTIVE'}} → {{missionProgress.activeName}}</b><b v-else>{{draft?'LOCAL DRAFT':guidance.targetName||'No active mission leg'}}</b><small v-if="!draft&&missionProgress.activeSeq!==null">{{missionProgress.nextName?'NEXT IN PLAN '+missionProgress.nextName:missionProgress.nextReason}}</small></div><span :title="guidance.reason">{{guidance.valid?fmt(guidance.distanceM/1852,2)+' NM':'Awaiting guidance'}}<template
            v-if="guidance.eteSeconds!==null&&guidance.eteSeconds!==undefined"
          > · ETE {{formatDuration(guidance.eteSeconds)}}</template></span></div>
      <NavigationDeviation v-if="layout==='mission'&&missionView==='list'" :guidance="guidance" :scale="cdiScale" />
      <div v-if="layout==='mission'" class="mission-view-tabs"><button :aria-pressed="missionView==='list'" @click="missionView='list'">Waypoints</button><button aria-label="Show terrain profile" :aria-pressed="missionView==='profile'" @click="missionView='profile'">Profile</button></div>
      <button v-if="layout==='mission'" class="mission-home-summary" aria-label="Edit mission home" @click="openHome()">HOME · {{draft?'planning':'reported'}}<span>{{shownMission.home?`${fmt(shownMission.home.lat,5)}°, ${fmt(shownMission.home.lon,5)}° · ${homeElevationLabel}`:'Not set · choose a planning home'}}</span></button>
      <div v-if="layout==='mission'&&missionView==='list'" class="mission-waypoint-head"><span>WAYPOINT</span><span>ALTITUDE / AGL</span><span>DTK / DIS</span></div>
      <MissionWaypointList v-show="layout!=='mission'||missionView==='list'" :mission="shownMission" :progress="missionProgress" :profile="missionProfile" :draft="!!draft" :options="preferences.display" :follow="preferences.display.followMission" :view-key="layout+'/'+mobileInset+'/'+missionView" @select="openMission" @pause-follow="pauseMissionFollow"/>
      <MissionPlanning :visible="layout==='mission'&&missionView==='profile'" :mission="shownMission" :official-client="officialTerrainClient" :enabled="officialTerrainEnabled" :display-provider="groundData" :display-datum="aircraftDatum" :display-enabled="onlineTerrain" :draft="!!draft" :options="preferences.display" @report="missionProfile=$event" @select="openMission"/>
      <nav><button @click="openMission(null)">Mission controls</button><button v-if="layout!=='mission'" aria-label="Open flight planning profile" @click="layout='mission';missionView='profile'">Profile</button><button v-if="!draft" aria-label="Follow active mission leg" :aria-pressed="preferences.display.followMission" @click="setOption('followMission',!preferences.display.followMission)">{{preferences.display.followMission?'Following active':'Follow active'}}</button><button
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
      v-show="!mfdOpen||mfdPage==='map'"
      class="cockpit-map-pane"
      :class="{expanded:mfdOpen&&mfdPage==='map'}"
      aria-label="Map inset"
    >
      <header><strong>MAP · TRAFFIC {{trafficRange}} NM</strong><button
          v-if="mfdOpen"
          aria-label="Return to full PFD"
          @click="closeMfd"
        >↙</button><button
          v-else
          aria-label="Expand map"
          @click="layout='map'"
        >↗</button></header>
      <YonderCockpitMap
        ref="cockpitMap"
        :data-provider="groundData"
        :snapshot="agedSnapshot"
        :mission="shownMission"
        :prediction="predicted"
        :picking="!!picking||!!flightPicking||homePicking"
        :online="onlineMap"
        :traffic="trafficReport"
        :range="trafficRange"
        :trail-seconds="trailSeconds"
        :own-trail="ownTrailDisplay"
        :now="now"
        @select="seq=>openMission({seq})"
        @location="mapLocation"
        @traffic-select="selectedTraffic=$event;panel='traffic'"
        @home-select="openHome()"
      />
      <div v-if="homePicking" class="cockpit-target-prompt" role="status">Choose home on the map · review elevation next<button @click="resumeHome()">Cancel home selection</button></div>
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
    >Detailed display forecast · {{terrainReport.forecast.level}}<small
        v-if="terrainReport.forecast.earliestWarningSeconds!==null"
      >Warning threshold in {{fmt(terrainReport.forecast.earliestWarningSeconds)}} s</small><small
        v-else-if="terrainReport.forecast.earliestCautionSeconds!==null"
      >Caution threshold in {{fmt(terrainReport.forecast.earliestCautionSeconds)}}
        s</small><small>{{terrainReport.forecast.coverage}} sampled coverage · detailed display source, independent of official terrain</small></button>
    <div
      v-if="displayError"
      class="cockpit-error"
      role="status"
    >{{displayError}}</div>
  </div>
  <nav class="cockpit-mobile-tabs"><button
      @click="mobileInset='mission'"
      :aria-pressed="mobileInset==='mission'"
    >Mission</button><button
      @click="mobileInset='map'"
      :aria-pressed="mobileInset==='map'"
    >Map</button></nav>
  <CockpitDisplaySetup v-if="panel==='display-setup'" :config="displayConfig" :flight-options="preferences.display" @option="setDisplayOption" @flight-option="setOption" @page="openMfdPage" @reset="resetDisplaySetup" @close="panel=null"/>
  <MissionTouch
    v-if="missionOpen"
    :mission="shownMission"
    :options="preferences.display"
    @option="setOption"
    :selection="selection"
    :sitl="vehicleControls"
    :busy="sending||snapshot.busy"
    :error="displayError"
    :draft="!!draft"
    :upload-status="missionUploadStatus"
    :can-undo="history.length>0"
    @close="missionOpen=false"
    @edit="edit"
    @command="missionAction"
    @flight-controls="missionFlightControls"
    @upload="reviewUpload"
    @read="sendReadAction('mission-download')"
    @home="openHome"
    @undo="undo"
    @export="exportMission"
    @use-live="draft=null;history=[];missionOpen=false"
    @pick-location="pickLocation"
    @start="review({kind:'mission-start'},'Start aircraft mission')"
  />
  <MissionHome v-if="homeOpen" :home="shownMission.home" :controller-home="snapshot.telemetry?.homePosition" :initial="homeForm" :options="preferences.display" :can-set="canCommand&&snapshot.capabilities?.homeControl?.available===true" :unavailable-reason="snapshot.capabilities?.homeControl?.reason" :external-error="homeError" :busy="sending||snapshot.busy" :operation="homeOperation" :official-client="officialTerrainClient" :terrain-enabled="officialTerrainEnabled" @close="closeHome" @save="saveHome" @pick="pickHome" @review="reviewHome"/>
  <CockpitOverlay v-if="reviewing" @escape="cancelReview">
  <div
    class="cockpit-scrim"
    @click.self="cancelReview"
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
          @click="cancelReview"
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
          <template v-if="reviewing.action.kind==='mission-upload'&&snapshot.identity?.autopilot===3">
            <div><dt>Planning home elevation</dt><dd>{{homeElevationLabel}}</dd></div>
            <div><dt>Controller home used by upload</dt><dd>{{reviewing.action.items[0].x}}°, {{reviewing.action.items[0].y}}° · {{reviewing.action.items[0].z}} m MSL</dd></div>
          </template>
          <div v-if="reviewing.action.kind==='mission-clear'">
            <dt>Removal</dt>
            <dd>{{snapshot.mission?.items?.length||0}} aircraft wire items</dd>
          </div><template v-if="reviewing.action.kind==='set-home'">
            <div><dt>New controller home</dt><dd>{{fmt(reviewing.action.home.lat,7)}}°, {{fmt(reviewing.action.home.lon,7)}}° · {{homeReviewElevation}}</dd></div>
            <div><dt>Previous controller home</dt><dd>{{reviewing.action.expectedHome?`${fmt(reviewing.action.expectedHome.lat,7)}°, ${fmt(reviewing.action.expectedHome.lon,7)}° · ${reviewing.action.expectedHome.alt} m MSL`:'Not reported'}}</dd></div>
          </template><template v-if="reviewing.action.kind==='immediate'">
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
        <p v-if="reviewing.action.kind==='set-home'">This changes the controller's return-home reference and home-relative altitude reference. In RTL or QRTL it can redirect the aircraft. The planning draft stays as authored. Yonder requests and checks home readback after acceptance.</p>
        <p v-if="reviewing.action.kind==='mission-upload'">Waypoint altitude numbers stay as authored. Above-home heights use the controller's home elevation; a different planning elevation changes the preview, not that uploaded reference.</p>
        <p>The autopilot validates and executes this request. Acceptance and observed effect are reported separately.
        </p>
        <p
          v-if="contextChanged"
          role="alert"
        >The aircraft, mission or controller home changed. Cancel and review the current state.</p>
        <div class="cockpit-actions"><button @click="cancelReview">Cancel</button><button
            class="cockpit-confirm"
            :disabled="sending||contextChanged||!canCommand"
            @click="confirmCommand"
          >Confirm & send</button></div>
      </div>
    </section>
  </div>
  </CockpitOverlay>
  <CockpitOverlay v-if="panel&&panel!=='display-setup'" @escape="panel=null">
  <div
    class="cockpit-scrim"
    @click.self="panel=null"
  >
    <section
      ref="settingsDialog"
      class="cockpit-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="panel==='display'?'Cockpit display and data sources':panelHeading"
      @keydown="trap"
    >
      <header>
        <h2>{{panelHeading}}</h2><button
          @click="panel=null"
          aria-label="Close cockpit panel"
        >×</button>
      </header>
      <div class="cockpit-dialog-body">
        <template v-if="panel==='display-menu'">
          <label>Cockpit palette<select v-model="palette" aria-label="Cockpit palette"><option value="day">Day</option><option value="night">Night</option></select></label>
          <div class="cockpit-menu-grid">
            <button aria-label="Display setup" @click="panel='display-setup'">Layout & units<small>PFD/MFD arrangement · instrument placement</small></button>
            <button @click="openPfdSettings('menu')">PFD settings<small>Instruments · references · attitude display</small></button>
            <button @click="panel='display'">Map, terrain & data<small>Background · sources · traffic · breadcrumbs</small></button>
            <button @click="openPfdSettings('director')">Flight director<small>Cue style and visibility</small></button>
          </div>
          <p>Tap a flight instrument to open its settings. Fields and Instruments select which readings are shown. App appearance is managed in Settings.</p>
        </template>
        <template v-else-if="panel==='cockpit-menu'">
          <div class="cockpit-menu-grid">
            <button @click="showFlightPlan">Flight plan</button><button @click="openHome()">Home…</button>
            <button @click="panel='display-menu'">Display</button><button @click="panel='status'">Aircraft status & telemetry</button>
            <button @click="panel=null;toggleFullscreen()">{{fullscreen?'Exit full screen':'Full screen'}}</button><button @click="panel='alerts'">Aircraft notices</button>
            <!-- R-FLT-25/R-UI-20: the same control the top row carries, for
                 the widths where the container query hides `.utility-extra`
                 (cockpit-chrome.css). Every other hidden neighbour already
                 has a row here; without this one the camera window had no
                 route at all below 600px, since the Background chooser is
                 the same one value and would need the Display panel. -->
            <button class="cockpit-menu-camera" :disabled="!cameraPath" @click="panel=null;toggleCameraView()">Camera<small>{{cameraToggleState}}</small></button>
          </div>
        </template>
        <template v-else-if="panel==='alerts'">
          <h3>Reported conditions</h3><p v-if="!instrumentAlerts.some(a=>!a.id.startsWith('status.'))">No current structured condition is reported in these readings.</p>
          <div v-for="notice in instrumentAlerts.filter(a=>!a.id.startsWith('status.'))" :key="notice.id" class="cockpit-aircraft-notice"><strong>{{notice.label}}</strong><p>{{notice.reason}}</p><button @click="openInstrument(notice.id)">Inspect reading</button></div>
          <h3>Recent aircraft messages</h3><p>These are received messages; a past message does not establish that its condition is still active.</p>
          <div v-for="notice in (snapshot.statustext||[]).slice(-15).reverse()" :key="notice.at+'-'+notice.text" class="cockpit-aircraft-notice"><strong>{{notice.text}}</strong><small>Reported severity {{notice.severity}} · {{new Date(notice.at).toLocaleTimeString()}}</small></div>
          <p v-if="!(snapshot.statustext||[]).length">No aircraft messages received.</p>
        </template>
        <template v-else-if="panel==='display'">
          <OfficialTerrainPanel
            :status="officialTerrainStatus"
            :status-error="officialTerrainError"
            :preview="officialTerrainPreview"
            :client="officialTerrainClient"
            :map-bounds="officialTerrainMapBounds"
            :mission-available="actualMission.items.length>0"
            :mission-revision="snapshot.mission?.revision||null"
            :vehicle-generation="snapshot.identity?.generation||null"
            @status="ingestOfficialTerrainStatus"
            @preview="officialTerrainPreview=$event"
            @request-map-bounds="captureOfficialTerrainBounds"
          />
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
            <label v-if="sourceMode==='ground'">Optional ADS-B relay origin<input v-model="trafficRelayInput" type="url" placeholder="https://ground.example" aria-label="ADS-B relay origin" /></label>
            <button v-if="sourceMode==='ground'" @click="applyTrafficRelay">Apply ADS-B relay</button>
            <p v-if="sourceMode==='ground'">An ADS-B relay changes only traffic sourcing. Imagery and terrain keep their selected connection. Leave it blank to use the general ground relay or direct ADSB.lol access.</p>
            <button @click="panel='status'">Telemetry rate & connection details</button>
            <p v-if="connectionStats">Flight payload {{fmt(connectionStats.flightBytes)}} bytes · instrumentation {{fmt(connectionStats.instrumentBytes)}} bytes at up to 1 Hz · received JSON {{fmt(connectionStats.bytesPerSecond/1024,1)}} KiB/s. Mission transfers {{connectionStats.missionTransfers}}; detail transfers {{connectionStats.detailsTransfers}}. Excludes HTTP overhead, video and public data.</p>
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
          <label>Background<select v-model="background">
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
          <p v-if="terrainReport.forecast"><strong>Detailed display forecast.</strong> {{terrainReport.forecast.reason}}. Minimum ground / mapped-surface clearance:
            {{fmt(terrainReport.forecast.minimumGroundClearanceM)}} /
            {{fmt(terrainReport.forecast.minimumSurfaceClearanceM)}} m. Closure:
            {{fmt(terrainReport.forecast.closureMps,1)}} m/s. Checked
            {{fmt(terrainReport.forecast.evaluatedUntilSeconds)}} of {{fmt(terrainReport.forecast.lookaheadSeconds)}}
            seconds, {{terrainReport.forecast.samples}} samples. Sampled corridor ±20 m; 30 m warning / 90 m caution.
            This uses the verified detailed display datum independently of official controller terrain. It extrapolates measured track, speed and climb; it does not predict autopilot turns.</p>
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
          <div class="cockpit-menu-grid"><button @click="openFlightControls('modes')">Modes</button><button @click="openFlightControls('arm')">Arm / Disarm</button></div>
          <TelemetrySettings :rate="telemetryRate" :stats="connectionStats" :can-request="canCommand&&!sending" @rate="telemetryRate=$event" @request="sendReadAction('stream-setup')"/>
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
          <div class="cockpit-actions"><button @click="showFlightPlan">Flight plan · read or upload mission</button></div>
          <article
            v-for="entry in operationReports"
            :key="entry.op.id"
          ><b>{{entry.display.title}}</b>
            <p>{{entry.display.detail}}</p>
            <details><summary>Technical details</summary>
              <p>Operation {{entry.op.id}} · {{entry.op.state}}</p>
              <p v-if="entry.protocol">{{entry.protocol.family}} · command {{entry.protocol.command}} · result {{entry.protocol.code}}</p>
              <p>{{entry.op.message}}</p><small>{{entry.op.effect?.message}}</small>
            </details>
          </article>
        </template>
      </div>
    </section>
  </div>
  </CockpitOverlay>
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
import CockpitOverlay from './cockpit/CockpitOverlay.vue';
import CockpitDisplaySetup from './cockpit/CockpitDisplaySetup.vue';
import InstrumentBank from './cockpit/instruments/InstrumentBank.vue';
import FlightDataBar from './cockpit/instruments/FlightDataBar.vue';
import InstrumentationPanel from './cockpit/instruments/InstrumentationPanel.vue';
import {defaultBankConfig,defaultTopConfig,validateInstrumentSlots,restoreBankConfig} from './cockpit/instruments/instrument-settings';
import {cockpitDisplaySettings} from './cockpit/cockpit-display-settings.mjs';
import {homeNavigation,navigationItems,instrumentationItems,missingInstrumentItems,instrumentationAlerts,formatDuration,rescaleInstrumentSlots,gimbalOrientationItems,fenceStatusItems} from './cockpit/instrumentation-view.mjs';
import MissionWaypointList from './cockpit/MissionWaypointList.vue';
import MissionPlanning from './cockpit/MissionPlanning.vue';
import {missionSequence} from './cockpit/mission-sequence.mjs';
import { markRaw } from 'vue'
import { createGroundDataProvider } from './cockpit/ground-data.mjs'
import {
  validateCameraCalibration
} from 'yonder-core/terrain'
import coveDemo from './cockpit/data/cove-demo.json'
import coveVtolDemo from './cockpit/data/cove-vtol-demo.mjs'
import CameraTerrainOverlay from './cockpit/CameraTerrainOverlay.vue'
import CameraWindow from './cockpit/CameraWindow.vue'
import { cameraViewFor } from './cockpit/camera-view.mjs'
import TrafficVision from './cockpit/TrafficVision.vue'
import TerrainVision from './cockpit/TerrainVision.vue'
import TelemetryStrip from './cockpit/TelemetryStrip.vue'
import NavigationDeviation from './cockpit/NavigationDeviation.vue'
import PrimaryFlightDisplay from './cockpit/PrimaryFlightDisplay.vue'
import FlightControlPanel from './cockpit/FlightControlPanel.vue'
import MissionTouch from './cockpit/MissionTouch.vue'
import MissionHome from './cockpit/MissionHome.vue'
import {controllerHomeRequest,sameHome} from './cockpit/mission-home.mjs'
import {unitText} from './cockpit/flight-units.mjs'
import TelemetrySettings from './cockpit/TelemetrySettings.vue'
import {operationPresentation,operationProtocol} from './cockpit/operation-presentation.mjs'
import {defaultTelemetryRate,telemetryRates,telemetryPollDelay,cockpitRequestId} from './cockpit/telemetry-cadence.mjs'
import YonderCockpitMap from './cockpit/YonderCockpitMap.vue'
import OwnTrailSettings from './cockpit/OwnTrailSettings.vue'
import OfficialTerrainPanel from './cockpit/OfficialTerrainPanel.vue'
import {createOfficialTerrainClient} from './cockpit/official-terrain-client.mjs'
import {terrainStatusView} from './cockpit/official-terrain-state.mjs'
import {officialTerrainAgl} from './cockpit/official-terrain-datum.mjs'
import {selectOwnTrail,trailPreferences} from './cockpit/own-trail.mjs'
import YonderPicture from './YonderPicture.vue'
import {
  agedTelemetry,
  flightView,
  fmt,
  prediction,
  aircraftMapPosition,
  aircraftPositionMessage,
  aircraftMission,
  missionWire,
  missionUploadReadiness,
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
  provide(){return {cockpitPalette:()=>this.palette}},
  components: {
    CockpitOverlay,
    CockpitDisplaySetup,InstrumentBank,FlightDataBar,InstrumentationPanel,
    MissionWaypointList,MissionPlanning,
    TelemetryStrip,
    NavigationDeviation,
    CameraTerrainOverlay,
    CameraWindow,
    TrafficVision,
    PrimaryFlightDisplay,
    FlightControlPanel,
    MissionTouch,
    MissionHome,
    TelemetrySettings,
    YonderCockpitMap,
    OwnTrailSettings,
    OfficialTerrainPanel,
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
    },
    terrainServiceClient: { type: Object, default: null }
  },
  data() {
    return {
      snapshot: this.report || this.props.report || empty(),
      layout: 'full',viewportWidth:1200,windowWidth:1200,
      displayConfig:cockpitDisplaySettings(),bankInstrumentConfig:defaultBankConfig(),topInstrumentConfig:defaultTopConfig(),
      instrumentation:null,instrumentReceivedAt:Date.now(),instrumentTimer:null,instrumentBusy:false,instrumentError:'',selectedInstrument:null,instrumentHistory:{},
      mfdPages:[{id:'map',label:'Map'},{id:'mission',label:'Flight plan'},{id:'systems',label:'Systems'},{id:'inspector',label:'Telemetry'}],
      palette: 'night',fullscreen:false,fullscreenBusy:false,
      mobileInset: 'map',
      preferences: validatePfdPreferences(),
      // R-FLT-29/K-68: which camera-type background the operator last
      // chose, so the Camera control's flip back out of the window
      // returns to the one they picked rather than always to plain
      // `camera`. The state itself is `preferences.display.background`
      // (the `background` computed below); this is only the memory of a
      // value that is currently `terrain`.
      cameraBackgroundChoice: 'camera',
      onlineTerrain: false,
      onlineMap: false,
      onlineTraffic: false,
      groundData: markRaw(this.dataProvider || createGroundDataProvider()),
      sourceMode: 'ground',
      groundRelayUrl: '',
      groundRelayInput: '',
      trafficRelayUrl: '',
      trafficRelayInput: '',
      groundStatus: {},
      dataMessage: '',
      dataBusy: false,
      hydratingOptions: false,
      editedOptions: {},
      dataOptionTimer: null,
      dataSyncing: false,
      dataSyncPending: false,
      telemetryRate: defaultTelemetryRate,
      headerActions:null,headerActive:true,
      homeOpen:false,homePicking:false,homeForm:null,homeReturnLayout:'full',homeError:'',
      connectionStats: null,
      trafficReport: {
        tracks: [],
        message: 'Traffic feed off'
      },
      cameraId: null,
      // R-FLT-29/K-68: `YonderPicture`'s own `stale` payload, from whichever
      // instance is currently mounted (full scene or the window) — there is
      // only ever one at a time, so one field covers both (design decision
      // 11: the age moves between the footer label and the window header,
      // it does not appear in both).
      pictureStale: { seconds: 0, text: '' },
      // `YonderPicture` starts from a safe 16:9 layout then reports video
      // metadata or a loaded still's intrinsic ratio through `@aspect`.
      pictureAspect: 16 / 9,
      aircraftDatum: 'UNKNOWN',
      calibrationCandidate: null,
      trafficRange: 10,
      trailSeconds: 120,
      ownTrailOptions:trailPreferences(),
      ownTrailCleared:null,
      optionsLoaded: false,
      selectedTraffic: null,
      terrainStatus: null,
      officialTerrainClient:null,officialTerrainStatus:null,officialTerrainError:'',officialTerrainPreview:null,officialTerrainMapBounds:null,
      officialTerrainSample:null,officialTerrainSampleAt:0,officialTerrainSamplePoint:null,officialTerrainSampleVehicle:null,officialTerrainSampleBusy:false,officialTerrainSampleGeneration:0,
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
      missionView: 'list',missionProfile: null,
      draft: null,
      draftContext: null,
      history: [],
      picking: null,
      flightPicking: null,
      reviewing: null,
      pendingOperationId: null,
      sending: false,
      error: '',operationNotice:null,
      pollError: null,
      predictionMode: 'time',
      predictionSeconds: 30,
      predictionDistance: 1000,
      cdiScale: 250,
      previousFocus: null
    }
  },
  computed: {
    operationReports(){return [...(this.snapshot.operations||[])].reverse().map(op=>({op,display:operationPresentation(op,this.snapshot),protocol:operationProtocol(op)}))},
    displayError(){
      if(this.operationNotice?.message!==this.error)return this.error;
      const op=this.snapshot.operations?.find(o=>o.id===this.operationNotice.id&&(!o.vehicleGeneration||o.vehicleGeneration===this.snapshot.identity?.generation));
      return op?operationPresentation(op,this.snapshot).text:'';
    },
    panelHeading(){return ({'display-menu':'Display','cockpit-menu':'Cockpit menu',alerts:'Aircraft notices',display:'Map, terrain & data',traffic:'Traffic display',trail:'Aircraft breadcrumb settings','draft-conflict':'Draft context changed'})[this.panel]||'Aircraft status'},
    headerDocked(){return this.headerActive&&!this.fullscreen&&this.headerActions?.isConnected===true&&this.windowWidth>=600},
    customInstrumentSlot(){return !!this.$slots['instrument-strip']},
    bankPlacement(){return this.customInstrumentSlot?'top':this.displayConfig.bankPlacement==='side'&&this.viewportWidth<960?'top':this.displayConfig.bankPlacement},
    mfdOpen(){return this.displayConfig.arrangement!=='single'||this.layout!=='full'},
    mfdPage(){return this.layout==='full'?'map':this.layout},
    instrumentItems(){
      const nav=navigationItems(this.snapshot,this.guidance,this.terrainReport,{...this.preferences.display,distanceUnit:this.displayConfig.distanceUnit},this.elapsed);
      const observed=instrumentationItems(this.snapshot,this.instrumentation||this.snapshot.instruments||{},{elapsedMs:Math.max(0,this.now-this.instrumentReceivedAt)});
      const ids=new Set(observed.map(i=>i.id));const response=this.connectionStats,latency={id:'link.httpResponseMs',label:'Browser to Yonder response time',shortLabel:'HTTP RESPONSE',category:'Links & controls',value:response?.flightResponseMs??null,unit:'ms',kind:'horizontal',min:0,max:1000,available:Number.isFinite(response?.flightResponseMs)&&response.flightResponseAgeMs<5000,ageMs:response?.flightResponseAgeMs??null,source:'Browser flight request round trip',quality:'calculated',reason:'Includes server processing and both network directions; not flight-controller command latency'};const all=[...observed,...gimbalOrientationItems(observed),...fenceStatusItems(observed),latency,...nav.filter(i=>!ids.has(i.id))];return [...all,...missingInstrumentItems(all)];
    },
    instrumentAlerts(){return instrumentationAlerts(this.instrumentItems,this.snapshot)},
    reportedFlightState(){return this.instrumentItems.filter(i=>['flight.vtolState','flight.landedState'].includes(i.id)&&i.available).map(i=>i.value).join(' · ')},
    homeInfo(){const home=homeNavigation(this.snapshot,this.elapsed),label=this.instrumentItems.find(i=>i.id==='nav.homeDistance');return {...home,label:label?.available?`${label.value.toFixed(2)} ${label.unit}`:'—'}},
    missionProgress(){return missionSequence(this.agedSnapshot)},
    missionUploadStatus(){return missionUploadReadiness(this.snapshot)},
    homeElevationLabel(){return unitText(this.shownMission.home?.alt,this.preferences.display.altitudeUnit||'ft')+' MSL'},
    homeReviewElevation(){return unitText(this.reviewing?.action.home?.alt,this.homeForm?.altitudeUnit||this.preferences.display.altitudeUnit||'ft')+' MSL ('+fmt(this.reviewing?.action.home?.alt,2)+' m)'},
    homeOperation(){return this.snapshot.operations?.filter(op=>op.action?.kind==='set-home'&&op.vehicleGeneration===this.snapshot.identity?.generation).at(-1)||null},
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
      const display=this.terrainStatus || this.snapshot.terrain || {
        state: 'unavailable',
        message: 'Terrain data unavailable · conventional horizon'
      },official=this.officialTerrainAglReport;
      return {...display,groundElevationM:official.available?official.groundElevationM:null,estimatedAglM:official.available?official.estimatedAglM:null,officialTerrain:official}
    },
    officialTerrainEnabled(){return !!(this.officialTerrainStatus?.policy||this.officialTerrainStatus?.sourcePolicy)?.enabled},
    officialTerrainAglReport(){
      const age=this.now-this.officialTerrainSampleAt,vehicle=this.snapshot.identity?.generation||null,point=aircraftMapPosition(this.telemetry),sampled=this.officialTerrainSamplePoint;
      if(!this.officialTerrainEnabled)return {available:false,reason:this.officialTerrainStatus?'official-terrain-service-disabled':'official-terrain-status-unavailable',groundElevationM:null,estimatedAglM:null};
      if(!this.officialTerrainSample||age>5000||this.officialTerrainSampleVehicle!==vehicle)return {available:false,reason:this.officialTerrainSample?'official-terrain-sample-stale':'official-terrain-sample-unavailable',groundElevationM:null,estimatedAglM:null};
      const longitudeDelta=point&&sampled?Math.min(Math.abs(point.lon-sampled.lon),360-Math.abs(point.lon-sampled.lon)):Infinity;
      if(!point||!sampled||Math.abs(point.lat-sampled.lat)>.0005||longitudeDelta>.0005)return {available:false,reason:'official-terrain-sample-position-stale',groundElevationM:null,estimatedAglM:null};
      return officialTerrainAgl(this.officialTerrainSample,this.telemetry);
    },
    officialTerrainCompact(){
      const view=terrainStatusView(this.officialTerrainStatus);
      if(this.officialTerrainError&&!this.officialTerrainStatus)return 'Unavailable';
      if(!this.officialTerrainStatus)return 'Checking';
      if(!(this.officialTerrainStatus.policy||this.officialTerrainStatus.sourcePolicy)?.enabled)return 'Disabled';
      if(this.officialTerrainStatus.service?.compatible===false)return view.service.tone==='warning'?'Needs refresh':'Incompatible';
      if((this.officialTerrainStatus.service?.missing||0)>0)return `${this.officialTerrainStatus.service.missing} missing`;
      if((this.officialTerrainStatus.service?.sent||0)>0)return `${this.officialTerrainStatus.service.sent} sent`;
      return view.service.tone==='danger'?'Fault':'Waiting';
    },
    // R-FLT-29/K-68: the PFD's background is a stored display preference
    // (the design promises the state survives a reload), and it is the only
    // value that says which of the camera's two presentations is showing.
    // Writable so `v-model` on the Background chooser and the plain
    // assignments elsewhere keep reading as they always did; the setter is
    // `setOption`, which validates and persists like every other preference.
    background: {
      get() { return this.preferences.display.background },
      set(value) { this.setOption('background', value) }
    },
    // With the window showing, the *scene* is synthetic terrain — and the
    // window shows exactly when the background is `terrain`, so both facts
    // below are the plain background test again.
    backgroundReady() {
      return this.background === 'terrain'
        ? this.terrainReport.state === 'ready' : !!this.cameraPath
    },
    backgroundLabel() {
      return this.background === 'terrain'
        ? (this.terrainReport.message || 'Synthetic terrain') : (this.cameraPath ? (
        this.snapshot.camera?.name || 'Selected camera') : 'Camera unavailable')
    },
    // R-FLT-29/K-68: `full` or `window`, derived from the background and
    // never stored beside it — see `camera-view.mjs`'s own doc comment on
    // `cameraViewFor` for the third state two independent values reached.
    // The top-row control and the Display panel's Background chooser are two
    // ways to move the same one value, which is what the design's Behaviour
    // section says they are.
    cameraView() {
      return cameraViewFor(this.background)
    },
    // Design's own states table, verbatim, for the button's second line.
    cameraToggleState() {
      if (!this.cameraPath) return 'unavailable'
      return this.cameraView === 'window' ? 'Window · tap for full' : 'Full · tap for window'
    },
    // R-VID-03/design decision 11: the age lives in the footer label only
    // while the picture is filling the scene by itself (full) and actually
    // mounted (`cameraPath`) — the window carries its own copy in its own
    // header instead, never both at once.
    footerStaleLabel() {
      return (this.cameraView === 'full' && this.cameraPath && this.pictureStale.seconds > 0)
        ? this.pictureStale.text : ''
    },
    // R-FLT-29/K-68: is a `YonderPicture` mounted at all? Both presentations
    // need a configured camera; the scene one also needs a camera-type
    // background. The watcher below clears the last reported age when this
    // goes false, so a count from a picture that is gone can never be read
    // as the age of whatever replaced it (I3 of the whole-branch review).
    picturePresent() {
      return !!this.cameraPath && (this.cameraView === 'window' || this.background !== 'terrain')
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
        .revision !== (this.snapshot.mission?.revision || null) || (this.reviewing.action.kind==='set-home'&&!sameHome(this.reviewing.action.expectedHome,this.snapshot.telemetry?.homePosition??null)))
    },
    vehicleControls() {
      const last = this.snapshot.operations?.at(-1);
      return {
        available: this.canCommand,
        unavailableReason: this.snapshot._detailsReady === false
          ? 'Aircraft details are refreshing. Flight controls return when the current details arrive.' : null,
        connected: this.snapshot.connected,
        mode: this.telemetry.mode,
        armed: this.telemetry.armed,
        busy: this.snapshot.busy,
        modes: (this.snapshot.capabilities?.modes || []).map(m => m.name),
        immediateCommands: this.snapshot.capabilities?.commands || [],
        lastResult: last ? {
          state: operationPresentation(last,this.snapshot).title,
          message: operationPresentation(last,this.snapshot).detail,
          ok:!['rejected','failed','unknown'].includes(last.state)
        } : null
      }
    }
  },
  watch: {
    // R-FLT-29/K-68: see `cameraBackgroundChoice` and `picturePresent`.
    background(value) { if (value !== 'terrain') this.cameraBackgroundChoice = value },
    picturePresent(value) { if (!value) this.pictureStale = { seconds: 0, text: '' } },
    cameraPath () { this.pictureAspect = 16 / 9 },
    headerDocked(){this.$nextTick(this.fitViewport)},
    telemetryRate(value){if(telemetryRates.includes(value))try{localStorage.setItem('yonder-telemetry-rate-v1',String(value))}catch{}},
    palette(value) { if(['day','night'].includes(value)){try{localStorage.setItem('yonder-cockpit-palette-v1',value)}catch{}} },
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
    this.headerActions=markRaw(document.querySelector('#app-bar-actions')||{});
    this.$nextTick(() => {
      this.fitViewport();
      if (typeof ResizeObserver !== 'undefined') {
        this.viewportObserver = new ResizeObserver(() => this.fitViewport());
        this.viewportObserver.observe(this.$el.parentElement)
      }
    });
    window.addEventListener('resize', this.fitViewport);
    document.addEventListener('fullscreenchange', this.fullscreenChanged);
    document.addEventListener('keydown', this.lostFocusEscape);
    if (this.report || this.props.report) this.ingest(this.report || this.props.report);
    this.source = this.api || (!this.report && !this.props.report ? createCockpitApi() : null);
    this.officialTerrainClient=markRaw(this.terrainServiceClient||createOfficialTerrainClient());
    this.officialTerrainClient.start(({status,error})=>{if(this.disposed)return;if(status)this.ingestOfficialTerrainStatus(status);else if(error){this.officialTerrainStatus=null;this.clearOfficialTerrainSample();this.officialTerrainError=error.message}});
    this.$el.setAttribute('data-mobile-inset', this.mobileInset);
    this.groundData.refreshOffline().then(()=>{ if(!this.disposed)this.groundStatus=this.groundData.status() }).catch(e=>{this.dataMessage='Browser storage unavailable: '+e.message});
    try {
      const palette=localStorage.getItem('yonder-cockpit-palette-v1');
      const rate=Number(localStorage.getItem('yonder-telemetry-rate-v1'));
      if(telemetryRates.includes(rate))this.telemetryRate=rate;
      if(['day','night'].includes(palette))this.palette=palette;
      const saved = JSON.parse(localStorage.getItem('yonder-cockpit-v1') || 'null');
      if (saved) this.preferences = validatePfdPreferences(saved)
      const instruments=JSON.parse(localStorage.getItem('yonder-instrument-layout-v1')||'null');
      if(instruments){this.displayConfig=cockpitDisplaySettings(instruments.display);this.bankInstrumentConfig=restoreBankConfig(instruments.bank);this.topInstrumentConfig=validateInstrumentSlots(instruments.top,defaultTopConfig())}
      const trail=JSON.parse(localStorage.getItem('yonder-own-trail-v1')||'null');
      if(trail){this.ownTrailOptions=trailPreferences(trail.options);this.ownTrailCleared=trail.cleared}
      const relay=localStorage.getItem('yonder-ground-relay-v1');
      if(relay){this.groundRelayInput=relay;this.applyGroundRelay()}
      const trafficRelay=localStorage.getItem('yonder-traffic-relay-v1');
      if(trafficRelay){this.trafficRelayInput=trafficRelay;this.applyTrafficRelay()}
    } catch {}
    this.source?.setTrailOptions?.(this.ownTrailOptions);
    this.timer = setInterval(() => {
      this.now = Date.now();
      this.connectionStats=this.source?.stats?.()||null;
      this.refreshGroundTraffic();
      this.groundStatus=this.groundData.status()
    }, 200);
    if (this.source?.state && !this.report && !this.props.report) this.poll();
    if(this.snapshot.instruments)this.instrumentReceivedAt=Date.now();
    if(this.source?.instruments&&!this.report&&!this.props.report)this.pollInstruments();
    this.instrumentTimer=setInterval(()=>{if(this.source?.instruments&&!this.report&&!this.props.report)this.pollInstruments();this.recordInstrumentHistory()},1000)
  },
  activated(){this.headerActive=true},
  deactivated(){this.headerActive=false;this.cancelPanel();this.$refs.flightControls?.close();this.$refs.pfd?.close()},
  beforeUnmount() {
    this.viewportObserver?.disconnect();
    window.removeEventListener('resize', this.fitViewport);
    document.removeEventListener('fullscreenchange', this.fullscreenChanged);
    document.removeEventListener('keydown', this.lostFocusEscape);
    this.disposed = true;
    clearInterval(this.timer);
    clearInterval(this.instrumentTimer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.dataOptionTimer);
    this.source?.close?.();
    this.officialTerrainClient?.stop?.();
    this.groundData.close()
  },
  methods: {
    formatDuration,
    openOfficialTerrain(){this.panel='display';this.$nextTick(this.captureOfficialTerrainBounds)},
    captureOfficialTerrainBounds(){
      const map=this.$refs.cockpitMap?.map,bounds=map?.getBounds?.();
      if(bounds)try{
        const candidate={south:Number(bounds.getSouth()),north:Number(bounds.getNorth()),west:Number(bounds.getWest()),east:Number(bounds.getEast())};
        if(Object.values(candidate).every(Number.isFinite)&&candidate.south>=-90&&candidate.north<=90&&candidate.west>=-180&&candidate.west<=180&&candidate.east>=-180&&candidate.east<=180&&candidate.south<candidate.north&&candidate.west!==candidate.east){this.officialTerrainMapBounds=candidate;return}
      }catch{}
      if(this.officialTerrainMapBounds)return;
      const point=aircraftMapPosition(this.telemetry);
      if(point)this.officialTerrainMapBounds={south:Math.max(-89.99,point.lat-.025),north:Math.min(89.99,point.lat+.025),west:Math.max(-180,point.lon-.025),east:Math.min(180,point.lon+.025)};
    },
    clearOfficialTerrainSample(){this.officialTerrainSampleGeneration++;this.officialTerrainSample=null;this.officialTerrainSampleAt=0;this.officialTerrainSamplePoint=null;this.officialTerrainSampleVehicle=null;this.officialTerrainSampleBusy=false},
    ingestOfficialTerrainStatus(status){this.officialTerrainStatus=status;this.officialTerrainError='';if(!this.officialTerrainEnabled)this.clearOfficialTerrainSample();else void this.sampleOfficialOwnship()},
    async sampleOfficialOwnship(){
      const point=aircraftMapPosition(this.telemetry),vehicle=this.snapshot.identity?.generation||null;
      if(!this.officialTerrainEnabled||!point){this.clearOfficialTerrainSample();return}
      if(this.officialTerrainSampleBusy)return;const token=++this.officialTerrainSampleGeneration;
      this.officialTerrainSampleBusy=true;
      try{const response=await this.officialTerrainClient.samples([point]);if(!this.disposed&&this.officialTerrainEnabled&&token===this.officialTerrainSampleGeneration&&vehicle===(this.snapshot.identity?.generation||null)){this.officialTerrainSample=response?.samples?.[0]||{available:false,reason:'official-terrain-response-mismatch'};this.officialTerrainSamplePoint=point;this.officialTerrainSampleVehicle=vehicle;this.officialTerrainSampleAt=Date.now()}}
      catch(error){if(!this.disposed&&this.officialTerrainEnabled&&token===this.officialTerrainSampleGeneration){this.officialTerrainSample={available:false,reason:error?.message||'official-terrain-sample-failed'};this.officialTerrainSamplePoint=point;this.officialTerrainSampleVehicle=vehicle;this.officialTerrainSampleAt=Date.now()}}
      finally{if(token===this.officialTerrainSampleGeneration)this.officialTerrainSampleBusy=false}
    },
    fullscreenChanged(){if(this.disposed)return;this.fullscreen=document.fullscreenElement===this.$el;this.$nextTick(this.fitViewport)},
    async toggleFullscreen(){
      if(this.fullscreenBusy)return;this.fullscreenBusy=true;
      try{
        if(document.fullscreenElement===this.$el)await document.exitFullscreen();
        else if(typeof this.$el?.requestFullscreen==='function')await this.$el.requestFullscreen({navigationUI:'hide'});
        else {this.error='Full screen is not available in this browser.';return}
        this.fullscreenChanged();
      }catch{if(!this.disposed)this.error='Full screen was blocked by the browser. Try the Full screen button again.'}
      finally{this.fullscreenBusy=false}
    },
    persistInstruments(){try{localStorage.setItem('yonder-instrument-layout-v1',JSON.stringify({display:this.displayConfig,bank:this.bankInstrumentConfig,top:this.topInstrumentConfig}))}catch{this.instrumentError='Layout could not be saved; it remains active for this session'}},
    setDisplayOption(key,value){const previous=this.instrumentItems;this.displayConfig=cockpitDisplaySettings({...this.displayConfig,[key]:value});if(key==='arrangement'&&value==='single')this.layout='full';if(key==='distanceUnit')this.rescaleInstrumentUnits(previous);this.persistInstruments();this.$nextTick(this.fitViewport)},
    resetDisplaySetup(){this.displayConfig=cockpitDisplaySettings();this.bankInstrumentConfig=defaultBankConfig();this.topInstrumentConfig=defaultTopConfig();this.layout='full';this.persistInstruments()},
    setBankInstrumentConfig(config){this.bankInstrumentConfig=validateInstrumentSlots(config,defaultBankConfig());this.persistInstruments()},
    setTopInstrumentConfig(config){this.topInstrumentConfig=validateInstrumentSlots(config,defaultTopConfig());this.persistInstruments()},
    openMfdPage(page){if(!['map','mission','systems','inspector'].includes(page))return;if(page==='systems')this.selectedInstrument=null;this.layout=page;this.panel=null;this.$nextTick(()=>{this.fitViewport();const body=this.$el?.querySelector('.cockpit-body'),pages=this.$el?.querySelector('.cockpit-mfd-pages');if(body&&pages)body.scrollTop=pages.offsetTop})},
    closeMfd(){this.layout='full';this.displayConfig=cockpitDisplaySettings({...this.displayConfig,arrangement:'single'});this.persistInstruments();this.$nextTick(this.fitViewport)},
    openInstrument(id){if(id.startsWith('status.')){this.panel='alerts';return}this.openMfdPage('systems');this.selectedInstrument=id},
    async pollInstruments(){if(this.instrumentBusy||this.disposed)return;this.instrumentBusy=true;const started=Date.now();try{const value=await this.source.instruments();if(!this.disposed){this.instrumentation=value;this.instrumentReceivedAt=started;this.instrumentError=value.truncated?`${value.truncated} additional readings omitted by the bounded telemetry transfer`:''}}catch(e){if(!this.disposed)this.instrumentError=e.message||'Instrumentation unavailable'}finally{this.instrumentBusy=false}},
    recordInstrumentHistory(){if(this.disposed)return;const now=Date.now(),items=this.instrumentItems,byId=new Map(items.map(i=>[i.id,i])),keys=[...new Set([this.selectedInstrument,...this.bankInstrumentConfig.map(s=>s.id),...this.topInstrumentConfig.map(s=>s.id),...items.map(i=>i.id)])].filter(Boolean).slice(0,256);for(const key of keys){const item=byId.get(key);if(!item||(typeof item.value!=='number'&&!this.instrumentHistory[key]))continue;const series=this.instrumentHistory[key]||[];series.push({t:now,v:item.available&&Number.isFinite(item.value)?item.value:null});this.instrumentHistory[key]=series.filter(p=>now-p.t<=180000).slice(-180)}for(const key of Object.keys(this.instrumentHistory))if(!keys.includes(key))delete this.instrumentHistory[key]},
    saveOwnTrail(){try{localStorage.setItem('yonder-own-trail-v1',JSON.stringify({options:this.ownTrailOptions,cleared:this.ownTrailCleared}))}catch{this.error='Trail preferences could not be saved; this session still works'}},
    setOwnTrailOptions(options){this.ownTrailOptions=trailPreferences(options);this.source?.setTrailOptions?.(this.ownTrailOptions);this.saveOwnTrail()},
    clearOwnTrail(){const trail=this.snapshot.ownTrail;if(trail)this.ownTrailCleared={epoch:trail.epoch,after:trail.latest};this.saveOwnTrail()},
    restoreOwnTrail(){this.ownTrailCleared=null;this.saveOwnTrail()},
    fitViewport() {
      this.windowWidth=window.innerWidth;
      if(this.$el?.clientWidth)this.viewportWidth=this.$el.clientWidth;
      if(this.$el&&document.fullscreenElement===this.$el){this.$el.style.setProperty('--cockpit-height',window.innerHeight+'px');return}
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
    pauseMissionFollow(){if(this.preferences.display.followMission)this.setOption('followMission',false)},
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
      if((this.snapshot.identity?.generation??null)!==(value.identity?.generation??null))this.instrumentHistory={};
      this.snapshot = value.ownTrail?{...value,ownTrail:markRaw(value.ownTrail)}:value;
      this.receivedAt = Date.now();
      if(value.instruments){this.instrumentation=value.instruments;this.instrumentReceivedAt=this.receivedAt}
      if(this.pendingOperationId){
        const operation=value.operations?.find(op=>op.id===this.pendingOperationId);
        if(operation){this.error=operationPresentation(operation,value).text;this.operationNotice={id:operation.id,message:this.error};if(['observed','accepted','rejected','failed','unknown'].includes(operation.state))this.pendingOperationId=null}
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
      const started=performance.now();
      try {
        const state = await this.source.state();
        if (this.error === this.pollError) this.error = '';
        this.pollError = null;
        this.ingest(state)
      } catch (e) {
        this.pollError = e.name === 'AbortError' ? 'Telemetry request timed out' : e.message;
        this.error = this.pollError
      } finally {
        if (!this.disposed) this.pollTimer = setTimeout(() => this.poll(), telemetryPollDelay(this.telemetryRate,performance.now()-started))
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
    rescaleInstrumentUnits(previous){this.bankInstrumentConfig=rescaleInstrumentSlots(this.bankInstrumentConfig,previous,this.instrumentItems);this.topInstrumentConfig=rescaleInstrumentSlots(this.topInstrumentConfig,previous,this.instrumentItems);this.instrumentHistory={};this.persistInstruments()},
    setOption(key, value) {
      const previous=this.instrumentItems;
      if(key==='stripPlacement'&&!this.customInstrumentSlot){this.setDisplayOption('bankPlacement',({pfd:'side',mfd:'top',hidden:'hidden'})[value]||'side')}
      if(['altitudeUnit','speedUnit','verticalSpeedUnit'].includes(key))this.instrumentHistory={};
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
      this.persist();
      if(['altitudeUnit','speedUnit','verticalSpeedUnit'].includes(key))this.rescaleInstrumentUnits(previous)
    },
    setPictureAspect (value) {
      if (Number.isFinite(value) && value > 0) this.pictureAspect = value
    },
    // R-FLT-29/K-68: the camera fills the scene. The window's own maximize
    // control and the top-row Camera control both arrive here, and both
    // move the one stored value — the background — back to whichever
    // camera-type background the operator last chose. Guarded on a
    // configured camera, alongside the button's own `:disabled`: never a
    // control that does something when it reads unavailable. Nothing here
    // touches a stream or the aircraft (R-CMD-04, R-CMD-05).
    showCameraFull() {
      if (!this.cameraPath) return
      this.background = this.cameraBackgroundChoice
    },
    // The top-row Camera control, one tap each way (design decision 7).
    toggleCameraView() {
      if (!this.cameraPath) return
      if (this.cameraView === 'window') this.showCameraFull()
      else this.background = 'terrain'
    },
    navigate(target) {
      if(target==='instrument-layout'){this.panel='display-setup';return}
      if(target==='instruments'){this.openMfdPage('systems');return}
      if(['mission','waypoints'].includes(target)){this.showFlightPlan();return}
      if(target==='direct'){this.openFlightControls('direct');return}
      if (target === 'display' || target === 'settings') {
        this.panel = 'display-menu';
        return
      }
      if(target==='sources'){this.panel='display';return}
      if (target === 'status') {
        this.panel = 'status';
        return
      }
      this.layout = 'mission';
      this.openMission(null)
    },
    showFlightPlan(){this.panel=null;this.missionOpen=false;this.openMfdPage('mission')},
    openPfdSettings(kind){this.panel=null;this.$refs.pfd?.open(kind)},
    openMission(selection) {
      this.selection = selection;
      this.missionOpen = true;
      this.error = ''
    },
    openHome(point=null){
      this.homeReturnLayout=this.layout;this.homeForm=point?{...this.shownMission.home,...point,mapSelected:true}:null;
      this.homeOpen=true;this.missionOpen=false;this.panel=null;this.homePicking=false;this.picking=null;this.flightPicking=null;this.error='';this.homeError='';
    },
    closeHome(){this.homeOpen=false;this.homePicking=false;this.homeForm=null;this.layout=this.homeReturnLayout},
    saveHome(home){this.edit({kind:'set-home',home});this.closeHome();this.error='Planning home saved locally; controller home is unchanged'},
    pickHome(form){this.homeForm=clone(form);this.homeOpen=false;this.homePicking=true;this.layout='map'},
    resumeHome(point=null){if(point)this.homeForm={...this.homeForm,...point,mapSelected:true};this.homePicking=false;this.homeOpen=true},
    reviewHome(home,form){
      try{this.homeError='';const action=controllerHomeRequest(home,this.snapshot.telemetry?.homePosition??null);this.homeForm=clone(form);this.review(action,'Set controller home');if(this.reviewing)this.homeOpen=false}
      catch(e){this.homeError=e.message}
    },
    cancelReview(){const home=this.reviewing?.action.kind==='set-home';this.reviewing=null;if(home)this.homeOpen=true},
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
      if(this.homePicking){this.resumeHome(point);return;}
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
          id: cockpitRequestId(),
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
        this.error = 'Request sent. Waiting for the aircraft response.';
        this.reviewing = null;
        if(current.action.kind==='set-home')this.homeOpen=true
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
          id: cockpitRequestId(),
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
      this.groundData.configure({mode:this.sourceMode,terrain:this.onlineTerrain,imagery:this.onlineMap,traffic:this.onlineTraffic,trafficRadiusNm:this.trafficRange,groundRelayUrl:this.groundRelayUrl,trafficRelayUrl:this.trafficRelayUrl});
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
      const telemetry={...this.telemetry,ready:this.flight.live},center=aircraftMapPosition(telemetry);
      if(center)this.groundData.pollTraffic(center).catch(e=>{if(!this.disposed)this.dataMessage=e.message});
      const report=this.groundData.trafficSnapshot(center);
      this.trafficReport=!center&&this.onlineTraffic&&this.sourceMode!=='offline'
        ? {...report,status:'unavailable',tracks:[],message:'Traffic paused · '+aircraftPositionMessage(telemetry)} : report
    },
    applyGroundRelay() {
      const previous=this.groundRelayUrl;
      try{this.groundRelayUrl=this.groundRelayInput.trim();this.configureGroundData();try{localStorage.setItem('yonder-ground-relay-v1',this.groundRelayUrl)}catch{};this.dataMessage=this.groundRelayUrl?'Ground relay selected':'Direct browser providers selected'}
      catch(e){this.groundRelayUrl=previous;this.dataMessage=e.message}
    },
    applyTrafficRelay() {
      const previous=this.trafficRelayUrl;
      try{this.trafficRelayUrl=this.trafficRelayInput.trim();this.configureGroundData();try{localStorage.setItem('yonder-traffic-relay-v1',this.trafficRelayUrl)}catch{};this.dataMessage=this.trafficRelayUrl?'ADS-B ground relay selected · imagery and terrain unchanged':'ADS-B uses the general ground relay or direct browser provider'}
      catch(e){this.trafficRelayUrl=previous;this.dataMessage=e.message}
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
    lostFocusEscape(event) {
      // A focused command button can disable while busy, moving focus to body.
      // The main element no longer receives that key; retain dialog dismissal.
      if (event.key === 'Escape' && !event.defaultPrevented &&
          document.activeElement === document.body &&
          (this.panel || this.reviewing || this.missionOpen || this.homeOpen)) this.cancelPanel();
    },
    cancelPanel() {
      if(this.reviewing?.action.kind==='set-home'){this.cancelReview();return;}
      if(this.homeOpen){this.closeHome();return;}
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
<style src="./cockpit/cockpit-layouts.css"></style>
<style src="./cockpit/cockpit-chrome.css"></style>
<style scoped>
.cockpit-data-settings { border: 1px solid var(--cockpit-border, #52616e); padding: 12px; margin-bottom: 16px; min-width: 0; }
.cockpit-data-settings legend { font-weight: 700; padding: 0 6px; }
.cockpit-data-settings p { overflow-wrap: anywhere; }
.mission-home-summary { display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;text-align:left;color:#81dcec; }
.mission-home-summary span { margin-left:auto;font-size:12px;color:#dbeaf0; }
</style>
