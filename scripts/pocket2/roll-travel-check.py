#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Move a secured Pocket 2 through one bounded, operator-requested roll travel.

Run on the board only after the production HG211 roll capability is installed.
The handle must be secured flat, screen up, with the moving head clear. The
script uses the ordinary public intent chain, never an angle command or private
roll-probe grant, and records native feedback through a two-second stop tail.
"""
import argparse
import http.client
import json
import math
import os
import signal
import socket
import sys
import time
import uuid


MAX_RATE = 1.0
MAX_DEGREES = 30.0
MAX_MOTION_SECONDS = 45.0
TAIL_SECONDS = 2.0
SAMPLE_SECONDS = 0.1


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


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def finite_number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def validate_attitude(attitude):
    require(isinstance(attitude, dict), 'Fresh native joint feedback is unavailable')
    joints = attitude.get('joints')
    require(isinstance(joints, dict) and all(finite_number(joints.get(axis))
            for axis in ('pan', 'tilt', 'roll')), 'Fresh native joint feedback is unavailable')
    require(attitude.get('mode') == 1, 'Select FPV before the check')
    require(not any(attitude.get(flag) for flag in
                    ('fault', 'pitchLimit', 'yawLimit', 'rollLimit')), 'Native fault/limit')
    return joints


def validate_initial(initial, rate):
    require(isinstance(initial, dict), 'Camera report is malformed')
    accessory = initial.get('accessory')
    require(isinstance(accessory, dict), 'Accessory camera report is unavailable')
    source_input = accessory.get('input')
    require(isinstance(source_input, dict) and source_input.get('live') is True
            and accessory.get('manufacturer') == 'DJI' and accessory.get('model') == 'HG211',
            'Expected a live identified DJI HG211')
    validate_attitude(accessory.get('attitude'))
    require(not accessory.get('inhibition'), f"Motion inhibited: {accessory.get('inhibition')}")
    require(not accessory.get('motionNotice'), f"Motion notice: {accessory.get('motionNotice')}")
    control = accessory.get('rollControl')
    require(isinstance(control, dict) and control.get('available') is True,
            'HG211 production roll control is unavailable')
    require(finite_number(control.get('maxRate')) and control['maxRate'] >= abs(rate),
            'Requested rate exceeds the reported production roll cap')
    admitted = accessory.get('admitted')
    require(isinstance(admitted, dict), 'Admitted motion state is unavailable')
    require(all(finite_number(admitted.get(axis, 0)) for axis in ('pan', 'tilt', 'roll')),
            'Admitted motion state is malformed')
    require(not any(admitted.get(axis, 0) != 0 for axis in ('pan', 'tilt', 'roll')),
            'Another operator is moving the camera')
    require(finite_number(accessory.get('generation')), 'USB generation is unavailable')
    return accessory


def run_check(camera, rate, degrees, api_call=api, now=time.monotonic,
              sleep=time.sleep, owner=None):
    require(isinstance(camera, str) and camera.isalnum(),
            'Camera must be an alphanumeric configured identifier')
    require(finite_number(rate) and 0 < abs(rate) <= MAX_RATE,
            'Use a nonzero signed rate up to 1 degree/s')
    require(finite_number(degrees) and 0 < degrees <= MAX_DEGREES,
            'Use travel greater than zero and at most 30 degrees')
    owner = owner or 'bench-roll-travel-' + uuid.uuid4().hex
    require(isinstance(owner, str) and len(owner) <= 128
            and all(char.isalnum() or char in '_.:-' for char in owner), 'Invalid owner')

    started = now()
    path = '/cameras/' + camera
    samples = []
    commands = []
    tail_errors = []
    initial = None
    before = None
    target = None
    expected_generation = None
    gesture = None
    issue_timing = None
    stop_timing = None
    target_reached = False
    error = None
    stop_tail_seconds = 0.0
    previous_travel_sample = None

    def elapsed():
        return now() - started

    def lightweight(phase):
        response = api_call(path + '/aim', {
            'owner': 'bench-range-roll-observe',
            'request': {'op': 'probe-state'},
        }, timeout=1)
        require(isinstance(response, dict) and response.get('accepted') is True,
                'Private feedback read refused')
        joints = validate_attitude(response.get('attitude'))
        require(not response.get('inhibition'), f"Motion inhibited: {response.get('inhibition')}")
        require(not response.get('notice'), f"Motion notice: {response.get('notice')}")
        require(response.get('generation') == expected_generation, 'USB generation changed')
        sample = {
            't': elapsed(), 'phase': phase,
            'joints': {axis: joints[axis] for axis in ('pan', 'tilt', 'roll')},
            'quaternion': response['attitude'].get('quaternion'),
            'mode': response['attitude']['mode'], 'generation': response.get('generation'),
        }
        if before is not None:
            sample['progressDegrees'] = (-1 if rate > 0 else 1) * (
                joints['roll'] - before['joints']['roll'])
        samples.append(sample)
        return sample

    def validate_travel(sample):
        nonlocal previous_travel_sample
        require(abs(sample['joints']['roll']) <= 35,
                'Native roll left the -35 to 35 degree check range')
        require(abs(sample['joints']['pan'] - before['joints']['pan']) <= 3
                and abs(sample['joints']['tilt'] - before['joints']['tilt']) <= 3,
                'Unexpected pan/tilt movement greater than 3 degrees')
        require(sample['progressDegrees'] >= -0.3,
                'Unexpected roll movement opposite the requested direction')
        require(previous_travel_sample is None or
                abs(sample['joints']['roll'] - previous_travel_sample['joints']['roll']) <= 3,
                'Implausible native roll jump greater than 3 degrees')
        previous_travel_sample = sample

    try:
        initial = api_call(path, timeout=5)
        accessory = validate_initial(initial, rate)
        expected_generation = accessory['generation']
        before = lightweight('preflight')
        previous_travel_sample = before
        require(abs(before['joints']['roll']) <= 35,
                'Use a central native roll pose between -35 and 35 degrees')
        target = before['joints']['roll'] - math.copysign(degrees, rate)
        require(-35 <= target <= 35,
                f'Requested target {target:.1f} is outside the -35 to 35 degree check range')
        for _ in range(3):
            sleep(0.15)
            stationary = lightweight('preflight')
            require(all(abs(stationary['joints'][axis] - before['joints'][axis]) <= 0.3
                        for axis in ('pan', 'tilt', 'roll')), 'Camera is already moving')
            previous_travel_sample = stationary

        submitted = elapsed()
        issued = api_call(path + '/aim', {
            'owner': owner, 'request': {'op': 'issue', 'clientGesture': owner},
        }, timeout=1)
        accepted = elapsed()
        issue_timing = {'submittedAt': submitted, 'acceptedAt': accepted,
                        'accepted': isinstance(issued, dict) and issued.get('accepted') is True}
        require(issue_timing['accepted'], f'Public issue refused: {issued}')
        grant = issued.get('grant')
        require(isinstance(grant, dict) and isinstance(grant.get('gesture'), str),
                'Public issue returned no usable grant')
        gesture = grant['gesture']
        motion_deadline = now() + MAX_MOTION_SECONDS
        sequence = 0

        while True:
            sample = lightweight('motion')
            validate_travel(sample)
            if ((rate > 0 and sample['joints']['roll'] <= target)
                    or (rate < 0 and sample['joints']['roll'] >= target)):
                target_reached = True
                break
            require(now() < motion_deadline, '45 second absolute motion deadline reached before target')

            entry = {'seq': sequence, 'submittedAt': elapsed(),
                     'credentialDeadline': grant.get('deadline')}
            try:
                reply = api_call(path + '/aim', {'owner': owner, 'request': {
                    'op': 'slew', **grant, 'seq': sequence,
                    'pan': 0, 'tilt': 0, 'roll': rate,
                }}, timeout=1)
                entry['acceptedAt'] = elapsed()
                entry['accepted'] = isinstance(reply, dict) and reply.get('accepted') is True
                if isinstance(reply, dict) and not entry['accepted']:
                    entry['reason'] = reply.get('reason')
                require(entry['accepted'], f'Public slew refused: {reply}')
                next_grant = reply.get('next')
                require(isinstance(next_grant, dict), 'Rate stopped before reaching target')
                grant = next_grant
            finally:
                commands.append(entry)
            sequence += 1
            sleep(SAMPLE_SECONDS)
    except Exception as failure:
        error = str(failure)
    finally:
        if gesture is not None:
            stop_timing = {'submittedAt': elapsed()}
            try:
                reply = api_call(path + '/aim', {
                    'owner': owner, 'request': {'op': 'stop', 'gesture': gesture},
                }, timeout=1)
                stop_timing['acceptedAt'] = elapsed()
                stop_timing['accepted'] = isinstance(reply, dict) and reply.get('accepted') is True
                if not stop_timing['accepted']:
                    raise RuntimeError(f'Stop refused: {reply}')
            except Exception as failure:
                stop_timing['accepted'] = False
                stop_timing['error'] = str(failure)
                error = f'{error + "; " if error else ""}Stop failed: {failure}'

            tail_started = now()
            while now() - tail_started < TAIL_SECONDS:
                sleep(min(SAMPLE_SECONDS, TAIL_SECONDS - (now() - tail_started)))
                try:
                    tail = lightweight('stop-tail')
                    validate_travel(tail)
                except Exception as failure:
                    tail_errors.append({'t': elapsed(), 'error': str(failure)})
            stop_tail_seconds = now() - tail_started

    if tail_errors:
        error = f'{error + "; " if error else ""}Stop-tail feedback failed: {tail_errors[0]["error"]}'
    final_sample = samples[-1] if samples else None
    joint_delta = None
    overshoot = None
    if before is not None and final_sample is not None:
        joint_delta = {axis: final_sample['joints'][axis] - before['joints'][axis]
                       for axis in ('pan', 'tilt', 'roll')}
        directed_travel = (-1 if rate > 0 else 1) * joint_delta['roll']
        overshoot = max(0.0, directed_travel - degrees)
        if target_reached and overshoot > 1:
            error = f'{error + "; " if error else ""}Stop-tail roll overshoot exceeded 1 degree'

    return {
        'camera': camera, 'requestedRate': rate, 'requestedDegrees': degrees,
        'targetRoll': target, 'targetReached': target_reached,
        'absoluteMotionLimitSeconds': MAX_MOTION_SECONDS,
        'initialRun': initial.get('run') if isinstance(initial, dict) else None,
        'issue': issue_timing, 'commands': commands, 'stop': stop_timing,
        'stopTailSeconds': stop_tail_seconds, 'stopTailErrors': tail_errors,
        'samples': samples, 'jointDelta': joint_delta, 'rollOvershoot': overshoot,
        'error': error,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('camera')
    parser.add_argument('--rate', type=float, required=True,
                        help='signed roll rate, nonzero and at most 1 degree/s')
    parser.add_argument('--degrees', type=float, default=30,
                        help='requested roll travel, greater than zero and at most 30 degrees')
    args = parser.parse_args()
    if not args.camera.isalnum():
        parser.error('Camera must be an alphanumeric configured identifier')
    if not (math.isfinite(args.rate) and 0 < abs(args.rate) <= MAX_RATE):
        parser.error('Use a nonzero signed rate up to 1 degree/s')
    if not (math.isfinite(args.degrees) and 0 < args.degrees <= MAX_DEGREES):
        parser.error('Use travel greater than zero and at most 30 degrees')
    def interrupted(signum, _frame):
        raise InterruptedError(f'Received signal {signal.Signals(signum).name}')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    print(f'roll-travel-check pid={os.getpid()}', file=sys.stderr, flush=True)
    result = run_check(args.camera, args.rate, args.degrees)
    result['pid'] = os.getpid()
    print(json.dumps(result, indent=2))
    if result['error'] or not result['targetReached']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
