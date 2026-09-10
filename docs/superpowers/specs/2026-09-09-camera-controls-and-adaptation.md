# Camera controls, adaptation and latency

Requirements: R-CAM-11, R-CTL-04, R-CTL-05, R-CTL-07, R-VID-07,
R-VID-14, R-UI-29. The operator requested these corrections on September 9.

- Move video status, stream readings and recording information into a solid,
  readable strip above the image. Retain the large video column and compact
  the Aim panel, including position readings when native joint bounds are unknown.
- Use US English in visible camera controls and guidance. Use Color and Recenter
  without renaming established protocol keys.
- Interpret aiming relative to the applied image flips and rotation. Apply the
  inverse image transform to screen-directed input and end held input when that
  transform changes. Retain native limits, expiry and ownership checks.
- Show proposed settings on their own controls, together with a subtle highlight
  and explicit unsaved indication. Preserve applied readback and the existing
  Apply/Keep/Revert transaction.
- Always offer RTSP configuration, including when the camera has no outputs.
  Enabling it uses the existing protected RTSP credential and apply transaction;
  restoring its control does not enable an output without the operator's action.
- Expose camera-native exposure compensation and white balance clearly. Add
  separate streamed-picture brightness, contrast, saturation and hue controls.
  Neutral settings bypass processing. Non-neutral settings add no buffering;
  measure processing cost and distinguish them from the camera's internal files.
- Preserve reception statistics when the browser lacks a bandwidth estimate.
  Use bounded feedback-driven probing inside the applied adaptive envelope, and
  distinguish probes from measured capacity. Show actual encoder readback and
  the current adaptation decision instead of a configured starting value.
- Adaptation concerns the media path being observed, not an independent modem
  speed test. Validate falling and recovering delivery conditions, stale reports,
  multiple viewers and bounds. Do not present local-network tests as LTE proof.
- Measure latency through the available stages before assigning the reported
  delay to the camera. Preserve the current Fixed 1150 kb/s configuration except
  for bounded verification followed by restoration.

Core, console, encoder and UI changes must be staged coherently and tested before
deployment. Preserve the live USB owner wherever possible, existing user settings,
network reachability, rollback, and the recently corrected preview recovery.
