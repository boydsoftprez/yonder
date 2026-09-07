# Restoring telemetry and video after reboot

Requirements: R-MAV-08, R-CAM-22, R-CFG-14, R-CEL-06.

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

The next power-up exposed the cellular trigger. NetworkManager reported
`gsm.password:<hidden>`, which Yonder compared as a changed password. At boot,
the resulting down/up cancelled the modem's initial MBIM connection attempt.
Subsequent attempts returned `Busy`. The saved profile had
`connection.autoconnect-retries=-1`, and the operator had to reconnect cellular.

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

The modem comparison now treats a masked password as unreadable. Enabled modem
profiles explicitly request unlimited activation retries, in both managed and
appliance modes. Both changes follow the existing network renderer and configuration
transaction; no separate network writer or reconnect loop was introduced.
NetworkManager defines zero retries as unlimited in its
[connection settings reference](https://networkmanager.dev/docs/api/latest/settings-connection.html).

## Local verification

- Focused engine, camera, supervisor, pipeline and daemon-wiring suites: 172 tests
  passed, including delayed devices, probe failures, manual Stop, configuration
  rollback, shutdown, and continued boot initialization after a renderer timeout.
- Production TypeScript build and type-check of the new/changed regression tests
  passed.
- Cellular regression cases failed before the fix. The modem profile and network
  renderer suites now pass all 105 tests, including a masked password during boot
  dialling and unlimited retries for both modem modes.
- Full core suite after the cellular fix: 2,477 passed; one unrelated pre-existing failure remains in
  `flows.test.ts`: the Cameras page lacks a CHANGE PENDING banner. The same test
  fails on the unchanged base build.
- Independent code review completed; rollback findings were fixed and retested.
  The additional cellular changes also received independent review and verification.

K-48's existing limitation remains: a settings apply during a pipeline retry gap
can leave the queued retry using its earlier launch arguments. This hotfix does
not change `PipelineRenderer`.

## Hardware acceptance

Installed on the Raspberry Pi on 2026-09-07. The device runtime was compared with
the build base, and its existing changes were preserved when merging the hotfix.
Five modules were installed: `apply/engine.js`, `daemon/server.js`,
`video/supervisor.js`, `video/autostart.js`, and `net/modem/profiles.js`.
The existing pipeline renderer and earlier telemetry reconnect hotfix retained
their hashes. Original files and the saved configuration were backed up under
`/var/lib/yonder/hotfix-backups/reboot-startup-20260907` on the device.

Camera `cam1` was enabled for autostart through apply and confirm. The resulting
saved configuration was compared with the requested document: every other setting
was retained. Cellular remained connected during apply, and the generated modem
profile reported unlimited activation retries.

After restarting the core:

- `cam1` was running with zero restarts and publishing both MediaMTX paths.
- A Mac over ZeroTier decoded 101 full-stream frames at 1280×720 and 120 preview
  frames at 640×360. Both streams were H.264 at a reported 30 fps.
- The Mac received 104,842 bytes on UDP 14550, including 24 CRC-valid MAVLink
  heartbeats from system 1 and the ground station during a 12-second sample.

A controlled software reboot changed the boot ID from
`2b2c6c0a-8839-4170-b087-bf6152619f5e` to
`4bf8db9e-31f1-4a4f-9819-5fae0603eb12`. No Start, Apply, or cellular reconnect was
issued after that reboot. Cellular and ZeroTier returned; the autopilot was
identified as ArduPlane, system 1, on `/dev/ttyAMA0` at 115200 baud, with about one
heartbeat per second. The camera ran with zero restarts and both streams published.
The Mac received another 100,655 bytes and 24 CRC-valid heartbeats over ZeroTier.
There was no cancelled modem dial, MBIM Busy failure, or failed boot render in that
boot's logs.

The video sample spanning a subsequent restart timed out. A later sample decoded
26 full-stream frames over ZeroTier. Verification of the additional restart and
an operator-confirmed power-off/power-on cycle is still pending. A software reboot
alone does not prove recovery when USB hardware and the autopilot power up together.
