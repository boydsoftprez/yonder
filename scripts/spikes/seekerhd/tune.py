#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Translate SeekerHD gain/gamma intent into a supplied Rockchip ISP21 profile.

Usage: tune.py rockchip-profile.json seekerhd-rpi-profile.json output.json
Colour calibration remains that of the input profile; this is not a factory
calibration. Gamma knots follow Rockchip's rk_aiq_user_api2_imgproc.cpp.
"""
import bisect
import json
import sys
from pathlib import Path

KNOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24,
         28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256,
         320, 384, 448, 512, 640, 768, 896, 1024, 1280, 1536, 1792,
         2048, 2560, 3072, 3584, 4095]


def gamma_curve(curve):
    xs, ys = curve[::2], curve[1::2]
    assert len(xs) == len(ys) and xs[0] == ys[0] == 0
    assert xs[-1] == ys[-1] == 65535
    assert all(a < b for a, b in zip(xs, xs[1:]))
    out = []
    for knot in KNOTS:
        x = knot / 4095 * 65535
        i = min(max(bisect.bisect_right(xs, x) - 1, 0), len(xs) - 2)
        y = ys[i] + (ys[i + 1] - ys[i]) * (x - xs[i]) / (xs[i + 1] - xs[i])
        out.append(round(y / 65535 * 4095))
    assert out[0] == 0 and out[-1] == 4095
    assert all(a <= b for a, b in zip(out, out[1:]))
    return out


def main():
    base = json.loads(Path(sys.argv[1]).read_text())
    pi = json.loads(Path(sys.argv[2]).read_text())
    contrast = next(a['rpi.contrast'] for a in pi['algorithms'] if 'rpi.contrast' in a)
    sensor = base['sensor_calib']
    sensor['resolution'] = {'width': 1920, 'height': 1080}
    # IMX462 gain is logarithmic, in 0.3 dB register increments.
    sensor['Gain2Reg']['GainMode'] = 'EXPGAIN_MODE_NONLINEAR_DB'
    sensor['CISGainSet']['CISAgainRange'] = {'Min': 1, 'Max': 29.512}
    sensor['CISGainSet']['CISExtraAgainRange'] = {'Min': 1, 'Max': 29.512}
    sensor['CISGainSet']['CISDgainRange'] = {'Min': 1, 'Max': 1}
    sensor['CISGainSet']['CISIspDgainRange'] = {'Min': 1, 'Max': 4}
    sensor['CISTimeSet']['Linear']['CISTimeRegMin'] = 1
    sensor['CISTimeSet']['Linear']['CISLinTimeRegMaxFac']['fCoeff'] = [1, 2]
    sensor['CISHdrSet']['hdr_en'] = 0
    for mode in ['Linear', 'Hdr']:
        sensor['CISDcgSet'][mode]['support_en'] = 0
    sensor['CISMinFps'] = 30
    for main_scene in base['main_scene']:
        for sub in main_scene['sub_scene']:
            scene = sub['scene_isp21']
            # The borrowed reference has no SeekerHD lens calibration. An
            # unmatched LSC grid can zero the image; bypass it explicitly.
            scene['lsc_v2']['common']['enable'] = 0
            for i, entry in enumerate(scene['ccm_calib']['lumaCCM']['gain_yalp_curve']):
                entry['iso'] = 50 * 2 ** i
            ae = scene['ae_calib']
            ae['CommCtrl']['AecFrameRateMode'] = {'isFpsFix': 1, 'FpsValue': 30}
            ae['CommCtrl']['AecAntiFlicker']['Frequency'] = 'AECV2_FLICKER_FREQUENCY_60HZ'
            route = ae['LinearAeCtrl']['Route']
            route['TimeDot'] = [0.0001, 0.01, 0.03, 0.03, 0.03, 0.03]
            route['GainDot'] = [1, 2, 4, 8, 29.512, 29.512]
            route['IspDGainDot'] = [1, 1, 1, 1, 1, 100 / 29.512]
            for key in ['TimeDot', 'GainDot', 'IspDGainDot']:
                route[key + '_len'] = len(route[key])
            scene['agamma_calib_v10']['GammaTuningPara']['Gamma_curve'] = gamma_curve(contrast['gamma_curve'])
            # Driver black level is 3840 in 16-bit units; ISP21 uses 12 bits.
            blc = scene['ablc_calib']['BlcTuningPara']['BLC_Data']
            for channel in ['R_Channel', 'Gr_Channel', 'Gb_Channel', 'B_Channel']:
                blc[channel] = [240] * len(blc['ISO'])
            # Start without temporal denoise, matching the low-latency intent.
            scene['bayernr_v2']['Bayernr3D']['enable'] = 0
    Path(sys.argv[3]).write_text(json.dumps(base, indent=2) + '\n')


if __name__ == '__main__':
    main()
