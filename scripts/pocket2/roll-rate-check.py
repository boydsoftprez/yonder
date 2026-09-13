#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""One operator-approved, bounded roll-rate check through the daemon's private API.

Run on the board, with the camera secured and all moving joints clear. This
neither changes modes nor starts video. It preserves native guards and grants,
ends on unexpected movement/state, and records feedback through the stop tail.
"""
import argparse
import http.client
import json
import math
import socket
import time
import uuid


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/run/yonder/core.sock')


def api(path, body=None, timeout=1):
    connection = UnixHTTP('localhost', timeout=timeout)
    try:
        connection.request('GET' if body is None else 'POST', path,
                           body=None if body is None else json.dumps(body),
                           headers={'Content-Type': 'application/json'})
        reply = connection.getresponse()
        result = json.loads(reply.read())
        if reply.status != 200:
            raise RuntimeError(f'HTTP {reply.status}: {result}')
        return result
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('camera')
    parser.add_argument('--rate', type=float, required=True)
    parser.add_argument('--seconds', type=float, default=.6)
    args = parser.parse_args()
    if not (0 < abs(args.rate) <= 1 and 0 < args.seconds <= 1):
        parser.error('Use a nonzero rate up to 1 degree/s and duration up to 1 second')
    if not args.camera.isalnum():
        parser.error('Camera must be an alphanumeric configured identifier')
    path = '/cameras/' + args.camera
    owner = 'bench-roll-' + uuid.uuid4().hex
    started = time.monotonic()
    samples = []
    # The full camera report assembles unrelated UI/video state. Read it once;
    # use the existing privileged raw-state read during the short intent lease.
    initial = api(path, timeout=5)
    identity = initial.get('accessory') or {}
    assert identity.get('model') == 'HG211', 'Expected identified Pocket 2'
    assert not any((identity.get('admitted') or {}).values()), 'Another operator is moving the camera'

    def snapshot():
        accessory = api(path + '/aim', {'owner': 'bench-range-roll-observe', 'request': {'op': 'probe-state'}})
        assert accessory.get('accepted'), 'Private feedback read refused'
        attitude = accessory.get('attitude') or {}
        joints = attitude.get('joints') or {}
        assert attitude.get('mode') == 1, 'Select FPV before the check'
        assert all(isinstance(joints.get(axis), (float, int)) and math.isfinite(joints[axis])
                   for axis in ('pan', 'tilt', 'roll')), 'Native joint feedback missing'
        assert not any(attitude.get(flag) for flag in ('fault', 'pitchLimit', 'yawLimit', 'rollLimit')), 'Native fault/limit'
        assert not accessory.get('inhibition'), 'Motion inhibited'
        result = {'t': time.monotonic() - started, 'joints': joints,
                  'quaternion': attitude.get('quaternion'), 'mode': attitude['mode'],
                  'generation': accessory.get('generation'),
                  'notice': accessory.get('notice')}
        samples.append(result)
        return result

    def command(request):
        result = api(path + '/aim', {'owner': owner, 'request': request})
        assert result.get('accepted'), f'Command refused: {result}'
        return result

    before = snapshot()
    assert abs(before['joints']['roll']) < 35, 'Use a central roll pose before probing'
    for _ in range(3):
        time.sleep(.15)
        now = snapshot()
        assert now['generation'] == before['generation'], 'USB generation changed'
        assert all(abs(now['joints'][axis] - before['joints'][axis]) <= .3
                   for axis in ('pan', 'tilt', 'roll')), 'Camera is already moving'
    grant = command({'op': 'probe-roll-issue', 'clientGesture': owner})['grant']
    gesture = grant['gesture']
    error = None
    commands = []
    try:
        until = time.monotonic() + args.seconds
        seq = 0
        while time.monotonic() < until:
            now = snapshot()
            assert now['generation'] == before['generation'], 'USB generation changed'
            assert all(abs(now['joints'][axis] - before['joints'][axis]) < 3
                       for axis in ('pan', 'tilt')), 'Unexpected pan/tilt movement'
            assert abs(now['joints']['roll'] - before['joints']['roll']) < 5, 'Unexpected roll travel'
            if time.monotonic() >= until:
                break
            sent = time.monotonic() - started
            reply = command({'op': 'slew', **grant, 'seq': seq,
                             'pan': 0, 'tilt': 0, 'roll': args.rate})
            commands.append({'sentAt': sent, 'acceptedAt': time.monotonic() - started, 'seq': seq})
            grant = reply.get('next')
            assert grant, 'Rate stopped before completion'
            seq += 1
            time.sleep(.1)
    except Exception as failure:
        error = str(failure)
    finally:
        try:
            command({'op': 'stop', 'gesture': gesture})
        except Exception as failure:
            error = f'{error or ""} Stop failed: {failure}'.strip()
    stopped = time.monotonic() - started
    for _ in range(20):
        time.sleep(.1)
        try:
            snapshot()
        except Exception as failure:
            error = f'{error or ""} Feedback after Stop: {failure}'.strip()
            break
    result = {'requestedRate': args.rate, 'requestedSeconds': args.seconds,
              'stopAt': stopped, 'error': error, 'initialRun': initial.get('run'),
              'commands': commands, 'samples': samples,
              'jointDelta': {axis: samples[-1]['joints'][axis] - before['joints'][axis]
                             for axis in ('pan', 'tilt', 'roll')}}
    print(json.dumps(result, indent=2))
    if error:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
