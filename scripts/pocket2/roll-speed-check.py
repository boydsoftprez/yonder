#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Measure one bounded Pocket 2 public roll-rate pulse and its stopping tail.

Run only with the handle secured flat, screen up, and the moving head clear.
This sends one ordinary public rate request for 0.10 seconds, never renews it,
always stops a known gesture, and observes native feedback for two seconds.
It measures stopping behavior; it does not assume a stopping distance.
Mechanical response at 10 and 30 degrees/s remains pending this measurement.
"""
import argparse
import importlib.util
import json
import math
import os
import pathlib
import signal
import sys
import time
import uuid


HELPER_PATH = pathlib.Path(__file__).with_name('roll-travel-check.py')
HELPER_SPEC = importlib.util.spec_from_file_location('_roll_travel_check', HELPER_PATH)
travel = importlib.util.module_from_spec(HELPER_SPEC)
HELPER_SPEC.loader.exec_module(travel)

ALLOWED_RATES = (-30.0, -10.0, 10.0, 30.0)
HOLD_SECONDS = 0.10
SAMPLE_SECONDS = 0.05
TAIL_SECONDS = 2.0
HARD_ROLL_DEGREES = 40.0


def run_check(camera, rate, api_call=travel.api, now=time.monotonic,
              sleep=time.sleep, owner=None):
    # Validate every caller-controlled parameter before opening the socket.
    travel.require(isinstance(camera, str) and camera.isalnum(),
                   'Camera must be an alphanumeric configured identifier')
    travel.require(travel.finite_number(rate) and float(rate) in ALLOWED_RATES,
                   'Rate must be exactly signed 10 or 30 degrees/s')
    rate = float(rate)
    owner = owner or 'bench-roll-speed-' + uuid.uuid4().hex
    travel.require(isinstance(owner, str) and 0 < len(owner) <= 128
                   and all(char.isalnum() or char in '_.:-' for char in owner),
                   'Invalid owner')

    started = now()
    path = '/cameras/' + camera
    samples = []
    tail_errors = []
    initial = None
    before = None
    expected_generation = None
    issue_timing = None
    cleanup_issue_timing = None
    slew_timing = None
    stop_timing = None
    gesture = None
    issue_submitted = False
    issue_response_known = False
    accepted_rate_commands = 0
    last_pre_stop_sample = None
    stop_tail_seconds = 0.0
    error = None

    def elapsed():
        return now() - started

    def append_error(message):
        nonlocal error
        error = f'{error}; {message}' if error else message

    def snapshot(phase, timeout=1):
        response = api_call(path + '/aim', {
            'owner': 'bench-range-roll-observe',
            'request': {'op': 'probe-state'},
        }, timeout=timeout)
        travel.require(isinstance(response, dict) and response.get('accepted') is True,
                       'Private feedback read refused')
        joints = travel.validate_attitude(response.get('attitude'))
        travel.require(not response.get('inhibition'),
                       f"Motion inhibited: {response.get('inhibition')}")
        travel.require(not response.get('notice'),
                       f"Motion notice: {response.get('notice')}")
        travel.require(response.get('generation') == expected_generation,
                       'USB generation changed')
        sample = {
            't': elapsed(), 'phase': phase,
            'joints': {axis: joints[axis] for axis in ('pan', 'tilt', 'roll')},
            'quaternion': response['attitude'].get('quaternion'),
            'mode': response['attitude']['mode'],
            'generation': response.get('generation'),
        }
        if before is not None:
            sample['directedTravelDegrees'] = (-1 if rate > 0 else 1) * (
                joints['roll'] - before['joints']['roll'])
        samples.append(sample)
        return sample

    def validate_motion(sample):
        # Crossing this observation bound is an error and triggers Stop. It is
        # not a claim that software can halt a head which is already coasting.
        travel.require(abs(sample['joints']['roll']) <= HARD_ROLL_DEGREES,
                       'Native roll left the -40 to 40 degree observation bound')
        travel.require(abs(sample['joints']['pan'] - before['joints']['pan']) <= 3
                       and abs(sample['joints']['tilt'] - before['joints']['tilt']) <= 3,
                       'Unexpected pan/tilt movement greater than 3 degrees')
        travel.require(sample['directedTravelDegrees'] >= -0.3,
                       'Unexpected roll movement opposite the requested direction')

    try:
        initial = api_call(path, timeout=5)
        accessory = travel.validate_initial(initial, rate)
        expected_generation = accessory['generation']
        before = snapshot('preflight')
        start_limit = 5 if abs(rate) == 30 else 20
        travel.require(abs(before['joints']['roll']) <= start_limit,
                       f'Start native roll must be within {start_limit} degrees for this rate')
        for _ in range(3):
            sleep(0.1)
            stationary = snapshot('preflight')
            travel.require(all(abs(stationary['joints'][axis] - before['joints'][axis]) <= 0.3
                               for axis in ('pan', 'tilt', 'roll')),
                           'Camera is already moving')

        issue_timing = {'submittedAt': elapsed()}
        issue_submitted = True
        issued = api_call(path + '/aim', {
            'owner': owner, 'request': {'op': 'issue', 'clientGesture': owner},
        }, timeout=1)
        issue_response_known = True
        issue_timing['acceptedAt'] = elapsed()
        issue_timing['accepted'] = isinstance(issued, dict) and issued.get('accepted') is True
        grant = issued.get('grant') if isinstance(issued, dict) else None
        # Capture the cleanup token before validating the rest of the response.
        if isinstance(grant, dict) and isinstance(grant.get('gesture'), str):
            gesture = grant['gesture']
        travel.require(issue_timing['accepted'], f'Public issue refused: {issued}')
        travel.require(isinstance(grant, dict) and set(grant) == {
            'gesture', 'credential', 'deadline'} and isinstance(grant.get('gesture'), str)
            and isinstance(grant.get('credential'), str)
            and travel.finite_number(grant.get('deadline')), 'Public issue returned no usable public grant')

        slew_timing = {'submittedAt': elapsed(), 'seq': 0,
                       'credentialDeadline': grant['deadline']}
        request = {'op': 'slew', **grant, 'seq': 0,
                   'pan': 0, 'tilt': 0, 'roll': rate}
        reply = api_call(path + '/aim', {'owner': owner, 'request': request}, timeout=1)
        slew_timing['acceptedAt'] = elapsed()
        slew_timing['accepted'] = isinstance(reply, dict) and reply.get('accepted') is True
        if isinstance(reply, dict) and not slew_timing['accepted']:
            slew_timing['reason'] = reply.get('reason')
        travel.require(slew_timing['accepted'], f'Public slew refused: {reply}')
        accepted_rate_commands = 1

        stop_due = now() + HOLD_SECONDS
        while stop_due - now() > 1e-9:
            sleep(min(SAMPLE_SECONDS, stop_due - now()))
            remaining = stop_due - now()
            if remaining <= 1e-9:
                break
            # A feedback timeout may consume only the hold time still left;
            # observation can never defer Stop beyond the requested pulse.
            validate_motion(snapshot('motion', timeout=remaining))
    except Exception as failure:
        append_error(str(failure))
    finally:
        if gesture is None and issue_submitted and not issue_response_known:
            # A timed-out issue cannot authorize a slew because its credential
            # never reached this process. One different same-owner issue asks
            # Intent to retire any uncertain prior grant; it is never a retry
            # of a rejected operation and no rate is sent from this grant.
            cleanup_issue_timing = {'submittedAt': elapsed()}
            try:
                cleanup = api_call(path + '/aim', {'owner': owner, 'request': {
                    'op': 'issue', 'clientGesture': 'cleanup-' + uuid.uuid4().hex,
                }}, timeout=1)
                cleanup_issue_timing['acceptedAt'] = elapsed()
                cleanup_issue_timing['accepted'] = (
                    isinstance(cleanup, dict) and cleanup.get('accepted') is True)
                cleanup_grant = cleanup.get('grant') if isinstance(cleanup, dict) else None
                if cleanup_issue_timing['accepted'] and isinstance(cleanup_grant, dict) \
                        and isinstance(cleanup_grant.get('gesture'), str):
                    gesture = cleanup_grant['gesture']
                else:
                    append_error(f'Uncertain issue cleanup refused: {cleanup}')
            except Exception as failure:
                cleanup_issue_timing['accepted'] = False
                cleanup_issue_timing['error'] = str(failure)
                append_error(f'Uncertain issue cleanup failed: {failure}')

        observe_cleanup = gesture is not None or (issue_submitted and not issue_response_known)
        if gesture is not None:
            last_pre_stop_sample = samples[-1] if samples else None
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
                append_error(f'Stop failed: {failure}')

        if observe_cleanup:
            tail_started = now()
            tail_deadline = tail_started + TAIL_SECONDS
            while tail_deadline - now() > 1e-9:
                try:
                    sleep(min(SAMPLE_SECONDS, tail_deadline - now()))
                    validate_motion(snapshot('stop-tail'))
                except Exception as failure:
                    tail_errors.append({'t': elapsed(), 'error': str(failure)})
            stop_tail_seconds = now() - tail_started

    if tail_errors:
        append_error(f'Stop-tail feedback failed: {tail_errors[0]["error"]}')

    measured = ([before] if before is not None else []) + [
        sample for sample in samples if sample['phase'] in ('motion', 'stop-tail')]
    speeds = []
    # Three-sample finite differences reduce 0.1-degree telemetry quantization.
    for index in range(2, len(measured)):
        first, last = measured[index - 2], measured[index]
        seconds = last['t'] - first['t']
        if seconds > 0:
            speeds.append(abs(last['joints']['roll'] - first['joints']['roll']) / seconds)
    peak_speed = max(speeds) if speeds else None

    last_observed_change_at = None
    if measured:
        reference = measured[0]['joints']['roll']
        for sample in measured[1:]:
            if abs(sample['joints']['roll'] - reference) >= 0.2:
                last_observed_change_at = sample['t']
                reference = sample['joints']['roll']

    tail = [sample for sample in samples if sample['phase'] == 'stop-tail']
    final_stability = {'stable': False, 'spanDegrees': None, 'sampleCount': 0}
    if tail:
        final_at = tail[-1]['t']
        stable_samples = [sample for sample in tail if sample['t'] >= final_at - 0.5]
        rolls = [sample['joints']['roll'] for sample in stable_samples]
        span = max(rolls) - min(rolls) if rolls else None
        final_stability = {'stable': len(rolls) >= 2 and span < 0.2,
                           'spanDegrees': span, 'sampleCount': len(rolls)}
    if gesture is not None and not final_stability['stable']:
        append_error('Native roll was not stable during the final 500 ms')

    final_sample = samples[-1] if samples else None
    last_pre_stop_roll = (last_pre_stop_sample['joints']['roll']
                          if last_pre_stop_sample is not None else None)
    post_stop = (final_sample['joints']['roll'] - last_pre_stop_roll
                 if final_sample is not None and last_pre_stop_roll is not None else None)
    actual_hold = (stop_timing['submittedAt'] - slew_timing['acceptedAt']
                   if stop_timing and slew_timing and 'acceptedAt' in slew_timing else None)
    # This is the timestamp of the last >=0.2-degree native observation. It is
    # neither the last transmitted rate frame nor an exact physical stop time.
    last_observed_change_after_stop_ms = (
        (last_observed_change_at - stop_timing['submittedAt']) * 1000
        if last_observed_change_at is not None and stop_timing else None)

    return {
        'camera': camera, 'requestedRate': rate,
        'requestedHoldSeconds': HOLD_SECONDS, 'actualHoldSeconds': actual_hold,
        'initialRun': initial.get('run') if isinstance(initial, dict) else None,
        'issue': issue_timing, 'issueSubmitted': issue_submitted,
        'issueResponseKnown': issue_response_known, 'cleanupIssue': cleanup_issue_timing,
        'slew': slew_timing, 'acceptedRateCommands': accepted_rate_commands,
        'stop': stop_timing, 'stopTailSeconds': stop_tail_seconds,
        'stopTailErrors': tail_errors, 'samples': samples,
        'nativeRollLastSampleBeforeStop': last_pre_stop_roll,
        'lastPreStopSampleAt': (last_pre_stop_sample['t']
                                if last_pre_stop_sample is not None else None),
        'postStopDisplacementFromLastPreStopSampleDegrees': post_stop,
        'peakObservedNativeSpeedDegS': peak_speed,
        'speedWindowSamples': 3,
        'speedEstimate': 'Uncalibrated three-sample finite difference from poll arrival times.',
        'lastObservedChangeAt': last_observed_change_at,
        'lastObservedChangeAfterStopMs': last_observed_change_after_stop_ms,
        'finalStability': final_stability,
        'error': error,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('camera')
    parser.add_argument('--rate', type=float, required=True,
                        help='exactly one of -30, -10, 10, or 30 degrees/s')
    args = parser.parse_args()
    if not args.camera.isalnum():
        parser.error('Camera must be an alphanumeric configured identifier')
    if not math.isfinite(args.rate) or args.rate not in ALLOWED_RATES:
        parser.error('Rate must be exactly signed 10 or 30 degrees/s')

    def interrupted(signum, _frame):
        raise InterruptedError(f'Received signal {signal.Signals(signum).name}')

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    print(f'roll-speed-check pid={os.getpid()}', file=sys.stderr, flush=True)
    result = run_check(args.camera, args.rate)
    result['pid'] = os.getpid()
    print(json.dumps(result, indent=2))
    if result['error'] or result['acceptedRateCommands'] != 1 or not result['stop'] \
            or result['stop'].get('accepted') is not True:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
