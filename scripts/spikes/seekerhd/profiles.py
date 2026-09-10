#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate repeatable single-exposure ISP21 profiles from the tuned baseline."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
from tune import KNOTS

PROFILES = {
    'normal-light': {'label': 'Normal Light', 'shadow_mix': 0.65, 'gain': 16, 'isp_gain': 1,
                     'chroma_nr': False, 'sharp_ratio': 0.6},
    'low-light': {'label': 'Low Light', 'shadow_mix': 1.0, 'gain': 29.512,
                  'isp_gain': 100 / 29.512, 'chroma_nr': True, 'sharp_ratio': 0.35},
}


def scenes(profile):
    for main in profile['main_scene']:
        for sub in main['sub_scene']:
            yield sub['scene_isp21']


def validate(profile):
    assert profile['sensor_calib']['resolution'] == {'width': 1920, 'height': 1080}
    assert not profile['sensor_calib']['CISHdrSet']['hdr_en'], 'HDR is not implemented by this driver'
    for scene in scenes(profile):
        curve = scene['agamma_calib_v10']['GammaTuningPara']['Gamma_curve']
        assert len(curve) == len(KNOTS) and curve[0] == 0 and curve[-1] == 4095
        assert all(isinstance(x, int) and 0 <= x <= 4095 for x in curve)
        assert all(a <= b for a, b in zip(curve, curve[1:]))
        assert scene['ae_calib']['CommCtrl']['AecFrameRateMode'] == {'isFpsFix': 1, 'FpsValue': 30}
        assert not scene['lsc_v2']['common']['enable']
        assert not scene['bayernr_v2']['Bayernr3D']['enable']


def build(baseline, name):
    validate(baseline)
    result = copy.deepcopy(baseline)
    spec = PROFILES[name]
    gain = result['sensor_calib']['CISGainSet']
    for key in ['CISAgainRange', 'CISExtraAgainRange']:
        gain[key]['Max'] = spec['gain']
    gain['CISIspDgainRange']['Max'] = spec['isp_gain']
    for scene in scenes(result):
        gamma = scene['agamma_calib_v10']['GammaTuningPara']
        # Blend toward linear input to reduce the helper's strong shadow lift.
        # Both endpoints stay fixed; this is tone mapping, not HDR capture.
        gamma['Gamma_curve'] = [round(spec['shadow_mix'] * y + (1-spec['shadow_mix']) * x)
                                for x, y in zip(KNOTS, gamma['Gamma_curve'])]
        nr = scene['bayernr_v2']
        nr['Bayernr2D']['enable'] = 0
        nr['Bayernr3D']['enable'] = 0
        scene['ynr_v2']['TuningPara']['enable'] = 0
        chroma = scene['cnr_v1']['TuningPara']
        chroma['enable'] = int(spec['chroma_nr'])
        for setting in chroma['Setting']:
            for iso in setting['Tuning_ISO']:
                for key in ['hf_denoise_strength', 'thumb_denoise_strength', 'lf_denoise_strength']:
                    iso[key] *= 0.5
        for setting in scene['sharp_v3']['TuningPara']['Setting']:
            for iso in setting['Tuning_ISO']:
                iso['sharp_ratio'] = spec['sharp_ratio']
        route = scene['ae_calib']['LinearAeCtrl']['Route']
        route['GainDot'] = [1, 2, 4, 8, min(12, spec['gain']), spec['gain']]
        route['IspDGainDot'] = [1, 1, 1, 1, 1, spec['isp_gain']]
    validate(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    raw = args.baseline.read_bytes()
    base = json.loads(raw)
    validate(base)
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {'baseline_sha256': hashlib.sha256(raw).hexdigest(), 'profiles': {}}
    for name in ['legacy-low-light', *PROFILES]:
        data = raw if name == 'legacy-low-light' else (json.dumps(build(base, name), indent=2)+'\n').encode()
        (args.output/(name+'.json')).write_bytes(data)
        manifest['profiles'][name] = {'sha256': hashlib.sha256(data).hexdigest(),
            **({'label': 'Original low-light tuning'} if name == 'legacy-low-light' else PROFILES[name])}
    (args.output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
