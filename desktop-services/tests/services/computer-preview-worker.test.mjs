import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { COMPUTER_PREVIEW_WORKER } from '../../src/tooling/computer-preview-worker.mjs';

const python = fileURLToPath(new URL('../../toolchain/computer-control/Windows-MCP/.venv/Scripts/python.exe', import.meta.url));
const available = fs.existsSync(python);

function runSynthetic(harness) {
  // Loading the worker under a non-main module name cannot import Windows
  // capture APIs or call main(). Inputs below are synthetic Pillow pixels.
  const bootstrap = `import base64,sys\nnamespace={'__name__':'preview_unit_fixture'}\nexec(compile(base64.b64decode(sys.stdin.readline()), '<embedded-preview>', 'exec'), namespace)\n${harness}`;
  const result = spawnSync(python, ['-c', bootstrap], {
    input: Buffer.from(COMPUTER_PREVIEW_WORKER).toString('base64') + '\n',
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 3 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('embedded Python captures synthetic full-size frames, masks observer and exits at EOF', { skip: !available }, () => {
  const result = runSynthetic(`
from PIL import Image
from types import SimpleNamespace
import io,json
rect=SimpleNamespace(left=-2560,top=0,right=0,bottom=1600)
count=[0]
def capture(rect):
    count[0]+=1
    return Image.new('RGB',(2560,1600),(30,60,90)), 'synthetic'
output=io.StringIO()
namespace['stream'](capture,rect,lambda:(-1000,200),lambda:(-2550,10,-2500,60),io.StringIO('ignored\\nnext\\nnext\\n'),output,10000)
messages=[json.loads(line) for line in output.getvalue().splitlines()]
image=Image.open(io.BytesIO(base64.b64decode(messages[0]['data'])))
print(json.dumps({'count':count[0],'frames':len(messages),'size':image.size,'origin':messages[0]['originX'],
'seq':[m['seq'] for m in messages],'cursor':messages[0]['cursorX'],'mask':image.getpixel((25,25))}))
`);
  assert.equal(result.count, 2);
  assert.equal(result.frames, 2);
  assert.deepEqual(result.size, [2560, 1600]);
  assert.equal(result.origin, -2560);
  assert.equal(result.cursor, -1000);
  assert.deepEqual(result.seq, [1, 2]);
  assert.ok(Math.abs(result.mask[0] - 247) <= 2);
});

test('embedded encoder adapts quality within IPC cap without reducing dimensions', { skip: !available }, () => {
  const result = runSynthetic(`
from types import SimpleNamespace
import io,json
qualities=[]
class Image:
    width=2560
    height=1600
    size=(width,height)
    def convert(self,mode): return self
    def save(self,buffer,**options):
        qualities.append(options['quality'])
        buffer.write(b'x'*(1350001 if options['quality']==94 else 100))
rect=SimpleNamespace(left=0,top=0,right=2560,bottom=1600)
output=io.StringIO()
namespace['stream'](lambda rect:(Image(),'synthetic'),rect,lambda:(10,20),lambda:None,io.StringIO('next\\nstop\\n'),output,10000)
message=json.loads(output.getvalue())
print(json.dumps({'qualities':qualities,'width':message['width'],'encodedBytes':len(message['data'])}))
`);
  assert.deepEqual(result.qualities, [94, 90]);
  assert.equal(result.width, 2560);
  assert.ok(result.encodedBytes < 1_800_000);
});

test('display selection uses inventory index rather than list offset', { skip: !available }, () => {
  const result = runSynthetic(`
from types import SimpleNamespace
import json
displays=[SimpleNamespace(index=4,rect='screen-four'),SimpleNamespace(index=1,rect='screen-one')]
selected=namespace['select_display'](displays,4)
try:
    namespace['select_display'](displays,0)
except RuntimeError as error:
    missing=str(error)
print(json.dumps({'selected':selected,'missing':missing}))
`);
  assert.equal(result.selected, 'screen-four');
  assert.match(result.missing, /不存在/);
});

test('frame pointer and timestamp stay at capture time when encoding is delayed', { skip: !available }, () => {
  const result = runSynthetic(`
from types import SimpleNamespace
import io,json
clock={'wall':1700000000.0,'cursor':(0,0)}
captures=[0]
cursor_samples=[]
class Image:
    width=2560
    height=1600
    size=(width,height)
    def convert(self,mode): return self
    def save(self,buffer,**options):
        # Model 250 ms of encoding latency and a moving pointer per attempt.
        clock['wall']+=0.25
        clock['cursor']=(clock['cursor'][0]+100,clock['cursor'][1]+100)
        buffer.write(b'x'*(1350001 if options['quality']==94 else 100))
def capture(rect):
    captures[0]+=1
    clock['wall']=1700000000.0+(captures[0]-1)*2
    clock['cursor']=(captures[0]*10,captures[0]*20)
    return Image(),'synthetic'
def cursor():
    cursor_samples.append(clock['cursor'])
    return clock['cursor']
namespace['time']=SimpleNamespace(monotonic=lambda:0,sleep=lambda seconds:None,time=lambda:clock['wall'])
rect=SimpleNamespace(left=0,top=0,right=2560,bottom=1600)
output=io.StringIO()
namespace['stream'](capture,rect,cursor,lambda:None,io.StringIO('next\\nnext\\nstop\\n'),output,10000)
messages=[json.loads(line) for line in output.getvalue().splitlines()]
print(json.dumps({'timestamps':[m['timestamp'] for m in messages],
'cursors':[[m['cursorX'],m['cursorY']] for m in messages],
'cursorSamples':cursor_samples,'encodedUntil':int(clock['wall']*1000)}))
`);
  assert.deepEqual(result.timestamps, [1_700_000_000_000, 1_700_000_002_000]);
  assert.deepEqual(result.cursors, [[10, 20], [20, 40]]);
  assert.deepEqual(result.cursorSamples, result.cursors);
  assert.equal(result.encodedUntil, 1_700_000_002_500);
});
