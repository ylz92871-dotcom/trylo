import path from 'node:path';

export const SOFTWARE_VERSION = '1';
export const SOFTWARE_RUNTIME_FILES = Object.freeze(['controller.py', 'launcher.py', 'worker.py', 'native.py', 'applications.py', 'guard/sitecustomize.py']);
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const windowId = { type: 'string', description: 'For input, use a software_snapshot(mode=window) receipt. Model images are read-only and cannot supply window input coordinates. Coordinates are snapshot pixels in the window’s DPI context.' };
export const SOFTWARE_TOOLS = Object.freeze([
  { name: 'software_status', description: 'List this conversation’s background software applications and windows, plus installed applications. Windows stay inside Trylo; the real desktop and mouse are not controlled. CAD/SOLIDWORKS API tools use the same owned background instance. A preexisting foreground instance is preserved and cannot be attached.', inputSchema: schema() },
  { name: 'software_open', description: 'Launch an installed .exe in this conversation’s background software workspace. Use a path returned by software_status or an explicit executable path. Optional args are passed directly to that executable, without a shell. No main-desktop fallback. Inspect software_snapshot and handle visible startup dialogs. Do not acknowledge authentication/security dialogs without appropriate user authorization.', inputSchema: schema({ path: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, ['path']) },
  { name: 'software_snapshot', description: 'Return a fresh image of the actual background software window. mode=model uses SOLIDWORKS native JPEG export so its 3D model is visible; normal window capture can omit GPU-rendered 3D content. Dialogs always use the window view. Inspect the image after operations; successful window-message delivery is not proof the app accepted input.', inputSchema: schema({ windowId, mode: { type: 'string', enum: ['window', 'model'] } }) },
  { name: 'software_input', description: 'Click, drag, scroll or type only inside an owned background software window, without moving the real mouse or focus. Coordinates are physical pixels of the last window snapshot. Posted input is application-dependent; inspect a fresh screenshot, and prefer the existing CAD API tools for modeling. Temporarily unavailable while the user holds control. Never falls back to global input.', inputSchema: schema({ windowId, kind: { type: 'string', enum: ['click', 'wheel', 'text', 'key'] }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, delta: { type: 'integer' }, path: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, text: { type: 'string' }, key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Space'] } }, ['windowId', 'kind']) },
  { name: 'software_view', description: 'Set the owned SOLIDWORKS model to a standard view and fit it. Does not change model geometry. Then use software_snapshot with mode=model to inspect it.', inputSchema: schema({ preset: { type: 'string', enum: ['isometric', 'front', 'top', 'right'] } }, ['preset']) },
  { name: 'software_resize', description: 'Resize an owned background software window. Width and height are positive window pixels, using the same DPI context as its screenshots. Refresh software_snapshot afterward; old screenshot coordinates no longer apply.', inputSchema: schema({ windowId, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, ['windowId', 'width', 'height']) },
  { name: 'software_close', description: 'Stop this conversation’s background software workspace and its API servers. Unsaved application changes will be lost; save documents with the existing software API before closing. Does not close other desktop applications.', inputSchema: schema() },
]);
export const SOFTWARE_NAMES = Object.freeze(SOFTWARE_TOOLS.map(tool => tool.name));

export function softwareScope({ projectRoot, conversationId } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('software_workspace_scope_required');
  const root = path.resolve(projectRoot).replaceAll('\\', '/').replace(/\/$/, '');
  return JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root, conversationId]);
}

export function softwareInput(operation, input = {}) {
  const tool = SOFTWARE_TOOLS.find(tool => tool.name === `software_${operation}`);
  if (!tool || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('software_invalid_operation');
  const { properties, required } = tool.inputSchema;
  if (Object.keys(input).some(key => !Object.hasOwn(properties, key)) || required.some(key => input[key] === undefined)) throw new Error('software_invalid_arguments');
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (property.enum && !property.enum.includes(value)) throw new Error(`software_invalid_${key}`);
    if (property.type === 'string' && (typeof value !== 'string' || !value || value.includes('\0'))) throw new Error(`software_invalid_${key}`);
    if (['number', 'integer'].includes(property.type) && (!Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value)))) throw new Error(`software_invalid_${key}`);
  }
  if (input.kind === 'text' && typeof input.text !== 'string') throw new Error('software_text_required');
  if (input.kind === 'key' && !input.key) throw new Error('software_key_required');
  if (['click', 'wheel'].includes(input.kind) && ![input.x, input.y].every(value => Number.isFinite(value) && value >= 0)) throw new Error('software_coordinates_required');
  if (input.kind === 'wheel' && !Number.isInteger(input.delta)) throw new Error('software_delta_required');
  if (operation === 'resize' && (![input.width, input.height].every(value => Number.isInteger(value) && value > 0))) throw new Error('software_invalid_window_size');
  if (operation === 'input' && input.path !== undefined && (!Array.isArray(input.path) || input.path.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(value => Number.isFinite(value) && value >= 0)))) throw new Error('software_invalid_drag_path');
  if (operation === 'open') {
    if (typeof input.path !== 'string') throw new Error('software_path_required');
    if (input.args !== undefined && (!Array.isArray(input.args) || !input.args.every(value => typeof value === 'string' && !value.includes('\0')))) throw new Error('software_invalid_launch_arguments');
  }
  return { ...input };
}
