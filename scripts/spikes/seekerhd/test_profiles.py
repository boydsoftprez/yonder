# SPDX-License-Identifier: GPL-3.0-or-later
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import profiles


def baseline():
    scene = {
        'agamma_calib_v10': {'GammaTuningPara': {'Gamma_curve': [min(4095, 2*x) for x in profiles.KNOTS]}},
        'ae_calib': {'CommCtrl': {'AecFrameRateMode': {'isFpsFix': 1, 'FpsValue': 30}},
                     'LinearAeCtrl': {'Route': {'TimeDot': [0.0001, .01, .03, .03, .03, .03]}}},
        'bayernr_v2': {'Bayernr2D': {'enable': 1}, 'Bayernr3D': {'enable': 0}},
        'ynr_v2': {'TuningPara': {'enable': 1}},
        'cnr_v1': {'TuningPara': {'enable': 1, 'Setting': [{'Tuning_ISO': [{
            'hf_denoise_strength': 10, 'thumb_denoise_strength': 4, 'lf_denoise_strength': 4}]}]}},
        'sharp_v3': {'TuningPara': {'Setting': [{'Tuning_ISO': [{'sharp_ratio': .5}]}]}},
        'lsc_v2': {'common': {'enable': 0}},
        'ccm_calib': {'preserve': [1, 2, 3]},
    }
    return {'sensor_calib': {'resolution': {'width': 1920, 'height': 1080}, 'CISHdrSet': {'hdr_en': 0},
        'CISGainSet': {k: {'Min': 1, 'Max': 30} for k in ['CISAgainRange', 'CISExtraAgainRange', 'CISIspDgainRange']}},
        'main_scene': [{'sub_scene': [{'scene_isp21': copy.deepcopy(scene)} for _ in range(2)]}]}


class ProfilesTest(unittest.TestCase):
    def test_distinct_profiles_preserve_timing_and_color_calibration(self):
        original = baseline(); saved = copy.deepcopy(original)
        normal = profiles.build(original, 'normal-light')
        low = profiles.build(original, 'low-light')
        self.assertEqual(original, saved)
        for n, l, old in zip(profiles.scenes(normal), profiles.scenes(low), profiles.scenes(original)):
            self.assertEqual(n['ccm_calib'], old['ccm_calib'])
            self.assertEqual(n['ae_calib']['LinearAeCtrl']['Route']['TimeDot'], old['ae_calib']['LinearAeCtrl']['Route']['TimeDot'])
            ng = n['agamma_calib_v10']['GammaTuningPara']['Gamma_curve']
            lg = l['agamma_calib_v10']['GammaTuningPara']['Gamma_curve']
            self.assertTrue(all(a <= b for a, b in zip(ng, lg)))
            self.assertNotEqual(ng, lg)
            self.assertEqual(n['cnr_v1']['TuningPara']['enable'], 0)
            self.assertEqual(l['cnr_v1']['TuningPara']['enable'], 1)
            self.assertEqual(n['ynr_v2']['TuningPara']['enable'], 0)
        self.assertEqual(normal['sensor_calib']['CISGainSet']['CISAgainRange']['Max'], 16)
        self.assertAlmostEqual(low['sensor_calib']['CISGainSet']['CISAgainRange']['Max'] * low['sensor_calib']['CISGainSet']['CISIspDgainRange']['Max'], 100)

    def test_rejects_hdr_or_broken_gamma(self):
        data = baseline(); data['sensor_calib']['CISHdrSet']['hdr_en'] = 1
        with self.assertRaises(AssertionError): profiles.build(data, 'normal-light')
        data = baseline(); next(profiles.scenes(data))['agamma_calib_v10']['GammaTuningPara']['Gamma_curve'][4] = -1
        with self.assertRaises(AssertionError): profiles.build(data, 'normal-light')

    def test_failed_activation_restores_exact_previous_profile(self):
        spec = importlib.util.spec_from_file_location('selector', Path(__file__).with_name('select-profile.py'))
        selector = importlib.util.module_from_spec(spec); spec.loader.exec_module(selector)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'profiles').mkdir(); (root/'iqfiles').mkdir()
            active = root/'iqfiles/active.json'; original = json.dumps(baseline()).encode(); active.write_bytes(original)
            selected = json.dumps(profiles.build(baseline(), 'normal-light')).encode()
            (root/'profiles/normal-light.json').write_bytes(selected)
            (root/'profiles/manifest.json').write_text(json.dumps({'profiles': {'normal-light': {'sha256': hashlib.sha256(selected).hexdigest()}}}))
            view = {'camera': {'source': 'csi'}, 'card': 'm00_b_imx462 2-001a', 'run': {'state': 'running'}}
            with patch.object(selector, 'ROOT', root), patch.object(selector, 'ACTIVE', active), patch.object(selector, 'LOCK', root/'lock'), patch.object(selector.os, 'geteuid', return_value=0), patch.object(sys, 'argv', ['select-profile', 'normal-light']), patch.object(selector, 'api', return_value=view), patch.object(selector, 'restart_isp', side_effect=[RuntimeError('failed'), None]), patch.object(selector, 'wait_video'):
                with self.assertRaisesRegex(RuntimeError, 'failed'): selector.main()
            self.assertEqual(active.read_bytes(), original)


if __name__ == '__main__': unittest.main()
