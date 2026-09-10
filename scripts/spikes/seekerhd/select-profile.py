#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Select a native ISP profile live when supported; legacy installs restart only video/ISP."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('/usr/local/share/yonder-seekerhd')
ACTIVE = ROOT/'iqfiles/imx462_IMX462_default.json'
LOCK = Path('/run/lock/yonder-seekerhd-profile.lock')


def api(path, body=None):
    command = ['curl', '-fsS', '--max-time', '30', '--unix-socket', '/run/yonder/core.sock']
    if body is not None:
        command += ['-X', 'POST', '-H', 'Content-Type: application/json', '--data', json.dumps(body)]
    return json.loads(subprocess.check_output(command+['http://localhost'+path], text=True))


def replace(data):
    temporary = ACTIVE.with_suffix('.next')
    with temporary.open('wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, ACTIVE)


def restart_isp():
    subprocess.run(['systemctl', 'restart', 'yonder-seekerhd-aiq'], check=True, timeout=60)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'yonder-seekerhd-aiq'], check=True)


def wait_video(camera):
    for _ in range(15):
        state = api('/cameras/'+camera)
        if state['run']['state'] == 'running' and state['refusal'] is None:
            return
        time.sleep(1)
    raise RuntimeError('video did not return to running within the verification window')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('profile', choices=['status', 'normal-light', 'low-light', 'legacy-low-light'])
    parser.add_argument('--camera', default='cam0')
    args = parser.parse_args()
    manifest = json.loads((ROOT/'profiles/manifest.json').read_text())
    before = ACTIVE.read_bytes()
    digest = hashlib.sha256(before).hexdigest()
    name = next((name for name, spec in manifest['profiles'].items() if spec['sha256'] == digest), 'custom')
    if args.profile == 'status':
        print(json.dumps({'profile': name, 'sha256': digest, 'capture_mode': 'single exposure; HDR unavailable in this driver'}))
        return
    if os.geteuid() != 0:
        parser.error('profile switching requires root')
    # One writer, including overlapping operator requests.
    with LOCK.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = ACTIVE.read_bytes()
        selected = (ROOT/'profiles'/(args.profile+'.json')).read_bytes()
        if hashlib.sha256(selected).hexdigest() != manifest['profiles'][args.profile]['sha256']:
            raise RuntimeError('profile checksum does not match its generated manifest')
        document = json.loads(selected)
        if document['sensor_calib']['CISHdrSet']['hdr_en']:
            raise RuntimeError('this driver has no HDR mode')
        view = api('/cameras/'+args.camera)
        if view['camera']['source'] != 'csi' or 'imx462' not in (view.get('card') or '').lower():
            raise RuntimeError('the selected camera is not the attached IMX462 CSI sensor')
        if view.get('deck', {}).get('isp', {}).get('available'):
            # The service owns native calibration activation and persistence.
            # A refused/uncertain live write must never fall back to a restart.
            result = api('/cameras/'+args.camera+'/controls', {'kind': 'isp-profile', 'value': args.profile})
            print(json.dumps(result['deck']['isp']))
            return
        was_running = view['run']['state'] in ('running', 'starting', 'backoff')
        try:
            if was_running:
                api('/cameras/'+args.camera+'/run', {'action': 'stop'})
            replace(selected)
            restart_isp()
            if was_running:
                api('/cameras/'+args.camera+'/run', {'action': 'start'})
                wait_video(args.camera)
        except Exception:
            # Restore the exact prior calibration; console/network stay up.
            replace(before)
            api('/cameras/'+args.camera+'/run', {'action': 'stop'})
            restart_isp()
            if was_running:
                api('/cameras/'+args.camera+'/run', {'action': 'start'})
                wait_video(args.camera)
            raise
        print(json.dumps({'profile': args.profile, 'isp_ready': True, 'video_running': was_running,
                          'sha256': hashlib.sha256(selected).hexdigest()}))


if __name__ == '__main__':
    main()
