import path from 'node:path';

export const MODEL_PREVIEW_VERSION = '1';
export const MODEL_PREVIEW_EXTENSIONS = new Set(['.stl', '.obj', '.glb', '.gltf', '.3mf', '.step', '.stp', '.iges', '.igs', '.brep', '.brp']);
export const MODEL_PREVIEW_NAMES = Object.freeze(['preview_open', 'preview_view', 'preview_snapshot', 'preview_close']);
const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
export const MODEL_PREVIEW_TOOLS = Object.freeze([
  { name: 'preview_open', description: 'Open a workspace model file (GLB/glTF, OBJ, STL, 3MF, STEP/IGES/BREP) in Trylo while building it. Reopening refreshes it while preserving the camera; autoRefresh reports file watching availability. Call preview_snapshot to inspect the rendered result. For executable Three.js/HTML scenes with lights, animations or interactions, use the existing browser tools to open their local page or development-server URL instead.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'preview_view', description: 'Change the current 3D preview camera, fit or wireframe. Position and target coordinates must be supplied together. Does not modify the model file.', inputSchema: { type: 'object', properties: { preset: { type: 'string', enum: ['isometric', 'front', 'top', 'right'] }, position: vector, target: vector, wireframe: { type: 'boolean' }, fit: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'preview_snapshot', description: 'Return the real current model viewport as an image, with its path, revision and renderer load version. Inspect it while refining the model. For a running Three.js webpage use browser_take_screenshot without a filename to receive an image, and browser_console_messages to inspect runtime errors; a file-only screenshot receipt is not visual verification.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'preview_close', description: 'Close this conversation’s 3D preview and release its file watcher.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]);

export function modelPreviewScope({ projectRoot, conversationId }) {
  if (typeof projectRoot !== 'string' || !projectRoot || typeof conversationId !== 'string' || !conversationId) throw new Error('model_preview_scope_required');
  const root = path.resolve(projectRoot).replaceAll('\\', '/');
  return JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root, conversationId]);
}

export function previewInput(operation, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model_preview_invalid_arguments');
  const allowed = operation === 'open' ? ['path'] : operation === 'view' ? ['preset', 'position', 'target', 'wireframe', 'fit'] : [];
  if (!['open', 'view', 'snapshot', 'close'].includes(operation) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('model_preview_invalid_arguments');
  if (operation === 'open' && (typeof input.path !== 'string' || !input.path.trim() || input.path.includes('\0'))) throw new Error('model_preview_path_required');
  if (input.preset !== undefined && !['isometric', 'front', 'top', 'right'].includes(input.preset)) throw new Error('model_preview_invalid_preset');
  if ((input.position === undefined) !== (input.target === undefined)) throw new Error('model_preview_invalid_camera_pair');
  for (const field of ['position', 'target']) if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length !== 3 || !input[field].every(Number.isFinite))) throw new Error('model_preview_invalid_camera');
  for (const field of ['wireframe', 'fit']) if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error('model_preview_invalid_view');
  return { ...input };
}
