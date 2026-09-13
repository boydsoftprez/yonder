#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).with_name('roll-speed-check.py')
SPEC = importlib.util.spec_from_file_location('roll_speed_check', SCRIPT)
roll_speed_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(roll_speed_check)


class FakeClock:
    def __init__(self):
        self.value = 0.0
        self.daemon = None

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds
        if self.daemon:
            self.daemon.advance(seconds)


class FakeDaemon:
    def __init__(self, clock, *, moving=False, interrupt_after_slew=False,
                 malformed_issue=False, issue_error=False, slow_motion_read=False,
                 reject_slew=False, available=True):
        self.clock = clock
        clock.daemon = self
        self.moving = moving
        self.interrupt_after_slew = interrupt_after_slew
        self.malformed_issue = malformed_issue
        self.issue_error = issue_error
        self.slow_motion_read = slow_motion_read
        self.reject_slew = reject_slew
        self.available = available
        self.calls = []
        self.roll = 0.0
        self.pan = 0.0
        self.rate = 0.0
        self.slews = 0
        self.probes = 0
        self.issues = 0

    def advance(self, seconds):
        if self.moving and self.slews == 0:
            self.roll += seconds * 5
        if self.rate:
            # Positive wire roll decreases native roll.
            self.roll -= self.rate * seconds

    def __call__(self, path, body=None, timeout=1):
        self.calls.append((path, body, timeout))
        if body is None:
            return {'run': 'offline', 'accessory': {
                'state': {}, 'manufacturer': 'DJI', 'model': 'HG211',
                'input': {'live': True}, 'generation': 3_000_000,
                'admitted': {'pan': 0, 'tilt': 0}, 'attitude': self._attitude(),
                'inhibition': None, 'motionNotice': None,
                'rollControl': {'available': self.available, 'reason': None, 'maxRate': 30},
            }}
        request = body['request']
        if request['op'] == 'probe-state':
            self.probes += 1
            if self.slow_motion_read and self.slews and self.rate:
                self.clock.sleep(timeout)
                raise TimeoutError('bounded motion feedback timeout')
            if self.interrupt_after_slew and self.slews and self.probes == 5:
                raise InterruptedError('operator interrupt')
            return {'accepted': True, 'attitude': self._attitude(),
                    'generation': 3_000_000, 'notice': None, 'inhibition': None}
        if request['op'] == 'issue':
            self.issues += 1
            if self.issue_error and self.issues == 1:
                raise TimeoutError('issue response timed out')
            grant = {'gesture': 'gesture-1'}
            if not self.malformed_issue:
                grant.update({'credential': 'credential-0', 'deadline': 500})
            return {'accepted': True, 'grant': grant}
        if request['op'] == 'slew':
            self.slews += 1
            if self.reject_slew:
                return {'accepted': False, 'reason': 'rate-cap'}
            self.rate = request['roll']
            return {'accepted': True, 'next': {
                'gesture': 'gesture-1', 'credential': 'unused-next', 'deadline': 600,
            }}
        if request['op'] == 'stop':
            self.rate = 0
            return {'accepted': True}
        raise AssertionError(request)

    def _attitude(self):
        return {
            'mode': 1, 'joints': {'pan': self.pan, 'tilt': 0, 'roll': self.roll},
            'quaternion': [1, 0, 0, 0], 'fault': False,
            'pitchLimit': False, 'yawLimit': False, 'rollLimit': False,
        }


def operations(daemon):
    return [call[1]['request']['op'] for call in daemon.calls if call[1]]


class RollSpeedCheckTests(unittest.TestCase):
    def test_30_degree_request_is_one_public_command_then_stop(self):
        clock = FakeClock(); daemon = FakeDaemon(clock)
        result = roll_speed_check.run_check('cam2', 30, daemon, clock.now, clock.sleep,
                                            owner='bench-roll-speed-test')

        ops = operations(daemon)
        self.assertEqual(ops.count('issue'), 1)
        self.assertEqual(ops.count('slew'), 1)
        self.assertEqual(ops.count('stop'), 1)
        slew = next(call[1]['request'] for call in daemon.calls
                    if call[1] and call[1]['request']['op'] == 'slew')
        self.assertEqual(slew, {'op': 'slew', 'gesture': 'gesture-1',
                               'credential': 'credential-0', 'deadline': 500,
                               'seq': 0, 'pan': 0, 'tilt': 0, 'roll': 30})
        self.assertEqual(result['acceptedRateCommands'], 1)
        self.assertAlmostEqual(result['requestedHoldSeconds'], .10)
        self.assertAlmostEqual(result['stopTailSeconds'], 2, places=6)
        self.assertTrue(result['finalStability']['stable'])
        self.assertGreater(result['peakObservedNativeSpeedDegS'], 0)
        self.assertEqual(result['speedWindowSamples'], 3)
        self.assertIn('Uncalibrated', result['speedEstimate'])
        self.assertLessEqual(result['lastPreStopSampleAt'], result['stop']['submittedAt'])
        self.assertIn('postStopDisplacementFromLastPreStopSampleDegrees', result)
        self.assertIsNone(result['error'])

    def test_interrupt_after_slew_still_stops_and_records_tail(self):
        clock = FakeClock(); daemon = FakeDaemon(clock, interrupt_after_slew=True)
        result = roll_speed_check.run_check('cam2', 10, daemon, clock.now, clock.sleep,
                                            owner='bench-roll-speed-test')

        ops = operations(daemon)
        self.assertEqual(ops.count('slew'), 1)
        self.assertEqual(ops.count('stop'), 1)
        self.assertIn('operator interrupt', result['error'])
        self.assertAlmostEqual(result['stopTailSeconds'], 2, places=6)

    def test_slow_motion_read_cannot_delay_stop_past_its_remaining_budget(self):
        clock = FakeClock(); daemon = FakeDaemon(clock, slow_motion_read=True)
        result = roll_speed_check.run_check('cam2', 30, daemon, clock.now, clock.sleep,
                                            owner='bench-roll-speed-test')

        self.assertEqual(operations(daemon).count('slew'), 1)
        self.assertEqual(operations(daemon).count('stop'), 1)
        self.assertLessEqual(result['stop']['submittedAt'] - result['slew']['acceptedAt'],
                             result['requestedHoldSeconds'] + 1e-9)
        motion_reads = [call for call in daemon.calls if call[1]
                        and call[1]['request']['op'] == 'probe-state' and call[2] < 1]
        self.assertEqual(len(motion_reads), 1)
        self.assertLessEqual(motion_reads[0][2], .05 + 1e-9)
        self.assertIn('bounded motion feedback timeout', result['error'])

    def test_rejected_rate_is_not_retried_and_known_gesture_is_stopped(self):
        clock = FakeClock(); daemon = FakeDaemon(clock, reject_slew=True)
        result = roll_speed_check.run_check('cam2', 30, daemon, clock.now, clock.sleep,
                                            owner='bench-roll-speed-test')

        self.assertEqual(operations(daemon).count('issue'), 1)
        self.assertEqual(operations(daemon).count('slew'), 1)
        self.assertEqual(operations(daemon).count('stop'), 1)
        self.assertEqual(result['acceptedRateCommands'], 0)
        self.assertIn('Public slew refused', result['error'])

    def test_known_gesture_from_incomplete_issue_response_is_stopped(self):
        clock = FakeClock(); daemon = FakeDaemon(clock, malformed_issue=True)
        result = roll_speed_check.run_check('cam2', -10, daemon, clock.now, clock.sleep,
                                            owner='bench-roll-speed-test')

        self.assertEqual(operations(daemon).count('slew'), 0)
        self.assertEqual(operations(daemon).count('stop'), 1)
        self.assertIn('usable public grant', result['error'])
        self.assertAlmostEqual(result['stopTailSeconds'], 2, places=6)

    def test_unknown_issue_response_sends_no_rate_and_observes_grant_expiry(self):
        clock = FakeClock(); daemon = FakeDaemon(clock, issue_error=True)
        result = roll_speed_check.run_check('cam2', 10, daemon, clock.now, clock.sleep,
                                            owner='bench-roll-speed-test')

        self.assertTrue(result['issueSubmitted'])
        self.assertFalse(result['issueResponseKnown'])
        self.assertEqual(operations(daemon).count('slew'), 0)
        self.assertEqual(operations(daemon).count('issue'), 2)
        self.assertEqual(operations(daemon).count('stop'), 1)
        self.assertTrue(result['cleanupIssue']['accepted'])
        self.assertIn('issue response timed out', result['error'])
        self.assertAlmostEqual(result['stopTailSeconds'], 2, places=6)

    def test_moving_or_unavailable_preflight_issues_nothing(self):
        for daemon_args, message in [({'moving': True}, 'already moving'),
                                     ({'available': False}, 'production roll control is unavailable')]:
            with self.subTest(message=message):
                clock = FakeClock(); daemon = FakeDaemon(clock, **daemon_args)
                result = roll_speed_check.run_check('cam2', 10, daemon, clock.now, clock.sleep,
                                                    owner='bench-roll-speed-test')
                self.assertIn(message, result['error'])
                self.assertNotIn('issue', operations(daemon))
                self.assertNotIn('slew', operations(daemon))

    def test_invalid_parameters_make_no_api_call(self):
        for camera, rate in [('cam2', 20), ('cam-2', 10), ('cam2', float('nan'))]:
            with self.subTest(camera=camera, rate=rate):
                clock = FakeClock(); daemon = FakeDaemon(clock)
                with self.assertRaises(RuntimeError):
                    roll_speed_check.run_check(camera, rate, daemon, clock.now, clock.sleep)
                self.assertEqual(daemon.calls, [])


if __name__ == '__main__':
    unittest.main()
