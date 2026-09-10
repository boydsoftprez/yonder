// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";
import type { DetectResult } from "../video/probe/camera.js";
import type { CameraRun } from "../video/supervisor.js";
export interface CockpitCamera {
  id: string;
  name: string;
  path: string;
  detected: boolean;
  run: CameraRun | null;
  profileId: string;
  calibration: null;
  frameCaptureMs: null;
  poseTimeMs: null;
  timeErrorMs: null;
  registration: { ready: false; reason: string };
}
/** Configuration identifies a stream; a lens name alone never proves HUD alignment. */
export function cockpitCameras(
  cameras: Camera[],
  detected: DetectResult | null,
  selected: string | null,
  runs: (id: string) => CameraRun | null,
) {
  const list: CockpitCamera[] = cameras.map((c) => ({
    id: c.id,
    name: c.name,
    path: `${c.id}-preview`,
    detected: detected?.found.some((d) => d.byPath === c.device) ?? false,
    run: runs(c.id),
    profileId: JSON.stringify({
      id: c.id,
      device: c.device,
      width: c.width,
      height: c.height,
      framerate: c.framerate,
      preview: c.preview,
      controls: c.controls,
    }),
    calibration: null,
    frameCaptureMs: null,
    poseTimeMs: null,
    timeErrorMs: null,
    registration: {
      ready: false,
      reason:
        "Camera lens/mount calibration and capture-time alignment have not been verified",
    },
  }));
  const elp = list.filter((c) => /elp|usbgs1200/i.test(c.name));
  const camera = selected
    ? (list.find((c) => c.id === selected) ?? null)
    : elp.length === 1
      ? elp[0]!
      : list.length === 1
        ? list[0]!
        : null;
  return { cameras: list, camera };
}
