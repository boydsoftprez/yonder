# SPDX-License-Identifier: GPL-3.0-or-later
import copy
import importlib.util
from pathlib import Path
import unittest
from test_profiles import baseline

spec = importlib.util.spec_from_file_location('hdr_profile', Path(__file__).with_name('hdr-profile.py'))
hdr_profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hdr_profile)


def source():
    data = baseline()
    data['main_scene'][0]['name'] = 'normal'
    data['main_scene_len'] = 1
    data['sensor_calib']['CISDcgSet'] = {'Hdr': {'support_en': 0}}
    data['sensor_calib']['CISTimeSet'] = {'Hdr': [
        {'name': 'HDR_TWO_FRAME', 'CISTimeRegMax': {'Coeff': [0, 0, 0]}}]}
    for sub in data['main_scene'][0]['sub_scene']:
        sub['name'] = 'day'
        sub['scene_isp21']['amerge_calib_v10'] = {'preserved_merge_calibration': True}
        sub['scene_isp21']['ae_calib']['CommCtrl']['AecManualCtrl'] = {}
    return data


class HdrProfileTest(unittest.TestCase):
    def test_exposures_are_separate_and_linear_scene_is_preserved(self):
        original = source()
        saved = copy.deepcopy(original)
        result = hdr_profile.build(original)
        self.assertEqual(original, saved)
        self.assertEqual(result['main_scene'][0], saved['main_scene'][0])
        self.assertEqual(result['main_scene_len'], len(result['main_scene']))
        self.assertEqual(result['main_scene'][1]['name'], 'hdr')
        self.assertEqual(result['sensor_calib']['CISHdrSet']['hdr_en'], 1)
        for sub in result['main_scene'][1]['sub_scene']:
            control = sub['scene_isp21']['ae_calib']['CommCtrl']
            self.assertEqual(control['AecOpType'], 'RK_AIQ_OP_MODE_MANUAL')
            self.assertEqual(control['AecManualCtrl']['HdrAE']['TimeValue'][:2], [.001, .008])
            self.assertEqual(control['AecManualCtrl']['HdrAE']['IspDGainValue'], [1, 1, 1])

    def test_impossible_sensor_exposures_and_gains_are_rejected(self):
        for kwargs in [{'short_ms': -1}, {'short_ms': 4}, {'long_ms': 40},
                       {'long_ms': .5}, {'gain': 100}, {'gain': float('nan')},
                       {'long_ms': float('inf')}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                hdr_profile.build(source(), **kwargs)

    def test_missing_merge_calibration_is_rejected(self):
        data = source()
        del data['main_scene'][0]['sub_scene'][0]['scene_isp21']['amerge_calib_v10']
        with self.assertRaisesRegex(ValueError, 'merge calibration'):
            hdr_profile.build(data)


if __name__ == '__main__':
    unittest.main()
