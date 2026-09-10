// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('releases CSI capture before encoding a copied frame, and refuses missing frames', () => {
  const host = fileURLToPath(new URL('../../../../installer/payload/yonder-pipeline', import.meta.url));
  const program = `
import ast, os, sys, tempfile, types
source=ast.parse(open(sys.argv[1]).read())
host=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='Host')
method=next(n for n in host.body if isinstance(n,ast.FunctionDef) and n.name=='isolated_still')
steps=[]; available=[True]; owned=object(); descriptions=[]
class Caps:
    def copy(self): return Caps()
    def get_structure(self,i): return types.SimpleNamespace(get_value=lambda k:1920 if k=='width' else 1080)
class Buffer:
    def copy_deep(self): steps.append('copy'); return owned
    def get_size(self): return 4
    def extract_dup(self,*args): return b'jpeg'
class Sample:
    def get_buffer(self): return Buffer()
    def get_caps(self): return Caps()
class Branch:
    def __init__(self,*args): self.elements=[types.SimpleNamespace(emit=lambda *a:Sample() if available[0] else None)]
    def head(self): return types.SimpleNamespace(add_probe=lambda *a:None)
    def start(self): steps.append('start')
    def unhook(self): steps.append('unhook')
    def dispose(self): steps.append('dispose')
class Encoder:
    def set_state(self,state): steps.append(state)
    def get_by_name(self,name):
        def emit(op,*args):
            if op=='push-buffer': assert args[0] is owned
            return Sample() if op=='try-pull-sample' else None
        return types.SimpleNamespace(set_property=lambda *a:None,emit=emit)
def launch(*args):
    assert steps[-2:]==['unhook','dispose']; descriptions.append(args[0]); steps.append('encode'); return Encoder()
owner=types.SimpleNamespace(pipeline=types.SimpleNamespace(get_by_name=lambda n:types.SimpleNamespace(get_static_pad=lambda p:types.SimpleNamespace(get_current_caps=lambda:Caps()))))
def remove(path):
    if os.path.exists(path): os.unlink(path)
ns=dict(Gst=types.SimpleNamespace(SECOND=1000000000,parse_launch=launch,ElementFactory=types.SimpleNamespace(find=lambda name:True),State=types.SimpleNamespace(PLAYING='playing',NULL='null'),PadProbeType=types.SimpleNamespace(EVENT_UPSTREAM=1)),STILL_FRAME_WAIT_S=0.1,RAW_TEE='raw',Branch=Branch,remove_quietly=remove)
exec(compile(ast.Module(body=[method],type_ignores=[]),sys.argv[1],'exec'),ns)
with tempfile.TemporaryDirectory() as root:
    path=root+'/still.jpg'
    result=ns['isolated_still'](owner,path)
    assert result['bytes']==4 and result['width']==1920 and open(path,'rb').read()==b'jpeg'
    assert steps==['start','copy','unhook','dispose','encode','playing','null'],steps
    steps.clear(); ns['isolated_still'](owner,path,True)
    assert 'mppjpegenc max-pending=1 width=640 height=360' in descriptions[-1]
    available[0]=False; steps.clear()
    result=ns['isolated_still'](owner,path)
    assert 'refused' in result and not os.path.exists(path)
    assert steps==['start','unhook','dispose'],steps
`;
  const result = spawnSync('python3', ['-c', program, host], {encoding:'utf8',timeout:5000});
  expect(result.status, result.stderr).toBe(0);
});
