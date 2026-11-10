import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { patchAutocadComSource } from '../../src/tooling/autocad-runtime-patches.mjs';

test('a completed new drawing survives a busy metadata read without replaying Add', () => {
  const source = `class Backend:
    async def drawing_new(self, template=None):
        def _sync():
            app = _acad_app()
            if template:
                doc = app.Documents.Add(template)
            else:
                doc = app.Documents.Add()
            return {"ok": True, "name": doc.Name}

        result = await self._run(_sync)
        await self._ensure_document_state()
        return result
`;
  const patched = patchAutocadComSource(source);
  const harness = `import asyncio
from types import SimpleNamespace as NS
_COM_ERROR = (OSError,)
calls = []
class Document:
    @property
    def Name(self):
        raise AttributeError("<unknown>.Name")
def add(*args):
    calls.append(args)
    return Document()
def _acad_app():
    return NS(Documents=NS(Add=add))
${patched}
async def run(self, fn):
    return fn()
async def busy(self):
    raise RuntimeError("metadata rejected")
Backend._run = run
Backend._ensure_document_state = busy
Backend._reset_document_state = lambda self: None
backend = Backend()
value = asyncio.run(backend.drawing_new())
assert len(calls) == 1
assert value["ok"] is True and value["metadata_pending"] is True
assert backend._document_scope_key is None
print("completed write retained; metadata pending; Add called once")
`;
  const result = spawnSync(process.env.TRYLO_TEST_PYTHON ?? 'python', ['-B', '-'], { input: harness, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(patchAutocadComSource(patched), patched);
});

test('system variables bind to the active document and preserve coercion', () => {
  const original = `class Backend:
    async def system_get_variable(self, name):
        def _sync():
            app = _acad_app()
            return app.GetVariable(name)
    async def system_set_variable(self, name, value):
        def _sync():
            app = _acad_app()
            current = app.GetVariable(name)
            app.SetVariable(name, value)
    async def linetype_load(self):
        doc = _acad_doc()
        app = _acad_app()
        app.SetVariable("FILEDIA", 0)
`;
  const corrected = patchAutocadComSource(original);
  assert.doesNotMatch(corrected, /app\.(GetVariable|SetVariable)/);
  assert.equal((corrected.match(/doc = _acad_doc\(\)/g) ?? []).length, 3);
  assert.match(corrected, /current = doc.GetVariable\(name\)/);
  assert.equal(patchAutocadComSource(corrected), corrected);
});

test('COM cache belongs to its STA thread, including teardown and replacement', () => {
  const original = `_COM_STATE: dict[str, Any] = {}  # keys: "app"
def _acad_app():
    if "app" not in _COM_STATE:
        _COM_STATE["app"] = dispatch()
    return _COM_STATE["app"]
def _com_teardown():
    _COM_STATE.pop("app", None)
`;
  const corrected = patchAutocadComSource(original);
  assert.match(corrected, /_COM_THREAD_STATE = _ThreadLocal\(\)/);
  assert.match(corrected, /_com_state_cache\(\)\["app"\] = dispatch/);
  assert.match(corrected, /_com_state_cache\(\).pop\("app", None\)/);
  assert.doesNotMatch(corrected, /\b_COM_STATE\b/);
  assert.equal(patchAutocadComSource(corrected), corrected);
});

test('AutoCAD can attach and launch when generated pywin32 wrappers are damaged', t => {
  const python = process.env.TRYLO_TEST_PYTHON ?? 'python';
  const probe = spawnSync(python, ['--version'], { windowsHide: true, timeout: 5000 });
  if (probe.error?.code === 'ENOENT') return t.skip('Python is not installed');
  assert.equal(probe.status, 0);
  const original = `def _acad_app():
    try:
        app = win32com.client.GetActiveObject(progid)
    except Exception:
        app = win32com.client.Dispatch(progid)
    return app
`;
  const corrected = patchAutocadComSource(original);
  const harness = `from types import SimpleNamespace as NS
progid = "AutoCAD.Application"
calls = []
raw = NS(QueryInterface=lambda iid: raw)
app = object()
def damaged(*args):
    raise AttributeError("gen_py module has no attribute CLSIDToClassMap")
def dispatch(value, *args):
    calls.append(value)
    return app
def active(value):
    return raw
win32com = NS(client=NS(GetActiveObject=damaged, Dispatch=damaged, dynamic=NS(Dispatch=dispatch)))
pythoncom = NS(GetActiveObject=active, IID_IDispatch="IDispatch")
pywintypes = NS(IID=lambda value: value)
${corrected}
assert _acad_app() is app
assert calls == [raw], "attaching must not launch a second CAD process"
calls.clear()
def absent(value):
    raise OSError("not running")
pythoncom.GetActiveObject = absent
assert _acad_app() is app
assert calls == [progid]
print("attach and launch survived damaged generated wrappers")
`;
  const result = spawnSync(python, ['-B', '-'], { input: harness, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /survived damaged generated wrappers/);
  assert.equal(patchAutocadComSource(corrected), corrected);
});
