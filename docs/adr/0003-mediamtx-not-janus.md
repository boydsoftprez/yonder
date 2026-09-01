# ADR-0003 — mediamtx instead of Janus

**Status:** accepted · **Date:** 2026-08-31

## Context

Browser preview needs WebRTC. The established option is **Janus Gateway** — GStreamer
sends RTP to loopback and Janus republishes it. Janus is GPL-3.0 and does WebRTC well,
but only WebRTC. **mediamtx** is an MIT-licensed Go server covering WebRTC, RTSP, SRT,
RTMP and HLS in one binary.

## Decision

Use **mediamtx** for all media serving. Do not use Janus.

## Rationale

- One MIT-licensed Go binary provides **WebRTC, RTSP, SRT, RTMP and HLS**. Janus provides
  WebRTC and needs a separate RTSP server beside it.
- **SRT comes free**, and SRT over a lossy cellular link is one of our differentiators.
  Adding it to a Janus design would mean a second server anyway.
- Janus streaming mountpoints are declared statically in configuration. mediamtx paths are
  dynamic, which is what a hardware-generated camera list needs (R-UI-03).
- Removes a GPL-3.0 dependency. We are GPL-3.0 by choice, not by transitive obligation.
- One process to supervise, one control API, one configuration file.

## Consequences

- One media process instead of two.
- WebRTC signalling, RTSP and SRT share one configuration and one control API.
- We inherit mediamtx's behaviour and bugs; its control API becomes an integration
  surface we must version against.
- We are not pinned to H.264 Baseline for preview — mediamtx will carry H.265 to a browser
  that supports it (R-CAM-08).
