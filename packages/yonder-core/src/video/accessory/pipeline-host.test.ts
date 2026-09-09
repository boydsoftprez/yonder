// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Execute the shipped feeder, with only Gst buffers/clock replaced; real framed Unix I/O. */
describe('packaged accessory appsrc feeder', () => {
  it('restarts a stalled encoder even when its state-change thread cannot answer', () => {
    const host = fileURLToPath(new URL('../../../../../installer/payload/yonder-pipeline', import.meta.url));
    const program = `
import ast, sys, types, time
tree=ast.parse(open(sys.argv[1]).read())
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='watch_progress')
class End(Exception): pass
def end(code): raise End(code)
for first, stall_at, expected in [(0,None,15),(0,1,6),(10,None,5)]:
    tick=[0]; main=types.SimpleNamespace(count=first)
    def pause(seconds):
        tick[0]+=seconds
        if stall_at is not None and tick[0]<=stall_at: main.count+=1
    ns=dict(time=time,os=types.SimpleNamespace(_exit=end),note=lambda text:None)
    exec(compile(ast.Module(body=[fn],type_ignores=[]),sys.argv[1],'exec'),ns)
    try: ns['watch_progress'](main,lambda:tick[0],pause)
    except End as e: assert e.args==(1,)
    assert tick[0]==expected,(tick,expected)
`;
    const r=spawnSync('python3',['-c',program,host],{encoding:'utf8',timeout:5000});
    expect(r.status,r.stderr).toBe(0);
  });
  it('sets running-time PTS from wrapped camera timestamps and exits on generation EOF', () => {
    const host = fileURLToPath(new URL('../../../../../installer/payload/yonder-pipeline', import.meta.url));
    const program = `
import ast, json, socket, struct, sys, tempfile, threading, types
tree = ast.parse(open(sys.argv[1]).read())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'accessory_feed')
frames = []
class Buffer:
    @staticmethod
    def new_allocate(*args): return Buffer()
    def fill(self, offset, data): self.data = data
class Source:
    def emit(self, op, buffer):
        frames.append([buffer.pts, buffer.dts, buffer.duration, list(buffer.data)])
        return 0
class Pipeline:
    def get_by_name(self, name): return Source() if name == 'accessory-source' else None
    def get_clock(self): return types.SimpleNamespace(get_time=lambda: 9000000000)
    def get_base_time(self): return 7000000000
class Done(Exception): pass
def end(code): raise Done(code)
namespace = dict(socket=socket, struct=struct, Gst=types.SimpleNamespace(Buffer=Buffer, MSECOND=1000000, FlowReturn=types.SimpleNamespace(OK=0)),
    os=types.SimpleNamespace(_exit=end), note=lambda text: None, die=end)
exec(compile(ast.Module(body=[function], type_ignores=[]), sys.argv[1], 'exec'), namespace)
with tempfile.TemporaryDirectory(prefix='yp-', dir='/tmp') as root:
    endpoint = root + '/m.sock'
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(endpoint); server.listen(1)
    def send():
        peer, _ = server.accept()
        with peer:
            for stamp in [0xfffffff0,17,51]:
                frame = struct.pack('!II', 4, stamp) + bytes([0,0,1,0x65])
                for byte in frame: peer.sendall(bytes([byte]))
    worker = threading.Thread(target=send); worker.start()
    try: namespace['accessory_feed'](Pipeline(), endpoint)
    except Done as exc: assert exc.args == (1,)
    worker.join(); server.close()
print(json.dumps(frames))
`;
    const result = spawnSync('python3', ['-c', program, host], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      [2_000_000_000, 2_000_000_000, 33_000_000, [0,0,1,0x65]],
      [2_033_000_000, 2_033_000_000, 33_000_000, [0,0,1,0x65]],
      [2_067_000_000, 2_067_000_000, 34_000_000, [0,0,1,0x65]],
    ]);
  });
});
