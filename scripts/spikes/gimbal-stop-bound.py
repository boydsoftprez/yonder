#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded mounted bench probes. See docs/hardware/pocket2-resume-2026-09-08.md.

Observe actual session transmit logs and raw attitude pushes, not the moment
an injection line is queued. This tool deliberately does not start a USB
session or consume an old injection queue. Run the session in a fresh logdir.
"""
import argparse, json, struct, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pocket2'))
from aoa_session import Envelope
import duml
from gimbal_stop_log import consume_session_log
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--logdir', type=Path, default=Path('/var/tmp/aoa'))
parser.add_argument('--mounted-ready', action='store_true', help='camera is secured with clearance for the requested motion')
parser.add_argument('operation', choices=('recentre','rate','mode'))
parser.add_argument('value', nargs='?', type=float)
parser.add_argument('duration', nargs='?', type=float)
parser.add_argument('axis', nargs='?', choices=('yaw','pitch'), default='yaw')
args=parser.parse_args()
if not args.mounted_ready: parser.error('confirm the mounted camera has clearance with --mounted-ready')
if args.operation=='rate' and (args.value is None or args.duration is None or not 0<abs(args.value)<=10 or not 0<args.duration<=2): parser.error('rate needs a nonzero rate up to 10 deg/s and duration up to 2 s')
if args.operation=='mode' and args.value not in (0,1,2): parser.error('mode must be 0, 1 or 2')
root=args.logdir
raw=open(root/'session.from-camera.bin','rb');raw.seek(0,2)
log=open(root/'session.log');log.seek(0,2)
env=Envelope();split=duml.Splitter(); samples=[]; sent=[]; textbuf=''
def poll(seconds):
    global textbuf
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        data=raw.read(1048576); now=time.monotonic()
        if data:
            for route,chunk in env.feed(data):
                if route!=b'\x49\x57':continue
                for kind,f in split.feed(chunk):
                    if kind=='frame' and f.crc_ok and (f.cmdset,f.cmdid)==(4,5) and len(f.payload)>=11:
                        pitch,roll,yaw=struct.unpack_from('<hhh',f.payload)
                        samples.append({'t':now,'pitch':pitch/10,'roll':roll/10,'yaw':yaw/10,'limits':f.payload[10]&7,'flags':f.payload[10],'mode':f.payload[6]>>6})
        textbuf=consume_session_log(textbuf, log.read(), sent, time.monotonic())
        time.sleep(.005)
def inject(spec):
    with open(root/'inject.txt','a') as f:f.write(spec+'\n')
def fresh():
    if not samples or time.monotonic()-samples[-1]['t']>.2:raise RuntimeError('stale attitude')
    if samples[-1]['limits']:raise RuntimeError('limit flag '+str(samples[-1]))
    return samples[-1]
poll(.8)
print('baseline',json.dumps(fresh()),flush=True)
operation=args.operation
if operation=='recentre':
    inject('4:0x4c:0201:4:0');poll(5)
    result={'operation':operation,'before':samples[0],'after':fresh(),'sent':sent,'samples':samples}
elif operation=='mode':
    mode=int(args.value)
    inject(f'4:0x44:{mode:02x}:4:0');poll(5)
    result={'operation':operation,'requested_mode':mode,'before':samples[0],'after':fresh(),'sent':sent,'samples':samples}
elif operation=='rate':
    rate=args.value;duration=args.duration
    axis=args.axis
    fields=[0,0,0];fields[0 if axis=='yaw' else 2]=round(rate*10)
    payload=struct.pack('<hhhB',*fields,0x80).hex()
    spec=f'4:0x0c:{payload}:4:0 x{round(duration*10)}@100'
    before=fresh();inject(spec);poll(duration+4)
    commands=[x for x in sent if f'4:0x0c:{payload}:4:0' in x['line']]
    if len(commands)!=round(duration*10):raise RuntimeError('wrong transmit count '+str(len(commands)))
    end=commands[-1]['t'];after=[s for s in samples if s['t']>=end]
    # Mark movement in 0.2-degree increments to ignore one-count telemetry jitter.
    ref=next(s for s in reversed(samples) if s['t']<=end)[axis];last=end
    for s in after:
        if abs(s[axis]-ref)>=.2:last=s['t'];ref=s[axis]
    final=fresh()
    if any(s['limits'] for s in samples):raise RuntimeError('limit observed; do not recentre automatically')
    if abs(final[axis]-before[axis])<abs(rate)*duration*.5:raise RuntimeError('motion not established; no valid stop measurement')
    stable=[s[axis] for s in after if s['t']>=after[-1]['t']-.5]
    if not stable or max(stable)-min(stable)>=.2:raise RuntimeError('not stable for the final 500ms')
    result={'operation':operation,'axis':axis,'rate':rate,'duration':duration,'before':before,'after':fresh(),'last_tx':end,'last_change':last,'observed_tail_ms':round(1000*(last-end),1),'sample_poll_ms':5,'sent':commands,'samples':samples}
else:raise RuntimeError('unknown operation')
path=root/f'probe-{time.time_ns()}.json';path.write_text(json.dumps(result))
print(json.dumps({k:v for k,v in result.items() if k not in ('samples','sent')}),flush=True)
print('evidence',path,flush=True)
