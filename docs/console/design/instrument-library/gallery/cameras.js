/* Two capability reports, both from this repository's own bench evidence:
   the ELP from `v4l2-ctl --list-ctrls` on the board, the Pocket 2 from the
   command matrix in docs/hardware/dji-pocket-2-over-usb.md.

   `state` is one of present | not-offered | advertised | gated. `proven`
   records whether the bench has actually driven it — that is a fact about
   this project, not about the camera, so it never reaches the console. It is
   here so the harness can mark what is still a promise.

   `gates: [...]` names the controls a control holds charge of; `openValues`
   is the list of *this* control's own values that leave those held controls
   live (deck.js reads it rather than assuming "the second option" or a
   literal "4" — a rule that broke the moment a gate had more than two
   options with the open one in the middle, which is exactly the Pocket 2's
   case below). Every value here is a string because every control that
   reads it comes from a real `<select>` or a segmented button, and both
   hand back strings.

   `column: "stream" | "preview"` is also what marks a control as part of
   the shared draft (§7 "Editing on Live and Setup"): deck.js stages any
   edit to one of these two columns rather than applying it, and Setup lists
   it under `interrupt`, which is blank where nothing is known to happen and
   a stated consequence where the bench or the spec has one. */

export const ELP = {
  name: "Cam 1", bus: "USB · UVC", spec: "USB · H.264 · 1280×720p30",
  aim: { state: "advertised", proven: true,
    reason: "Listed ±180° in 1° steps. Fifteen values sent, every one acknowledged, the frame never moved." },
  controls: {
    streamMode: { state: "present", proven: true, kind: "seg", label: "Bitrate", column: "stream",
      options: ["Fixed", "Adaptive"], value: "Fixed" },
    // §8.1: "Choose and test timing thresholds..."; today only Resolution is
    // known to force a whole-pipeline restart. Bitrate has no runtime control
    // channel yet either, so it is honest to say the current path respawns —
    // R-VID-07/R-VID-17's controller is what removes this line, not the UI.
    resolution: { state: "present", proven: true, kind: "pick", label: "Resolution", column: "stream",
      value: "1280x720", interrupt: "restarts the pipeline", options: [
        { value: "1920x1080", label: "1920×1080 · 30 fps" },
        { value: "1280x720", label: "1280×720 · 30 fps" },
        { value: "640x480", label: "640×480 · 30 fps" }] },
    // Floor · Ceiling — new (§7's Stream table), shown only in Adaptive.
    streamFloor: { state: "present", proven: true, kind: "pick", label: "Floor", column: "stream",
      value: "1000", options: [{ value: "1000", label: "1.0 Mb/s" }, { value: "1500", label: "1.5 Mb/s" }, { value: "2000", label: "2.0 Mb/s" }] },
    streamCeiling: { state: "present", proven: true, kind: "pick", label: "Ceiling", column: "stream",
      value: "6000", options: [{ value: "4000", label: "4.0 Mb/s" }, { value: "6000", label: "6.0 Mb/s" }, { value: "8000", label: "8.0 Mb/s" }] },
    previewMode: { state: "present", proven: true, kind: "seg", label: "Bitrate", column: "preview",
      options: ["Adaptive", "Fixed"], value: "Adaptive" },
    // Fixed bitrate — new: "Editable target in Fixed mode, retained in
    // Adaptive" (§7's Preview table). Only shown while previewMode is Fixed.
    previewBitrate: { state: "present", proven: true, kind: "bar", label: "Bitrate", column: "preview",
      unit: "Mb/s", min: 0.1, max: 4, step: 0.1, precision: 1, value: 0.4,
      interrupt: "current respawn path only" },
    previewSize: { state: "present", proven: true, kind: "pick", label: "Size", column: "preview",
      value: "auto", interrupt: "may restart the preview branch", options: [
        { value: "auto", label: "Auto — steps with the link" },
        { value: "1280x720", label: "1280×720 — hold" },
        { value: "854x480", label: "854×480 — hold" },
        { value: "640x360", label: "640×360 — hold" }] },
    // Smallest · Largest automatic size — new, visible only with Auto: the
    // ladder's own endpoints, chosen from the same rungs Size offers.
    previewLadderBottom: { state: "present", proven: true, kind: "pick", label: "Smallest automatic size", column: "preview",
      value: "640x360", options: [
        { value: "640x360", label: "640×360" }, { value: "854x480", label: "854×480" }, { value: "1280x720", label: "1280×720" }] },
    previewLadderTop: { state: "present", proven: true, kind: "pick", label: "Largest automatic size", column: "preview",
      value: "1280x720", options: [
        { value: "640x360", label: "640×360" }, { value: "854x480", label: "854×480" }, { value: "1280x720", label: "1280×720" }] },
    previewRate: { state: "present", proven: true, kind: "pick", label: "Rate", column: "preview",
      value: "15", interrupt: "current respawn path only",
      options: [{ value: "30", label: "30 fps" }, { value: "15", label: "15 fps" }, { value: "10", label: "10 fps" }] },
    previewFloor: { state: "present", proven: true, kind: "pick", label: "Floor", column: "preview",
      value: "300", options: [{ value: "150", label: "150 kb/s" }, { value: "300", label: "300 kb/s" }, { value: "500", label: "500 kb/s" }] },
    previewCeiling: { state: "present", proven: true, kind: "pick", label: "Ceiling", column: "preview",
      value: "2000", options: [{ value: "1000", label: "1.0 Mb/s" }, { value: "2000", label: "2.0 Mb/s" }, { value: "4000", label: "4.0 Mb/s" }] },
    // `auto_exposure` offers exactly menu ids 3 (Aperture Priority Mode,
    // the fixture's default) and 1 (Manual Mode) — nothing else is a real
    // choice (probe/fixtures/list-ctrls-menus-globalshutter.txt). Labels are
    // the spec's shortened form, not the fixture's verbatim "... Mode" text.
    autoExposure: { state: "present", proven: true, kind: "seg", label: "Auto exposure", column: "exposure",
      options: ["Aperture priority", "Manual"], value: "Aperture priority",
      gates: ["shutter"], openValues: ["Manual"] },
    // V4L2 absolute exposure is 100 µs per raw unit (packages/yonder-core/src/
    // video/descriptors.ts, `DESCRIPTORS.exposure`): raw 156 is 15600 µs, and
    // the displayed step is 100 µs, not the raw step of 1. Device-native raw
    // value is not what this file stores any more — the descriptor is the one
    // place that conversion is allowed to live, so this mockup shows what it
    // shows rather than restating the factor a second time.
    shutter: { state: "present", proven: true, kind: "bar", label: "Shutter", column: "exposure",
      unit: "µs", min: 100, max: 1000000, step: 100, value: 15600 },
    gain: { fly: true, state: "present", proven: true, kind: "bar", label: "Gain", column: "exposure",
      min: 0, max: 1023, step: 1, value: 0 },
    backlight: { fly: true, state: "present", proven: true, kind: "bar", label: "Backlight", column: "exposure",
      min: 36, max: 160, step: 1, value: 54 },
    autoWhiteBalance: { state: "present", proven: true, kind: "seg", label: "White balance", column: "colour",
      options: ["Auto", "Manual"], value: "Auto", gates: ["temperature"], openValues: ["Manual"] },
    temperature: { state: "present", proven: true, kind: "bar", label: "Temperature", column: "colour",
      unit: "K", min: 2800, max: 6500, step: 1, value: 4600 },
    brightness: { state: "present", proven: true, kind: "bar", label: "Brightness", column: "colour",
      min: -64, max: 64, step: 1, value: 0 },
    contrast: { state: "present", proven: true, kind: "bar", label: "Contrast", column: "colour",
      min: 0, max: 95, step: 1, value: 0 },
    autoFocus: { state: "present", proven: true, kind: "seg", label: "Focus", column: "optics",
      options: ["Auto", "Manual"], value: "Auto", gates: ["focus"], openValues: ["Manual"] },
    focus: { state: "present", proven: true, kind: "bar", label: "Focus", column: "optics",
      min: 0, max: 1023, step: 1, value: 347 },
    // `zoom_absolute`: device steps. No × ratio has been established for this
    // camera's zoom, so the unit is blank rather than a ratio nobody measured
    // (R-CTL-14; packages/yonder-core/src/video/descriptors.ts's `zoom`).
    zoom: { fly: true, state: "present", proven: true, kind: "bar", label: "Zoom", column: "optics",
      min: 0, max: 60, step: 1, value: 0 },
    gamma: { state: "present", proven: true, kind: "bar", label: "Gamma", column: "rendering",
      min: 64, max: 300, step: 1, value: 110 },
    sharpness: { state: "present", proven: true, kind: "bar", label: "Sharpness", column: "rendering",
      min: 0, max: 7, step: 1, value: 0, fine: "over-sharpening spends uplink on edges" },
    saturation: { state: "present", proven: true, kind: "bar", label: "Saturation", column: "rendering",
      min: 0, max: 255, step: 1, value: 56 },
    hue: { state: "present", proven: true, kind: "bar", label: "Hue", column: "rendering",
      min: -2000, max: 2000, step: 1, value: 0 },
    mains: { setup: true, state: "present", proven: true, kind: "pick", label: "Mains frequency", column: "housekeeping",
      value: "1", options: [{ value: "0", label: "Disabled" }, { value: "1", label: "50 Hz" }, { value: "2", label: "60 Hz" }] },
    // §8.3: "This makes Video/Photo and the same shutter key available on
    // the ELP too" — the ELP has no native still capture, so Photo mode is
    // the pipeline-frame fallback, same as Video's board recording.
    workMode: { state: "present", proven: false, kind: "seg", label: "Mode", column: "capture",
      options: ["Video", "Photo"], value: "Video" },
    // R-CAM-17/R-CAM-18: the camera's own card where it has one, this board
    // where it does not. The ELP has none, so both Video and Photo land here.
    shutter_key: { state: "present", proven: false, kind: "shutter", column: "capture",
      to: "this board", free: 118, freeStills: 3900, note: "" },
  },
  exposureReadout: (v) => ["GAIN", String(v.gain ?? 0)],
  readouts: [
    { label: "Device", value: "usb-1.2 · ELP-USBFHD01M" },
    { label: "Encoder", value: "v4l2h264enc · hardware" },
  ],
};

export const POCKET2 = {
  name: "Cam 2", bus: "USB accessory", spec: "Accessory · H.264 · 1280×720p30",
  aim: { state: "present", proven: true, reason: "" },
  controls: {
    streamMode: { state: "present", proven: true, kind: "seg", label: "Bitrate", column: "stream",
      options: ["Fixed", "Adaptive"], value: "Fixed" },
    // The SDK's four live-view handlers are stubs that never send. The feed is
    // a fixed pipe, and saying so is more use than a picker that does nothing.
    resolution: { state: "not-offered", proven: true, label: "Live-view resolution", column: "stream",
      why: "this camera sends one size and takes no instruction about it" },
    streamFloor: { state: "present", proven: true, kind: "pick", label: "Floor", column: "stream",
      value: "1000", options: [{ value: "1000", label: "1.0 Mb/s" }, { value: "1500", label: "1.5 Mb/s" }, { value: "2000", label: "2.0 Mb/s" }] },
    streamCeiling: { state: "present", proven: true, kind: "pick", label: "Ceiling", column: "stream",
      value: "6000", options: [{ value: "4000", label: "4.0 Mb/s" }, { value: "6000", label: "6.0 Mb/s" }, { value: "8000", label: "8.0 Mb/s" }] },
    previewMode: { state: "present", proven: true, kind: "seg", label: "Bitrate", column: "preview",
      options: ["Adaptive", "Fixed"], value: "Adaptive" },
    previewBitrate: { state: "present", proven: true, kind: "bar", label: "Bitrate", column: "preview",
      unit: "Mb/s", min: 0.1, max: 4, step: 0.1, precision: 1, value: 0.4,
      interrupt: "current respawn path only" },
    previewSize: { state: "present", proven: true, kind: "pick", label: "Size", column: "preview",
      value: "auto", interrupt: "may restart the preview branch", options: [
        { value: "auto", label: "Auto — steps with the link" },
        { value: "1280x720", label: "1280×720 — hold" },
        { value: "854x480", label: "854×480 — hold" },
        { value: "640x360", label: "640×360 — hold" }] },
    previewLadderBottom: { state: "present", proven: true, kind: "pick", label: "Smallest automatic size", column: "preview",
      value: "640x360", options: [
        { value: "640x360", label: "640×360" }, { value: "854x480", label: "854×480" }, { value: "1280x720", label: "1280×720" }] },
    previewLadderTop: { state: "present", proven: true, kind: "pick", label: "Largest automatic size", column: "preview",
      value: "1280x720", options: [
        { value: "640x360", label: "640×360" }, { value: "854x480", label: "854×480" }, { value: "1280x720", label: "1280×720" }] },
    previewRate: { state: "present", proven: true, kind: "pick", label: "Rate", column: "preview",
      value: "15", interrupt: "current respawn path only",
      options: [{ value: "30", label: "30 fps" }, { value: "15", label: "15 fps" }, { value: "10", label: "10 fps" }] },
    previewFloor: { state: "present", proven: true, kind: "pick", label: "Floor", column: "preview",
      value: "300", options: [{ value: "150", label: "150 kb/s" }, { value: "300", label: "300 kb/s" }, { value: "500", label: "500 kb/s" }] },
    previewCeiling: { state: "present", proven: true, kind: "pick", label: "Ceiling", column: "preview",
      value: "2000", options: [{ value: "1000", label: "1.0 Mb/s" }, { value: "2000", label: "2.0 Mb/s" }, { value: "4000", label: "4.0 Mb/s" }] },
    workMode: { state: "present", proven: true, kind: "seg", label: "Mode", column: "capture",
      options: ["Video", "Photo"], value: "Video" },
    // One shutter. It follows the mode: RECORD in video, PHOTO in photo. The
    // camera cannot do both at once, so two keys would be a lie about that.
    shutter_key: { state: "present", proven: "acknowledged", kind: "shutter", column: "capture",
      to: "the camera's card", free: null, note: "no card in the camera" },
    photoSize: { setup: true, state: "present", proven: false, kind: "seg", label: "Sensor", column: "capture",
      options: ["16 MP", "64 MP"], value: "16 MP" },
    recordFormat: { setup: true, state: "present", proven: false, kind: "pick", label: "Records at", column: "capture",
      value: "1920x1080@30", options: [
        { value: "3840x2160@30", label: "3840×2160 · 30 fps" },
        { value: "1920x1080@60", label: "1920×1080 · 60 fps" },
        { value: "1920x1080@30", label: "1920×1080 · 30 fps" }] },
    // camera/0x1e, 2 bytes {mode, 0}, 1 Program … 4 Manual
    // (docs/hardware/dji-pocket-2-over-usb.md). Shutter and ISO open under
    // Manual *and* Shutter priority — the same fact descriptors.ts records
    // for this camera ("the DJI Pocket 2 leaves shutter live under Manual
    // *or* Shutter priority") — never only Manual, which is a rule for one
    // camera, not every camera with this shape.
    exposureMode: { state: "present", proven: true, kind: "pick", label: "Exposure", column: "exposure",
      value: "1", options: [
        { value: "1", label: "Program" }, { value: "2", label: "Shutter priority" },
        { value: "3", label: "Aperture priority" }, { value: "4", label: "Manual" }],
      gates: ["iso", "shutter"], openValues: ["2", "4"] },
    iso: { state: "present", proven: true, kind: "bar", label: "ISO", column: "exposure",
      min: 100, max: 6400, step: 100, value: 400 },
    // `camera/0x28` is untried (docs/hardware/dji-pocket-2-over-usb.md); the
    // bar is drawn from the same raw-×-100/step-100 convention as the ELP's
    // shutter (coordinator resolution: "Shutter is raw × 100 µs, on both
    // cameras") rather than a second, invented unit for this one control.
    shutter: { state: "present", proven: false, kind: "bar", label: "Shutter", column: "exposure",
      unit: "µs", min: 12500, max: 800000, step: 100, value: 200000 },
    ev: { fly: true, state: "present", proven: true, kind: "bar", label: "EV", column: "exposure",
      min: -3, max: 3, step: 0.3, precision: 1, value: 0 },
    whiteBalance: { state: "present", proven: true, kind: "pick", label: "White balance", column: "colour",
      value: "sunny", options: [
        { value: "auto", label: "Auto" }, { value: "sunny", label: "Sunny" },
        { value: "cloudy", label: "Cloudy" }, { value: "incandescent", label: "Incandescent" },
        { value: "custom", label: "Custom" }] },
    // Proven digital-only, and proven not to reshape the USB feed — so this is
    // a crop Yonder does in the browser, and the page had better say so.
    zoom: { fly: true, state: "present", proven: true, kind: "bar", label: "Zoom", column: "optics",
      unit: "×", min: 1, max: 10, step: 0.1, precision: 1, value: 1,
      fine: "digital · the feed does not change, the browser crops" },
    focusMode: { state: "present", proven: false, kind: "seg", label: "Focus", column: "optics",
      options: ["AFC", "AFS", "Spot"], value: "AFC" },
    gimbalMode: { fly: true, state: "present", proven: "partly", kind: "seg", label: "Gimbal mode", column: "aim",
      options: ["Follow", "Tilt lock", "FPV"], value: "Follow" },
  },
  exposureReadout: (v) => ["EV", (v.ev >= 0 ? "+" : "−") + Math.abs(v.ev ?? 0).toFixed(1)],
  readouts: [
    { label: "Battery", value: "99", unit: "%" },
    { label: "Card", value: "none", absent: true },
    { label: "Sensor", value: "16", unit: "MP" },
  ],
};
