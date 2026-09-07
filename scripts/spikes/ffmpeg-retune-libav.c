// SPDX-License-Identifier: GPL-3.0-or-later
//
// Can a program that holds the encoder context retune `h264_v4l2m2m` mid-stream?
//
// This is the half of the question that the previous video spike skipped, and
// the omission cost five tasks. `scripts/spikes/retune-bitrate.py` proved that
// `v4l2h264enc` takes a runtime bitrate change — but it proved it by holding
// the pipeline object itself, a handle that exists only inside a program that
// owns the pipeline. The daemon runs `gst-launch-1.0`, which answers nothing
// once playing, so the proven capability was unreachable in production (K-48,
// K-53).
//
// So for ffmpeg both halves are asked separately. The CLI's own channels are
// tested by `ffmpeg-retune.py`. This program tests the other half: the best
// case, a program holding `AVCodecContext` directly, which is what a pipeline
// host built on libavcodec would have.
//
// It encodes `--frames` frames at `--from` kb/s, then sets `bit_rate` on the
// live context — both by assignment and through `av_opt_set_int`, so that
// neither route can be said to be the one that was not tried — and encodes
// `--frames` more. It prints the measured bitrate of each phase.
//
// A single run cannot answer on its own, because "phase 2 looks like phase 1"
// is also what a working retune to the same value looks like. Run the controls:
//
//     ffmpeg-retune-libav --from 1000 --to 4000     # the change under test
//     ffmpeg-retune-libav --from 1000 --to 1000     # what "no change" looks like
//     ffmpeg-retune-libav --from 4000 --to 4000     # what "changed" would look like
//
// Build:  gcc -O2 -o ffmpeg-retune-libav ffmpeg-retune-libav.c \
//             $(pkg-config --cflags --libs libavcodec libavutil)
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define W 1280
#define H 720
#define FPS 30

// A moving pattern. Rate control has nothing to do against a still image, and
// the camera on this board emits black frames, so the source has to carry its
// own detail for a bitrate to mean anything.
static void fill(AVFrame *f, int n)
{
    for (int y = 0; y < H; y++) {
        uint8_t *row = f->data[0] + (size_t)y * f->linesize[0];
        for (int x = 0; x < W; x++)
            row[x] = (uint8_t)((x * 3 + y * 5 + n * 11) ^ (x >> 2) ^ (y >> 3));
    }
    for (int y = 0; y < H / 2; y++) {
        uint8_t *u = f->data[1] + (size_t)y * f->linesize[1];
        uint8_t *v = f->data[2] + (size_t)y * f->linesize[2];
        for (int x = 0; x < W / 2; x++) {
            u[x] = (uint8_t)(128 + ((x + n) & 31) - 16);
            v[x] = (uint8_t)(128 + ((y - n) & 31) - 16);
        }
    }
}

int main(int argc, char **argv)
{
    long from_kbps = 1000, to_kbps = 4000;
    int frames = 300;
    // Defaults to the Pi's encoder. `--encoder h264_rkmpp`, with
    // LD_LIBRARY_PATH pointing at jellyfin-ffmpeg's lib directory, asks the
    // same question of a Rockchip board. That the name resolves at all is the
    // proof that jellyfin's libavcodec was the one loaded: Debian's, which
    // supplies the headers this is compiled against, has no rkmpp encoder.
    const char *name = "h264_v4l2m2m";
    for (int i = 1; i < argc - 1; i++) {
        if (!strcmp(argv[i], "--from"))   from_kbps = atol(argv[++i]);
        else if (!strcmp(argv[i], "--to"))     to_kbps = atol(argv[++i]);
        else if (!strcmp(argv[i], "--frames")) frames  = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--encoder")) name   = argv[++i];
    }

    const AVCodec *codec = avcodec_find_encoder_by_name(name);
    if (!codec) { fprintf(stderr, "%s not built into this ffmpeg\n", name); return 2; }
    fprintf(stderr, "# encoder %s, libavcodec %u.%u.%u at runtime\n", name,
            avcodec_version() >> 16, (avcodec_version() >> 8) & 0xff,
            avcodec_version() & 0xff);

    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    ctx->width = W; ctx->height = H;
    ctx->pix_fmt = AV_PIX_FMT_YUV420P;
    ctx->time_base = (AVRational){1, FPS};
    ctx->framerate = (AVRational){FPS, 1};
    ctx->bit_rate = from_kbps * 1000;
    ctx->gop_size = 15;
    if (avcodec_open2(ctx, codec, NULL) < 0) {
        fprintf(stderr, "could not open h264_v4l2m2m\n"); return 2;
    }

    AVFrame *frame = av_frame_alloc();
    frame->format = ctx->pix_fmt; frame->width = W; frame->height = H;
    if (av_frame_get_buffer(frame, 32) < 0) { fprintf(stderr, "no frame buffer\n"); return 2; }
    AVPacket *pkt = av_packet_alloc();

    long long bytes[2] = {0, 0};
    long long packets[2] = {0, 0};

    for (int phase = 0; phase < 2; phase++) {
        if (phase == 1) {
            // ---- the change under test, by both routes ffmpeg offers ----
            ctx->bit_rate = to_kbps * 1000;
            av_opt_set_int(ctx, "b", to_kbps * 1000, AV_OPT_SEARCH_CHILDREN);
            fprintf(stderr, "# set bit_rate = %ld kb/s on the live context\n", to_kbps);
        }
        for (int i = 0; i < frames; i++) {
            if (av_frame_make_writable(frame) < 0) break;
            fill(frame, phase * frames + i);
            frame->pts = phase * frames + i;
            if (avcodec_send_frame(ctx, frame) < 0) break;
            while (avcodec_receive_packet(ctx, pkt) == 0) {
                bytes[phase] += pkt->size;
                packets[phase]++;
                av_packet_unref(pkt);
            }
        }
    }
    avcodec_send_frame(ctx, NULL);
    while (avcodec_receive_packet(ctx, pkt) == 0) {
        bytes[1] += pkt->size; packets[1]++; av_packet_unref(pkt);
    }

    double secs = (double)frames / FPS;
    printf("%s: from %ld kb/s -> to %ld kb/s   "
           "phase1 %.3f Mb/s (%lld pkts)   phase2 %.3f Mb/s (%lld pkts)\n",
           name, from_kbps, to_kbps,
           bytes[0] * 8.0 / secs / 1e6, packets[0],
           bytes[1] * 8.0 / secs / 1e6, packets[1]);

    av_packet_free(&pkt); av_frame_free(&frame); avcodec_free_context(&ctx);
    // A phase that produced nothing is not a measurement, and must not be read
    // as a bitrate that fell to zero.
    return (bytes[0] > 0 && bytes[1] > 0) ? 0 : 1;
}
