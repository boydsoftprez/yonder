# SPDX-License-Identifier: GPL-3.0-or-later
FROM bluenviron/mediamtx:1.20.1 AS media
FROM debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends nodejs python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-rtsp iproute2 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=media /mediamtx /usr/local/bin/mediamtx
WORKDIR /work
