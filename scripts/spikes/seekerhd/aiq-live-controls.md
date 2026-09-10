# SeekerHD live ISP control protocol

The patched `rkaiq_3A_server` owns a root-only Unix stream socket at
`/run/yonder-seekerhd/isp.sock`. The directory is mode `0700` and the socket is
mode `0600`. The socket controls the first usable RKISP media device found by
the server. Every successful response identifies that choice through `device`
and `sensor`; callers must check both before presenting or changing controls.

Each connection carries one printable ASCII request terminated by `\n`. The
request body is limited to 256 bytes. The server sends one JSON object followed
by `\n` and closes the connection. Client reads and writes have a two-second
timeout inside the server.

Accepted requests are:

```text
status
profile normal-light
profile low-light
profile legacy-low-light
set brightness 0
set contrast 128
set saturation 255
set hue 128
```

The four values are integers from 0 through 255. Profile and control writes are
rejected while AIQ is stopped. `status` remains available and returns the most
recent RKAIQ values. A success response has this shape:

```json
{"ok":true,"profile":"normal-light","running":true,"device":"/dev/video0","sensor":"m00_b_imx462 3-001a","values":{"brightness":128,"contrast":128,"saturation":128,"hue":128}}
```

`profile` is `null` when the active IQ file did not exactly match a known
preset when AIQ initialized, or when a rollback could not restore a known
calibration. The identity is cached and changes only after a successful native
profile update; status polling does not reread the large IQ files. Runtime color
changes do not alter that identity. Failures have this
shape:

```json
{"ok":false,"error":"invalid request"}
```

Profile names map to fixed files under
`/usr/local/share/yonder-seekerhd/profiles`. The server opens them without
following symlinks and requires a regular, root-owned file that is not writable
by group or other. It applies the preset through a stable allowlisted path so
RKAIQ's permanent path-keyed calibration cache stays bounded, resets and reads
back the live color values, and atomically
persists the exact preset bytes to
`/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json`. A failed
transaction reapplies the cached previous preset (or the boot IQ cache),
restores the prior runtime color values, and restores the prior active-file
bytes.

Replacing the generated preset files requires an ISP service restart to reload
RKAIQ's cache. Ordinary selection among those installed presets is live.
Install generated profiles with root ownership and mode 0644; archives copied
from a development machine can otherwise retain its numeric user ID and be
refused by the bridge.

The patch applies after `aiq-server.patch`, `aiq-thread-fallback.patch`, and
`aiq-sensor-timing.patch`. Only the first patch changes the 3A server source;
the other two change RKAIQ library files.

An isolated native build can be made on the target without installing it:

```sh
mkdir -p /var/lib/yonder/seekerhd-bringup/live-controls
cp -a /var/lib/yonder/seekerhd-bringup/rkaiq-src/rkaiq_3A_server /var/lib/yonder/seekerhd-bringup/live-controls/
ln -s /var/lib/yonder/seekerhd-bringup/rkaiq-src/rkaiq /var/lib/yonder/seekerhd-bringup/live-controls/rkaiq
cd /var/lib/yonder/seekerhd-bringup/live-controls
patch -p1 < aiq-live-controls.patch
AIQ=/var/lib/yonder/seekerhd-bringup/rkaiq-src/rkaiq
LIVE=/var/lib/yonder/seekerhd-bringup/live-controls
INCLUDES="-I$AIQ/include -I$AIQ/include/algos -I$AIQ/include/uAPI2 -I$AIQ/include/xcore -I$AIQ/include/common -I$AIQ/include/iq_parser -I$AIQ/include/iq_parser_v2 -I$AIQ/include/isp -I$LIVE/rkaiq_3A_server/include/common/mediactl -I$LIVE/rkaiq_3A_server -I$LIVE/rkaiq_3A_server/common"
mkdir -p "$LIVE/build"
cc -DISP_HW_V21 -D_CRT_SECURE_NO_WARNINGS -O3 -DNDEBUG -DADD_RK_AIQ $INCLUDES -c "$LIVE/rkaiq_3A_server/common/mediactl/mediactl.c" -o "$LIVE/build/mediactl.c.o"
c++ -DISP_HW_V21 -D_CRT_SECURE_NO_WARNINGS -Wall -std=c++11 -fPIC -O3 -DNDEBUG -DADD_RK_AIQ $INCLUDES -c "$LIVE/rkaiq_3A_server/rkaiq_3A_server.cpp" -o "$LIVE/build/rkaiq_3A_server.cpp.o"
c++ "$LIVE/build/rkaiq_3A_server.cpp.o" "$LIVE/build/mediactl.c.o" /var/lib/yonder/seekerhd-bringup/rkaiq-build/rkaiq/all_lib/Release/librkaiq.so -Wl,-rpath,/usr/local/lib/yonder-seekerhd -lpthread -ldl -o "$LIVE/build/rkaiq_3A_server"
```

The resulting scratch artifact is
`/var/lib/yonder/seekerhd-bringup/live-controls/build/rkaiq_3A_server`. Building
it does not install it or interact with the active camera service.

For deployment validation, keep the existing stream running and record the AIQ
service PID, activation timestamp, camera run state, and RKISP frame counters.
Send `status`, one control write, and each profile request, checking the returned
device and IMX462 sensor identity plus exact value readback. The PID and service
activation timestamp must remain unchanged, the camera must stay running, and
frame counters must continue advancing. Invalid commands, unknown profiles,
out-of-range values, missing newlines, and requests longer than 256 bytes must
return an error without changing the active profile or values. This validation
does not require storing or inspecting camera frames.

Browser recovery validation (R-VID-03/14): keep the preview visible while
changing presets, then check that its media clock continues to advance. Sensor
frame counters alone cannot establish that the browser is still decoding. A
connected WebRTC session can receive bytes indefinitely without decoding another
frame after damaged RTP. The picture widget therefore checks decoded-frame
progress and retries after five seconds of visible decoder inactivity. Hidden
or offscreen video and blocked autoplay do not trigger this recovery.

On the RK3566 dual H.265 path, local RTSP publication over negotiated UDP lost
RTP fragments. Interleaved TCP publication with the existing zero configured
latency eliminated those warnings in the follow-up test; downstream delivery to
the browser and configured ground-station RTP outputs retain their transports.
Receiver jitter-buffer and decode-time readings are useful comparisons, but do
not establish total camera-to-screen latency. Preset testing must include these
receiver checks as well as the native service and frame-counter checks above.

Live slider validation (R-CTL-16): test dragging, not just clicks or direct
control requests. Previously every pointer movement sent a native command. Each
command also built a full camera view, and the console requested another view
afterward. A drag could therefore saturate the core HTTP accept queue and cause
the configuration-service timeout even though the native ISP write was fast.
ISP sliders now move locally and send one changed value on release. Regression
tests cover 70 pointer movements producing one command, cancellation and
unchanged values. Three consecutive brightness drags in Chrome produced exactly
three core control POSTs, with zero queued connections and no configuration
error. The browser update required no core, pipeline or AIQ restart.
