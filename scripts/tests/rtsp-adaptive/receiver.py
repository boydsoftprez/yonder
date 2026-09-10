# SPDX-License-Identifier: GPL-3.0-or-later
import gi,time,json,os,urllib.request,urllib.error
gi.require_version('Gst','1.0')
from gi.repository import Gst
Gst.init(None)
try:
 urllib.request.urlopen('http://media:9997/v3/rtspsessions/list',timeout=2)
 raise RuntimeError('Observation API is exposed to the receiver network')
except urllib.error.HTTPError as error:
 raise RuntimeError('Observation API is reachable on the receiver network: '+str(error.code))
except urllib.error.URLError:pass
transport=os.environ.get('TEST_TRANSPORT','tcp')
frames=[0]
p=Gst.parse_launch('rtspsrc location=rtsp://yonder:fixture-video@media:8554/cam0 protocols='+transport+' latency=120 ! rtph264depay ! h264parse ! avdec_h264 ! fakesink name=out sync=false signal-handoffs=true')
p.get_by_name('out').connect('handoff',lambda *args:frames.__setitem__(0,frames[0]+1))
p.set_state(Gst.State.PLAYING);bus=p.get_bus();last=time.monotonic();old=0;start=last
try:
 while not os.path.exists('/results/stop') and time.monotonic()-start<180:
  message=bus.timed_pop_filtered(100*Gst.MSECOND,Gst.MessageType.ERROR)
  if message:raise RuntimeError(str(message.parse_error()[0]))
  now=time.monotonic()
  if frames[0] and not os.path.exists('/results/client-ready'):open('/results/client-ready','w').close()
  if now-last>=1:
   with open('/results/receiver.jsonl','a') as f:f.write(json.dumps({'at':time.time()*1000,'frames':frames[0],'fps':(frames[0]-old)/(now-last)})+'\n')
   last=now;old=frames[0]
finally:p.set_state(Gst.State.NULL)
