/* Two capability reports, both from this repository's own bench evidence:
   the ELP from `v4l2-ctl --list-ctrls` on the board, the Pocket 2 from the
   command matrix in docs/hardware/dji-pocket-2-over-usb.md.

   `state` is one of present | not-offered | advertised | gated. `proven`
   records whether the bench has actually driven it — that is a fact about
   this project, not about the camera, so it never reaches the console. It is
   here so the harness can mark what is still a promise. */

export const ELP = {
  name: "Cam 1", bus: "USB · UVC", spec: "USB · H.264 · 1280×720p30",
  aim: { state: "advertised", proven: true,
    reason: "Listed ±180° in 1° steps. Fifteen values sent, every one acknowledged, the frame never moved." },
  controls: {
    resolution: { state: "present", proven: true, kind: "pick", label: "Resolution", column: "stream",
      value: "1280x720", options: [
        { value: "1920x1080", label: "1920×1080 · 30 fps" },
        { value: "1280x720", label: "1280×720 · 30 fps" },
        { value: "640x480", label: "640×480 · 30 fps" }] },
    autoExposure: { state: "present", proven: true, kind: "seg", label: "Auto exposure", column: "exposure",
      options: ["Auto", "Manual"], value: "Auto", gates: ["shutter"] },
    shutter: { state: "present", proven: true, kind: "bar", label: "Shutter", column: "exposure",
      unit: "µs", min: 1, max: 10000, step: 1, value: 156 },
    gain: { fly: true, state: "present", proven: true, kind: "bar", label: "Gain", column: "exposure",
      min: 0, max: 1023, step: 1, value: 0 },
    backlight: { fly: true, state: "present", proven: true, kind: "bar", label: "Backlight", column: "exposure",
      min: 36, max: 160, step: 1, value: 54 },
    autoWhiteBalance: { state: "present", proven: true, kind: "seg", label: "White balance", column: "colour",
      options: ["Auto", "Manual"], value: "Auto", gates: ["temperature"] },
    temperature: { state: "present", proven: true, kind: "bar", label: "Temperature", column: "colour",
      unit: "K", min: 2800, max: 6500, step: 1, value: 4600 },
    brightness: { state: "present", proven: true, kind: "bar", label: "Brightness", column: "colour",
      min: -64, max: 64, step: 1, value: 0 },
    contrast: { state: "present", proven: true, kind: "bar", label: "Contrast", column: "colour",
      min: 0, max: 95, step: 1, value: 0 },
    autoFocus: { state: "present", proven: true, kind: "seg", label: "Focus", column: "optics",
      options: ["Auto", "Manual"], value: "Auto", gates: ["focus"] },
    focus: { state: "present", proven: true, kind: "bar", label: "Focus", column: "optics",
      min: 0, max: 1023, step: 1, value: 347 },
    zoom: { fly: true, state: "present", proven: true, kind: "bar", label: "Zoom", column: "optics",
      unit: "×", min: 0, max: 60, step: 1, value: 0 },
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
    // R-CAM-17: the camera's own card where it has one, this board where it
    // does not. The ELP has none, so it records here.
    shutter_key: { state: "present", proven: false, kind: "shutter", column: "capture",
      to: "this board", free: 118, note: "" },
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
    // The SDK's four live-view handlers are stubs that never send. The feed is
    // a fixed pipe, and saying so is more use than a picker that does nothing.
    resolution: { state: "not-offered", proven: true, label: "Live-view resolution", column: "stream",
      why: "this camera sends one size and takes no instruction about it" },
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
    exposureMode: { state: "present", proven: true, kind: "pick", label: "Exposure", column: "exposure",
      value: "1", options: [
        { value: "1", label: "Program" }, { value: "2", label: "Shutter priority" },
        { value: "3", label: "Aperture priority" }, { value: "4", label: "Manual" }],
      gates: ["iso", "shutter"] },
    iso: { state: "present", proven: true, kind: "bar", label: "ISO", column: "exposure",
      min: 100, max: 6400, step: 100, value: 400 },
    shutter: { state: "present", proven: false, kind: "bar", label: "Shutter", column: "exposure",
      unit: "µs", min: 125, max: 8000, step: 1, value: 2000 },
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
