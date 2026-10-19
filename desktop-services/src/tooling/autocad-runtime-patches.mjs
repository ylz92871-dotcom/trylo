// Corrections for the pinned AutoCAD MCP Pro 1.5.1 COM adapter.
import fs from 'node:fs/promises';
import path from 'node:path';

export function patchAutocadComSource(source) {
  let result = source;
  // AutoCAD uses late-bound calls already. The regular client wrappers consult
  // the shared makepy/gen_py cache even when attaching to a running instance;
  // a damaged generated module must not disable every CAD operation. Dynamic
  // dispatch preserves COM errors and avoids repairing/deleting shared caches.
  result = result.replaceAll('win32com.client.GetActiveObject(progid)',
    'win32com.client.dynamic.Dispatch(pythoncom.GetActiveObject(pywintypes.IID(progid)).QueryInterface(pythoncom.IID_IDispatch), progid)');
  result = result.replaceAll('win32com.client.Dispatch(progid)', 'win32com.client.dynamic.Dispatch(progid)');
  for (const name of ['system_get_variable', 'system_set_variable']) {
    const start = result.indexOf(`    async def ${name}(`);
    if (start < 0) continue;
    const end = result.indexOf('\n    async def ', start + 1);
    const body = result.slice(start, end < 0 ? undefined : end);
    const corrected = body.replace('app = _acad_app()', 'doc = _acad_doc()');
    result = result.slice(0, start) + corrected + (end < 0 ? '' : result.slice(end));
  }
  // All remaining call sites already capture doc (linetypes, audit, commands).
  // A system variable belongs to that document, never AcadApplication.
  result = result.replace(/\bapp\.(GetVariable|SetVariable)\(/g, 'doc.$1(');

  if (!result.includes('def _trylo_require_com_ready(')) {
    result = result.replace('def _acad_doc():', `def _trylo_require_com_ready(app):
    """Preserve busy state before dynamic dispatch masks it as AttributeError."""
    try:
        ready = bool(app.GetAcadState().IsQuiescent)
    except _COM_ERROR as exc:
        if exc.args and exc.args[0] in (-2147418111, -2147417846):
            raise RuntimeError("AutoCAD is busy and rejected the COM call. Finish the current command or dialog before retrying; no command was sent.") from exc
        raise
    if not ready:
        raise RuntimeError("AutoCAD is busy (IsQuiescent=false). Finish the current command or dialog before retrying; no command was sent.")


def _acad_doc():`);
    result = result.replace('    app = _acad_app()\n    if app.Documents.Count == 0:',
      '    app = _acad_app()\n    _trylo_require_com_ready(app)\n    if app.Documents.Count == 0:');
    result = result.replace('            app = _acad_app()\n            if app.Documents.Count == 0:',
      '            app = _acad_app()\n            _trylo_require_com_ready(app)\n            if app.Documents.Count == 0:');
  }
  result = result.replace('                version = app.Version\n                doc_count = app.Documents.Count',
    `                version = app.Version
                try:
                    _trylo_require_com_ready(app)
                except RuntimeError as exc:
                    return {"backend": "com", "connected": True, "ready": False,
                            "autocad_version": version, "error": str(exc)}
                doc_count = app.Documents.Count`);

  const oldState = '_COM_STATE: dict[str, Any] = {}';
  if (result.includes(oldState)) {
    // A timed-out STA can continue executing. Its replacement must never share
    // the original thread's COM proxy, nor let its teardown clear a new proxy.
    result = result.replace(oldState, '__TRYLO_THREAD_STATE__');
    result = result.replace(/\b_COM_STATE\b/g, '_com_state_cache()');
    result = result.replace('__TRYLO_THREAD_STATE__', `from threading import local as _ThreadLocal
_COM_THREAD_STATE = _ThreadLocal()


def _com_state_cache() -> dict[str, Any]:
    cache = getattr(_COM_THREAD_STATE, "cache", None)
    if cache is None:
        cache = {}
        _COM_THREAD_STATE.cache = cache
    return cache`);
  }
  return result;
}

export async function applyAutocadRuntimePatches(versionDir) {
  const file = path.join(versionDir, '.venv', 'Lib', 'site-packages', 'backends', 'com_backend.py');
  let original;
  try { original = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const corrected = patchAutocadComSource(original);
  if (corrected === original) return false;
  await fs.writeFile(file, corrected, 'utf8');
  return true;
}
