#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).with_name('roll-travel-check.py')
SPEC = importlib.util.spec_from_file_location('roll_travel_check', SCRIPT)
roll_travel_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(roll_travel_check)


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class FakeDaemon:
    def __init__(self, *, available=True, fault_after_slew=False, wrong_way=False):
        self.available = available
        self.fault_after_slew = fault_after_slew
        self.wrong_way = wrong_way
        self.calls = []
        self.roll = 30.0
        self.slews = 0

    def __call__(self, path, body=None, timeout=1):
        self.calls.append((path, body, timeout))
        if body is None:
            return {'run': 'offline', 'accessory': {
                'state': {}, 'manufacturer': 'DJI', 'model': 'HG211',
                'input': {'live': True},
                'generation': 7_000_000, 'admitted': {'pan': 0, 'tilt': 0},
                'attitude': self._attitude(), 'inhibition': None,
                'motionNotice': None,
                'rollControl': {'available': self.available, 'reason': None, 'maxRate': 1},
            }}
        request = body['request']
        if request['op'] == 'probe-state':
            return {'accepted': True, 'attitude': self._attitude(),
                    'generation': 7_000_000, 'notice': None, 'inhibition': None}
        if request['op'] == 'issue':
            return {'accepted': True, 'grant': {
                'gesture': 'gesture-1', 'credential': 'credential-0', 'deadline': 500,
            }}
        if request['op'] == 'slew':
            self.slews += 1
            self.roll += 1 if self.wrong_way else -3
            return {'accepted': True, 'next': {
                'gesture': 'gesture-1', 'credential': f'credential-{self.slews}',
                'deadline': 500 + self.slews * 100,
            }}
        if request['op'] == 'stop':
            return {'accepted': True}
        raise AssertionError(request)

    def _attitude(self):
        return {
            'mode': 1, 'joints': {'pan': 4 if self.fault_after_slew and self.slews else 0,
                                  'tilt': 0, 'roll': self.roll},
            'fault': False, 'pitchLimit': False, 'yawLimit': False, 'rollLimit': False,
        }


class RollTravelCheckTests(unittest.TestCase):
    def test_unavailable_public_roll_fails_closed_before_issue(self):
        daemon = FakeDaemon(available=False)
        clock = FakeClock()
        result = roll_travel_check.run_check('cam2', 1, 30, daemon, clock.now, clock.sleep,
                                             owner='bench-roll-travel-test')

        self.assertFalse(result['targetReached'])
        self.assertIn('production roll control is unavailable', result['error'])
        self.assertFalse(any(call[1] and call[1]['request']['op'] in ('issue', 'slew')
                             for call in daemon.calls))

    def test_unexpected_motion_stops_the_issued_public_gesture(self):
        daemon = FakeDaemon(fault_after_slew=True)
        clock = FakeClock()
        result = roll_travel_check.run_check('cam2', 1, 30, daemon, clock.now, clock.sleep,
                                             owner='bench-roll-travel-test')

        operations = [call[1]['request']['op'] for call in daemon.calls if call[1]]
        self.assertEqual(operations.count('issue'), 1)
        self.assertEqual(operations.count('slew'), 1)
        self.assertEqual(operations.count('stop'), 1)
        self.assertLess(operations.index('slew'), operations.index('stop'))
        self.assertIn('Unexpected pan/tilt movement', result['error'])
        self.assertFalse(result['targetReached'])
        self.assertGreaterEqual(result['stopTailSeconds'], 2)

    def test_crossing_target_stops_without_an_extra_renewal(self):
        daemon = FakeDaemon()
        clock = FakeClock()
        result = roll_travel_check.run_check('cam2', 1, 30, daemon, clock.now, clock.sleep,
                                             owner='bench-roll-travel-test')

        operations = [call[1]['request']['op'] for call in daemon.calls if call[1]]
        self.assertTrue(result['targetReached'])
        self.assertEqual(result['targetRoll'], 0)
        self.assertEqual(operations.count('slew'), 10)
        self.assertEqual(operations.count('stop'), 1)
        self.assertEqual(result['commands'][-1]['seq'], 9)
        self.assertGreaterEqual(result['stopTailSeconds'], 2)

    def test_wrong_way_roll_fails_closed_and_stops(self):
        daemon = FakeDaemon(wrong_way=True)
        clock = FakeClock()
        result = roll_travel_check.run_check('cam2', 1, 30, daemon, clock.now, clock.sleep,
                                             owner='bench-roll-travel-test')

        operations = [call[1]['request']['op'] for call in daemon.calls if call[1]]
        self.assertEqual(operations.count('slew'), 1)
        self.assertEqual(operations.count('stop'), 1)
        self.assertIn('opposite the requested direction', result['error'])
        self.assertFalse(result['targetReached'])


if __name__ == '__main__':
    unittest.main()
