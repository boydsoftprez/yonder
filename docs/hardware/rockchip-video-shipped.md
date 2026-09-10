# Rockchip video through the shipped pipeline

Board observations on 2026-09-08 for the
[Rockchip and ground-station plan](../superpowers/plans/2026-09-07-rockchip-video-and-ground-station.md).
The shipped H.264 main and preview now pass repeated RTSP startup and decoding
on the Mac over ZeroTier. Live Apply and timed rollback are measured below.
Browser playback and the cellular leg remain separate acceptance checks.

## What was in front of us

| Item | Observed |
|---|---|
| Board | Radxa Zero 3W, RK3566 |
| System | Armbian 26.8.1 trixie, kernel `6.1.115-vendor-rk35xx` |
| Camera | USB `1d6b:0102`, “Webcam gadget: UVC HD Camera”, `/dev/video0`, MJPEG 1280×720 at 30 fps |
| Camera identity | `platform-xhci-hcd.4.auto-usb-0:1:1.0-video-index0` |
| MPP commit | `0986d01294d5c2449c14cf13af9b740368c33967` |
| librga commit | `2b32edcb97b601b25683e2941d888c8515da6d55` |
| GStreamer Rockchip commit | `a0d45af504099b4b82f3d3377019a63d357e7cef` |
| Installed plugin SHA-256 | `dffee35cc29ae287fea42f2d2c67c4a5d379f5a7046ce1bd1dbb8892bc72da3b` |
| Uplink during these measurements | Wi-Fi, with a direct ZeroTier peer to the ground station |
| Modem / physical autopilot | No modem enumerated; no physical heartbeat measured on `/dev/ttyS2` |

The plugin digest matches the payload. The camera supplied a real indoor image
in this session; the earlier handoff's black-frame caveat does not describe
these measurements. Both captured images were inspected, at 1280×720 and
640×360. They were upside down; orientation was left as configured. Private
camera images are not included in this repository.

## Installation and discovery

The board was already installed through the plan's roles. Subsequent daemon
changes were built with `npm run build`, synchronized to the staged core package,
and installed with `./installer/install.sh --only 20-yonder-core`.
`yonder-core`, `yonder-console` and `mediamtx` were active afterward. The role's
module-graph check passed. The staged vendor payload was retained: a vendor sync
must not use `rsync --delete`.

`GET /cameras/cam0` reported:

```json
{"element":"mpph264enc","h265":"mpph265enc","decoder":"mppjpegdec",
 "device":"/dev/mpp_service","hardware":true,
 "detail":"hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)"}
```

The camera's refusal was `null`. Its pipeline uses `mppjpegdec`, then a raw tee:
the main encoder is `mpph264enc name=enc-stream bps=2000000 max-pending=1`;
the preview is
`videorate ! capsfilter name=preview-rate caps=video/x-raw(ANY),framerate=15/1 !
mpph264enc name=enc-preview bps=400000 max-pending=1 gop=15 width=640 height=360`
(properties abbreviated and reordered for readability).
Both branches parse H.264 and publish to local MediaMTX. RGA scaling is inside
the preview encoder; there is no `v4l2convert` or software scaler in this graph.

## The probe's cost and the camera's cost

CPU busy was measured from two `/proc/stat` samples ten seconds apart, using
the first eight counters: `(total − idle − iowait) / total`. Load average is
not a CPU percentage, and hardware wait is not CPU work.

| State | Busy, all four cores |
|---|---:|
| Before the shared probe cache, camera stopped | 80.83% |
| After the cache, camera stopped | 28.34% |
| After the cache, H.264 main and preview running | 30.85% |

Twenty camera GETs after the fix completed in 17.09 seconds and left no
`gst-plugin-scanner` processes. The running camera added 2.51 percentage points
in this pair of samples. This is a short measurement of this camera and scene,
not a sustained-load or cross-camera comparison.

## Re-running the existing Rockchip bench library

The unchanged [camera-path bench](../../scripts/spikes/rockchip-camera-path.py)
was run with `--device /dev/video0 --repeat 1`, while the daemon's camera was
stopped. All five arms produced 300 decoded frames in each output.

| Arm | Elapsed | Busy |
|---|---:|---:|
| Hardware decode, one encode | 12.18 s | 27.5% |
| Software decode, one encode | 10.33 s | 37.6% |
| Hardware decode, two encodes, RGA preview | 10.47 s | 32.3% |
| Hardware decode, two encodes, software preview scaler | 10.43 s | 52.1% |
| Software decode, two encodes, RGA preview | 12.15 s | 33.4% |

The bench's idle sample was 27.0%. Its outputs are files; these results do not
certify RTSP startup. Startup overhead is included in elapsed time.

The unchanged [live-retune bench](../../scripts/spikes/retune-bitrate-mpp.py),
with `--element mpph264enc --camera /dev/video0`, measured **0.98 → 3.92 Mb/s**
and no timestamp gaps after the retune. `camguard.sh check`, with
`YONDER_CAM_PORT=1-1` for this board's gadget port, passed.

## Manual Apply and timed rollback

An initial manual Apply exposed a missing integration: requesting 3500 kb/s
changed the measured bitrate, but restarted the process while returning an empty
interruption list. The live channel was wired only to adaptation. The corrected
daemon shares it with the pipeline renderer and reports the observed outcome.

After installing commit `fcc98d1`, the actual camera route was exercised:

```sh
curl --unix-socket /run/yonder/core.sock -H 'Content-Type: application/json' \
  -d '{"streamBitrate":3500}' http://localhost/cameras/cam0/apply
```

The response reported `video.outcome: "retuned"`, `continuous: true` and
`interruption: []`. Measured packet bytes over approximately ten seconds changed
from **2.005 to 3.590 Mb/s**. `run.since` remained `1788841732423`, with zero
restarts. The returned apply ID was confirmed through `POST /confirm`.

A second change to 2000 kb/s was deliberately left unconfirmed:

| Point | Packet bytes | Interval | Measured bitrate | PID |
|---|---:|---:|---:|---:|
| Pending change | 2,551,782 | 9.998 s | 2.0419 Mb/s | 340845 |
| After the 120-second timer restored 3500 | 4,373,082 | 10.006 s | 3.4965 Mb/s | 340845 |

Both samples contained 301 packets. The same `since` and zero restarts held
through rollback. No board reboot or daemon restart occurred. Bitrate changes
retain the confirmation window; the live operation does not bypass it.

After deploying `ceea47f`, the same route measured **2.0346 → 3.5035 Mb/s**,
again reporting a continuous retune. An unconfirmed change measured 2.0265 Mb/s;
`POST /revert` with its returned ID restored **3.5354 Mb/s**. All four samples
used PID 421274, `since: 1788844270505`, and zero restarts. Both forward changes
reported `continuous: true`, `interruption: []`. The full 120-second timer test
above was performed on `fcc98d1`; this final-deployment repeat used explicit
revert and confirms live control with the pending-frame bound in place.

## RTSP startup: cause, fix and measured result

The working daemon delivered both main and preview H.264. However, Stop followed
by Start also reproduced a preview timeout with zero supervisor restarts. A live
retune on that stalled process did not recover it, and correctly reported a
break in the picture. Consequently, process liveness alone does not establish
video health.

The same failure occurred with the exact graph under `gst-launch-1.0`. Forcing
TCP on the publishers did not fix it. A minimal Python GStreamer runner could
carry both streams, but adding the shipped host's continuity probe could expose
the stall and block NULL teardown. Native stacks located the preview task inside
`mpi_encode_put_frame`, waiting for an MPP input task while holding the encoder's
stream lock.

The exact pinned sources explain the deadlock:

- The [plugin encoder](https://github.com/JeffyCN/mirrors/blob/a0d45af504099b4b82f3d3377019a63d357e7cef/gst/rockchipmpp/gstmppenc.c)
  defaults to sixteen pending input frames and submits its batch before draining
  output packets (lines 84–85 and 1084–1088).
- [MPP initialization](https://github.com/rockchip-linux/mpp/blob/0986d01294d5c2449c14cf13af9b740368c33967/mpp/mpp.c)
  overrides the requested nonblocking input on RK3566 with blocking input and
  eight output task slots (lines 218–225).

Submitting the batch can fill the output queue and block the same task that must
drain it. Commit `ceea47f` sets the existing `max-pending=1` property on both MPP
encoders. The H.265 main encoder gets the same bound; preview remains H.264.
No host, transport or vendor binary change was needed for this fix (K-67).

The new [RTSP restart bench](../../scripts/spikes/rockchip-rtsp-restarts.py)
accepts the actual pipeline-host argv as a JSON array, uses it verbatim, reads
both outputs concurrently and fails on short/empty delivery, low requested FPS,
reader failure, an unexpected host exit or shutdown requiring SIGKILL:

```sh
python3 scripts/spikes/rockchip-rtsp-restarts.py \
  --argv-json /tmp/camera-argv.json --workdir /tmp/rtsp-restarts \
  --ffprobe /usr/lib/jellyfin-ffmpeg/ffprobe --min-fps 28 14
```

Three candidate abrupt stop/start cycles passed. A separate trial with only five
seconds of warmup failed once: the reader attached to the previous UDP publisher,
whose ten-second MediaMTX idle expiry then ended the reader. Logs identified that
old session. Repeating with twelve seconds of warmup passed all three cycles,
with 29.967–30.024 fps main, 15 fps preview, empty reader stderr and no SIGKILL.
The shipped bench defaults to the plan's fifteen-second warmup. This does not
establish a startup-time bound shorter than that warmup.

After building and installing the committed composer through `20-yonder-core`,
three ordinary daemon Stop/Start cycles each warmed up for fifteen seconds and
sampled both outputs concurrently for three seconds:

| Cycle | Main H.264 1280×720 | Preview H.264 640×360 | Unexpected restarts |
|---|---:|---:|---:|
| 1 | 30.067 fps / 91 packets | 15 fps / 46 packets | 0 |
| 2 | 30.026 fps / 91 packets | 15 fps / 46 packets | 0 |
| 3 | 29.986 fps / 91 packets | 15 fps / 46 packets | 0 |

All six readers exited without stderr. Each running process's actual argv
contained two `max-pending=1` properties. Packet PTS establishes delivery rates;
it does not by itself establish decoded picture quality.

The Mac then decoded both RTSP streams over ZeroTier with FFprobe
`-rtsp_transport tcp -read_intervals %+5 -count_frames`: 135 main frames and
73 preview frames, at the dimensions above, with zero exit status and no decoder
stderr. This validates receiver decoding separately from the packet-rate bench.

## H.265 main with H.264 preview

On the final deployment, `POST /cameras/cam0/apply` with `{"codec":"h265"}`
reported a picture restart and changed the running process. After fifteen
seconds, concurrent three-second samples measured:

| Output | Codec / dimensions | Delivery |
|---|---|---:|
| `cam0` | HEVC, 1280×720 | 29.945 fps / 91 packets |
| `cam0-preview` | H.264, 640×360 | 15 fps / 46 packets |

Neither reader reported stderr. The main stream measured **3.5486 Mb/s** at
3500 kb/s. Applying 2000 kb/s reported a continuous retune and measured
**2.0462 Mb/s**, with PID 435762, `since: 1788844698365`, and zero restarts
unchanged. The bitrate change was confirmed; the codec-only change had no
confirmation timer, as designed.

The Mac's five-second FFprobe sample decoded 144 HEVC main frames and 62 H.264
preview frames. The preview had no stderr; HEVC reported missing references
while joining, so it did not pass the stricter no-decoder-stderr check. A
fifteen-second FFmpeg decode then produced 433 frames and exited zero. All
reference diagnostics appeared at 0.865–0.867 seconds after launch, with none
later in that sample. The observations are consistent with joining mid-GOP;
they do not establish a clean HEVC join or its cause. H.264's receiver samples
above were clean.

## UART and ground-station observations

The Armbian state was already applied: `console=display`, `extraargs=cma=256M`,
and `user_overlays=dwc3-host uart2-m0`. The serial gettys for `ttyS2` and
`ttyFIQ0` were disabled. The UART role found this state in place, establishing
idempotency. No reboot was performed in this session, so this is not a second
clean-reboot proof of camera identity.

A temporary pseudo-terminal emitting MAVLink v2 ArduCopter heartbeats was selected
through `/apply` and confirmed. Mission Planner 1.3.83 on the Mac, listening on
UDP 14550 over ZeroTier, sent traffic back: `gcs0.answering` was `true`,
`lastHeardMs` was 121, and the synthetic source received 1,178 bytes.
Its heartbeat-only implementation supplies no parameter list, so Mission Planner
remained at “Getting Params”. This proves bidirectional router/ground-station
traffic, not physical flight-controller telemetry or completed parameter download.

The temporary source was stopped and the configuration restored through `/apply`
to `/dev/ttyS2`, baud `auto`. The configured ground-station endpoint was retained.
The test also exposed stale selected-serial status; `fcc98d1` clears the previous
identity after a successful fully pinned router start, without claiming an
autopilot has been detected.

A repeat after that fix selected the temporary port at 115200 baud and correctly
reported it immediately with unknown vehicle/heartbeat observations. After
fifteen seconds it measured 0.9566 heartbeats/s, `gcs0.answering: true`,
`lastHeardMs: 37`, and 531 bytes received by the synthetic source. The phase was
still `searching`, with unknown vehicle identity: a selected port and received
heartbeats are not a completed identity probe. The temporary source was again
terminated and `/dev/ttyS2`, baud `auto`, restored.

## Not settled

- Browser WebRTC playback. The deployed flow and picture bundle match this
  branch, but the picture endpoint reports an unauthenticated session. Reload
  reached the administrator login, and the Mac was locked during subsequent
  UI checks. The current camera capture was compared with the ELP Live blueprint;
  this is not a successful playback check. The missing codec control remains K-65.
- A clean HEVC receiver join: decoding continues after initial missing-reference
  diagnostics, but those diagnostics have not been resolved.
- Mission Planner's own video decoder on macOS and physical flight-controller data.
- Cellular transport: no modem was enumerated during the measurements.
- Rockchip latency, long-duration load, quality across sources and sizes, and the
  camera's second clean reboot.

## Source verification

The final code passed 114 core test files / 2,768 tests, the 109-test composer,
host and manual-Apply subset, TypeScript, the exact CI shellcheck command,
installer dry-run and the full workspace build. Two new composer regressions
failed without the pending-frame bound and passed with it. The whole-branch
review found three actionable defects; the consolidated fixes and one scoped
re-review resolved all three without identifying another actionable code defect.
These source checks do not close the unmeasured acceptance items above.

## State left on the board

The camera was restored through Apply to H.264, 1280×720 at 30 fps, main
2000 kb/s, preview 400 kb/s at 640×360 and 15 fps, then stopped through the
camera API. It reported `stopped`, zero restarts and `refusal: null`; no
pipeline host remained. Autostart remains disabled. Serial is `/dev/ttyS2`,
baud `auto`, with the ground-station endpoint retained. Temporary synthetic
telemetry sources and diagnostic processes have ended.
