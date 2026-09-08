# Task 35 report — DUML and AOA protocol/session

Status: DONE

## Production

- `packages/yonder-core/src/video/accessory/duml.ts`
  - DUML v1 encoding and strict decoding, with provenance retained from the
    Python bench reference and dji-firmware-tools.
  - DJI CRC8 seed `0x77` and CRC16 seed `0x3692`.
  - Exact frame-length, field-range, CRC and payload-bound validation.
  - `DumlSplitter` reassembles arbitrary chunks, rejects malformed frames and
    retains at most one bounded DUML frame.
- `packages/yonder-core/src/video/accessory/aoa.ts`
  - Exact phone/accessory FunctionFS descriptor and string blocks ported from
    `aoa_stage.py`.
  - Strict helpers for AOA GET_PROTOCOL, SEND_STRING and START setup requests.
  - Bounded `55 cc` envelope parser with split-magic recovery and explicit
    command `49 57` and video `4a 57` routes.
  - Pocket 2 video-record parser removes the observed 16-byte record and emits
    Annex-B H.264 plus its timestamp and retained unknown metadata field.
  - `AccessorySession` accepts an injected abortable bulk writer. It exposes
    raw validated DUML frames and H.264 access units on separate callbacks.
  - Session transmission starts only after `enable()`: after the measured
    500 ms settle it sends ping, get-version and get-device-info. Each second
    thereafter it sends general `0x0e` with `ack=0`, then general `0x00` with
    `ack=1`, which is the measured video keep-alive.
  - An unsolicited request with non-zero acknowledgement mode receives status
    `00`, response=true, ack=0, the same sequence, command and reversed device
    address, matching the bench session.
  - Writes are serialized. `disconnect()` and `close()` clear liveness timers,
    abort the active write, invalidate queued writes and discard partial input.
    Transport and parser errors reach `onError`; close is permanent.
  - `sendCommand` accepts a per-command `AbortSignal`. It is combined with the
    session signal for an active write and checked again at actual serialized
    dispatch, so expired motion queued behind backpressure cannot be sent.

No gimbal motion command or camera-control policy is present. No daemon,
FunctionFS file-descriptor adapter, flow or hardware integration was added.

## Test-first evidence

Initial focused run, before production files existed:

```text
npx vitest run src/video/accessory/duml.test.ts src/video/accessory/aoa.test.ts --root packages/yonder-core
FAIL: ./duml.js and ./aoa.js did not exist
```

The fixed golden values were generated independently with
`scripts/pocket2/duml.py`:

```text
ping-seq-7              55 0d 04 33 22 01 07 00 20 00 00 16 a7
heartbeat-seq-0x1234    55 0d 04 33 22 01 34 12 00 00 0e 99 7e
camera-payload          55 0f 04 a2 22 01 cd ab 20 02 2c 03 07 5e 8a
CRC8("123456789")       fb
CRC16("123456789")      7109
```

CRC seed mutations were made one at a time in production, tested, then
restored:

```text
CRC8  0x77 -> 0x76: Python golden test failed; independent round-trip passed.
CRC16 0x3692 -> 0x3693: Python golden test failed; independent round-trip passed.
```

This demonstrates why both the fixed references and round trips are present.

## Verification

```text
npx vitest run src/video/accessory/duml.test.ts src/video/accessory/aoa.test.ts --root packages/yonder-core
2 files passed; 26 tests passed

npm run build -w yonder-core
exit 0; TypeScript and asset copy passed

npm test -w yonder-core
116 files passed, 1 failed; 2814 tests passed, 1 failed
```

The full-core failure is outside Task 35:
`src/apply/engine.test.ts > ApplyEngine > reserves the configuration while
boot renderers are running` expects `/pending/`, while the implementation says
`an apply is still being carried out; wait for it to finish`. Task 35 files are
not in that path. `flows.test.ts` passed on this rebased base.

Self-review checked the brief line by line, malformed-length recovery, split
magic, exact Python descriptor bytes, input bounds, callback separation,
timer lifecycle, session and per-command abort propagation, dispatch-time
admission, address reversal and the absence of any motion-producing path.
