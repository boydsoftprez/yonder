# What the board can say about where the SeekerHD was looking

R-FLT-09, R-FLT-29, R-CAM-01, R-CTL-05. Task 3 of
[the camera in the flight display](../superpowers/plans/2026-09-11-flight-camera-in-pfd.md).
Observed 2026-09-12 by the controller, read-only, on the Radxa ZERO 3 reached over the
mesh. No production change; anything that ships as a result gets its own requirement then.

**Why this exists.** The flight display's third background, camera with registered
terrain, cannot become ready until the board can say, for each frame, where the camera was
pointing when it was taken. The console's own gate for that is `registrationValidity` in
`packages/yonder-core/src/terrain/projection.ts`: it needs a validated calibration, a
matching camera and capture profile, terrain coverage, an aircraft height datum equal to
the terrain pack's and verified, a frame capture time and a pose time within a stated error
bound, and a pose bracketed around the frame. Each of the four questions below is one of
those inputs. An answer of *unknown, and here is why* is a passing answer; an invented
device contract is not.

## The board as found

- Radxa ZERO 3, addresses on the mesh, the LAN and a cellular interface. One boot observed;
  the clock read a month early until network time synchronised, which is what made one
  boot look like two. NTP synchronised, UTC.
- `yonder-core`, `yonder-console` and `mediamtx` (v1.20.1) active. Console bundle dated
  2026-09-12 18:07, core dist 2026-09-12 00:39, package version 2026.9.0. The console is
  behind the administrator password and was not signed in to.
- IMX462 sensor bound as `m00_b_imx462` on I²C address `0x1a`; ISP nodes `rkisp_mainpath`
  and `rkisp_selfpath`; the RKAIQ control service running.
- **No camera pipeline was running** at three minutes after boot, nor at five, with the
  load average above six on a four-core board. The ISP service was up throughout. The
  daemon's journal and `mediamtx.yml` are not readable by the bench user, so whether
  autostart was still preparing the mode, had failed, or was never enabled on this image
  could not be read. Nothing was restarted or changed; the operator should look at the
  Cameras page or the daemon's journal as root.

## 1. Lens — *manufacturer figure for the field of view; distortion unknown*

- The camera is the Divimath SeekerHD, Sony IMX462, 1920×1080, on an **M12 lens mount**.
  The manufacturer states a **148° diagonal field of view**. It states no focal length, no
  aperture, no distortion figures and no image-circle figure. No measurement was taken
  here; the pipeline was not running and a calibration target needs a person in front of
  the lens.
- In the prepared mode the sensor supplies full-field 1920×1080 Bayer and the ISP scales it
  to NV12 1280×720: the same 16:9 shape, so a scale and not a crop
  ([the SeekerHD record](seekerhd-on-radxa-zero-3w.md)).
- **The finding that matters:** the console's calibration validator accepts only the
  `brown-conrady` distortion model (`projection.ts`, `geometryValid`), which is a
  perspective model with polynomial radial and tangential terms. A 148° diagonal lens is a
  fisheye, and a perspective model does not describe a fisheye across its field; a
  registered overlay would be wrong towards the edges however carefully the centre was
  fitted. Either the lens is replaced with a narrower M12 lens whose field the model can
  describe, or the console gains a fisheye (equidistant) model. That is a design decision
  for the operator before any calibration is attempted, and it is why no calibration file
  is proposed here.
- In the validator's own fields, what a calibration would need: `width` 1280 and `height`
  720 for the delivered frame, `fx`, `fy`, `cx`, `cy` and `distortion` from a measurement,
  `residualPx` and `maxResidualPx` from that fit, `cameraId` and `profileId` matching the
  daemon's camera record, and `validated: true` only when a person has checked it.

## 2. Mount — *pipeline geometry known from code; boresight unknown*

- The pipeline applies a turn only when the camera's configuration sets a rotation or a
  mirror (R-CTL-05 keeps them separate). The SeekerHD's driver offers no flip control, so
  any turn is a `videoflip` in the pipeline (`pipeline.ts`, `turn()`; `renderer.ts`). The
  configured value on this board lives in `/etc/yonder/config.yaml`, which the bench user
  cannot read, and the pipeline was not running to show its arguments. So: *whether the
  delivered frame is turned today is unknown from this observation*, and the way to know
  is to read the camera's Setup page or the configuration as root.
- How the camera sits on the airframe relative to the aircraft's axes — the boresight, and
  the `bodyToCamera` rotation and `cameraOffsetBodyM` the validator wants — is **unknown**.
  It needs a person with the airframe and a reference, not a login.

## 3. Frame timing — *mechanism known from code; capture time absent; delay unmeasured*

- **What a frame carries today.** The source is `v4l2src` (DMA buffers, `io-mode=4`) into
  the encoder, then `rtph264pay` and `rtspclientsink` with `latency=0` over TCP into
  mediamtx on loopback, and the browser reads by WebRTC (WHEP). GStreamer stamps each
  buffer with the kernel's capture time on the pipeline's monotonic clock; the RTP timestamp
  is derived from that at 90 kHz; mediamtx forwards RTP timestamps to its readers and, as a
  WebRTC sender, emits RTCP sender reports relating RTP time to wall-clock time **at
  mediamtx**, which is receipt at the server, not capture at the sensor.
- **Nothing in the console reads a capture time.** A search of the picture component and
  its transport finds no use of `getSynchronizationSources`, `captureTimestamp`,
  `rtpTimestamp` or an `abs-capture-time` header extension, and the pipeline sets no such
  extension. The daemon's camera record reports `frameCaptureMs`, `poseTimeMs` and
  `timeErrorMs` as null by construction (`cockpit/camera.ts`). That is honest.
- **What the pose carries today.** Telemetry samples are stamped with the daemon's receipt
  time (`vehicle-telemetry.ts`, `at: now`). The flight controller's own clock arrives in
  `SYSTEM_TIME` and `GLOBAL_POSITION_INT.time_boot_ms`, but the daemon uses it only for
  its boot counters (`instrumentation.ts`). So there is no flight-controller-time pose to
  bracket a frame with yet; both sides would have to be placed on one clock.
- **Where a capture time could come from.** The board's clock is NTP-synchronised, so a
  capture time on the board's wall clock is possible: GStreamer can carry the buffer's
  capture time as metadata, and it would have to reach the browser either as an RTP header
  extension the WebRTC path negotiates, or as a sidecar the daemon publishes relating RTP
  timestamps to wall time, which the browser can match against the RTP timestamp it can
  read from its receiver. Either is a change to the pipeline and to mediamtx's
  configuration, and neither exists. Whether mediamtx 1.20.1 forwards a capture-time
  extension from an RTSP publisher to a WebRTC reader could not be established: its
  documentation does not say and the stream was not running to inspect the offer.
- **The measured capture-to-display delay is pending.** It needs a running stream and a
  person holding a clock in front of the lens while watching the console, or an equivalent
  photographed reference. The picture component already reports the browser's own jitter
  buffer and decode time (`receiverBufferMs`), which is part of that delay and not the
  whole of it.

## 4. Datum — *mechanism known from code; the aircraft's geoid is declared, not measured*

- The flight display's altitude tape uses `VFR_HUD.alt`; `GLOBAL_POSITION_INT.alt` is
  carried as the global altitude and `GPS_RAW_INT.alt` as the GPS altitude
  (`vehicle-telemetry.ts`). The MAVLink definitions call both of the latter mean-sea-level
  altitudes; on ArduPilot the GPS figure is the receiver's ellipsoid height converted with
  the autopilot's built-in EGM96 geoid table. That is the documented behaviour of the
  autopilot family, not something this board proved.
- The aircraft's datum in the console is **declared by the operator** (`aircraftDatum`,
  default `UNKNOWN`; choices EGM96, NAVD88, WGS84 ellipsoid), never inferred
  (`cockpit/routes.ts`).
- The prepared terrain pack in the repository is EGM96, with a verified NAVD88 (GEOID12B) to
  EGM96 transform in its manifest (`terrain/assets/cove/manifest.json`), and the validator
  requires the two datums to be equal and the transform verified.
- So: for an ArduPilot aircraft the honest declaration is EGM96, and the way to verify it
  before trusting a registration is a bounded ground check — compare the reported MSL
  altitude at a surveyed point against the pack's ground at that point — which needs the
  aircraft on the ground at a known place. Not done here.

## What the evidence cannot say, and what a registered overlay still needs

1. A decision on the lens: replace it with one a perspective model describes, or add a
   fisheye model to the validator. Nothing else is worth doing first.
2. Then a measured calibration in the validator's fields, and a boresight on the airframe,
   both by a person.
3. A capture time per frame that reaches the browser, and the pose placed on the same
   clock, then the error bound and bracketing the validator already checks.
4. The datum verified on the ground once, and declared.

**Recommendation, not a decision:** when the overlay is built, start with the translucent
wash rather than the wire. A wash degrades gracefully where registration is slightly off;
a wire draws a crisp line in the wrong place, and with a 148° lens the edges will be off
until the lens question is settled.
