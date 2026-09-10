#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""R-CTL-06: generate an experimental IMX462 HDR2 ISP21 bench calibration.

This file does not activate HDR or establish hardware support. Initial exposure
is manual so sensor/merge validation cannot be confused with AE convergence.
"""
import argparse
import copy
import json
from pathlib import Path
from profiles import validate


def build(linear, short_ms=1.0, long_ms=8.0, gain=2.0):
    validate(linear)
    # Fixed MIPI timing: 2028 clocks/line at 148.5 MHz, RHS1=225,
    # FSC=2440. Leave margin at both integration boundaries.
    line_seconds = 2028 / 148_500_000
    if not (2 * line_seconds <= short_ms / 1000 <= 220 * line_seconds):
        raise ValueError('short exposure must fit the fixed RHS1=225 line budget')
    if not (short_ms < long_ms and long_ms / 1000 <= 2208 * line_seconds):
        raise ValueError('long exposure must exceed short and fit the HDR frame')
    if not 1 <= gain <= 16:
        raise ValueError('bench analogue gain must be between 1x and 16x')
    result = copy.deepcopy(linear)
    sensor = result['sensor_calib']
    sensor['resolution'] = {'width': 1952, 'height': 1089}
    sensor['CISHdrSet'] = {'hdr_en': 1, 'hdr_mode': 'RK_AIQ_ISP_HDR_MODE_2_LINE_HDR',
                          'line_mode': 'RKAIQ_SENSOR_HDR_MODE_STAGGER'}
    sensor['CISGainSet']['CISHdrGainIndSetEn'] = 1
    for key in ['CISAgainRange', 'CISExtraAgainRange']:
        sensor['CISGainSet'][key]['Max'] = 16
    sensor['CISGainSet']['CISIspDgainRange']['Max'] = 1
    for timing in sensor['CISTimeSet']['Hdr']:
        if timing['name'] == 'HDR_TWO_FRAME':
            # ISP21 uses short/long order for two exposures; zero would
            # mean unlimited. These caps follow fixed RHS1 and FSC.
            timing['CISTimeRegMax']['Coeff'] = [222, 2212, 2212]
    # Keep conversion gain fixed: no uncalibrated LCG/HCG merge transitions.
    sensor['CISDcgSet']['Hdr']['support_en'] = 0
    normal = next(main for main in result['main_scene'] if main['name'] == 'normal')
    hdr = copy.deepcopy(normal)
    hdr['name'] = 'hdr'
    for sub in hdr['sub_scene']:
        scene = sub['scene_isp21']
        if 'amerge_calib_v10' not in scene:
            raise ValueError('source profile lacks ISP21 HDR merge calibration')
        control = scene['ae_calib']['CommCtrl']
        control['AecOpType'] = 'RK_AIQ_OP_MODE_MANUAL'
        control['AecFrameRateMode'] = {'isFpsFix': 1, 'FpsValue': 30}
        control['AecManualCtrl']['HdrAE'] = {
            'ManualTimeEn': 1, 'ManualGainEn': 1, 'ManualIspDgainEn': 1,
            'TimeValue': [short_ms / 1000, long_ms / 1000, long_ms / 1000],
            'GainValue': [gain, gain, gain], 'IspDGainValue': [1, 1, 1]}
    result['main_scene'] = [normal, hdr]
    result['main_scene_len'] = 2
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('linear', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--short-ms', type=float, default=1)
    parser.add_argument('--long-ms', type=float, default=8)
    parser.add_argument('--gain', type=float, default=2)
    args = parser.parse_args()
    document = build(json.loads(args.linear.read_text()), args.short_ms, args.long_ms, args.gain)
    args.output.write_text(json.dumps(document, indent=2)+'\n')


if __name__ == '__main__':
    main()
