# Restoring telemetry and video after reboot

Requirements: R-MAV-08, R-CAM-22, R-CFG-14.

## Observed failure

The Pi's core, console, ZeroTier and MediaMTX services started. The core's
network renderer failed while activating the cellular profile:

```text
could not render the current configuration, serving anyway:
nmcli exited 4: Error: Connection activation failed: Unknown error
```

The renderer sequence stopped before telemetry was initialized. The later
Start request failed with:

```text
no configuration has been rendered yet, so there is nothing to start telemetry from
```

The saved MAVLink configuration had `autocast: true`. Applying the configuration
again initialized telemetry. The camera had `autostart: false`; even `true` had
no boot consumer. MediaMTX accepted RTSP connections but reported no stream on
the configured camera path.

## Repair

`ApplyEngine.renderCurrent()` now bounds and attempts each renderer, reports all
failures after the pass, and reserves the configuration during that pass.
Ordinary configuration apply and rollback keep their transaction semantics.

`CameraAutostart` is wired into the daemon after media and pipeline rendering.
It starts only cameras selected at boot, from their stable identity and current
settings. Hardware discovery runs in the background and retries. The supervisor
keeps retrying automatically started pipelines with backoff capped at 30 seconds.
Stop cancels the intent; a configuration suspension can be restored by rollback,
provided no later operator action has overridden it. Shutdown cancels discovery
and owned process timers.

The device still needs `enabled: true` and `autostart: true` on the desired camera.
Set this through the configuration API's apply and confirm flow. Telemetry needs
`mavlink.autocast: true` and the intended ground-station endpoints.

## Local verification

- Focused engine, camera, supervisor, pipeline and daemon-wiring suites: 172 tests
  passed, including delayed devices, probe failures, manual Stop, configuration
  rollback, shutdown, and continued boot initialization after a renderer timeout.
- Production TypeScript build and type-check of the new/changed regression tests
  passed.
- Full core suite: 2,472 passed; one unrelated pre-existing failure remains in
  `flows.test.ts`: the Cameras page lacks a CHANGE PENDING banner. The same test
  fails on the unchanged base build.
- Independent code review completed; rollback findings were fixed and retested.

K-48's existing limitation remains: a settings apply during a pipeline retry gap
can leave the queued retry using its earlier launch arguments. This hotfix does
not change `PipelineRenderer`.

## Hardware acceptance

Pending deployment and hardware verification. The board became unreachable while
the hotfix was being prepared; no successful deployment is claimed here.

1. Back up the deployed core files and compare them with the build base so prior
   device hotfixes are preserved. Install the four runtime modules changed by
   this repair: `apply/engine.js`, `daemon/server.js`, `video/supervisor.js`, and
   the new `video/autostart.js`.
2. Apply and confirm camera autostart. Restart the core and check the camera's
   actual process, both MediaMTX publishing paths, and received autopilot heartbeats.
3. Reboot the Pi. Without pressing Start or Apply, verify the same camera and
   autopilot return, then receive RTSP and MAVLink over ZeroTier from a ground
   station. Inspect the boot log for failed initialization and duplicate publishers.
4. Repeat with an actual power-off/power-on cycle. A software reboot alone does
   not prove recovery when USB hardware and the autopilot power up together.
