#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Decode both delivered streams off-board and measure actual frame spacing."""
import argparse
import concurrent.futures
import json
import subprocess
import time


def measure(label, uri, seconds):
    started = time.monotonic()
    run = subprocess.run([
        'ffprobe', '-v', 'error', '-rtsp_transport', 'tcp',
        '-read_intervals', '%+' + str(seconds), '-show_frames',
        '-show_entries', 'frame=best_effort_timestamp_time,width,height',
        '-of', 'json', uri,
    ], capture_output=True, text=True, timeout=seconds + 60)
    frames = json.loads(run.stdout or '{}').get('frames', [])
    if not frames:
        raise RuntimeError(label + ': no decoded frames; ensure the stream is ready')
    stamps = [float(f['best_effort_timestamp_time']) for f in frames
              if 'best_effort_timestamp_time' in f]
    steady = [stamp for stamp in stamps if stamp >= 2]
    if len(steady) < 2:
        raise RuntimeError(label + ': insufficient timestamps after acquisition')
    gaps = [{'at_s': round(b, 4), 'gap_ms': round((b-a)*1000, 3)}
            for a, b in zip(steady, steady[1:]) if b-a > 0.05]
    return {
        'output': label, 'elapsed_s': round(time.monotonic()-started, 2),
        'width': frames[-1].get('width'), 'height': frames[-1].get('height'),
        'decoded_frames': len(frames),
        'steady_fps': (len(steady)-1)/(steady[-1]-steady[0]),
        'gaps_over_50ms': gaps,
        # Do not copy URLs or possible embedded credentials into diagnostics.
        'decoder_diagnostic_lines': len(run.stderr.splitlines()),
        'exit_code': run.returncode,
    }


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--main', required=True)
    args.add_argument('--preview', required=True)
    args.add_argument('--seconds', type=int, default=60)
    options = args.parse_args()
    if options.seconds < 5:
        args.error('--seconds must be at least 5')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
        jobs = [workers.submit(measure, label, uri, options.seconds)
                for label, uri in [('main', options.main), ('preview', options.preview)]]
        print(json.dumps([job.result() for job in jobs], indent=2))


if __name__ == '__main__':
    main()
