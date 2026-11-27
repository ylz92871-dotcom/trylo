// MCPs address the logical CSS page; Chromium input addresses the scaled
// display surface. The native view itself already maps the user's OS input.
export function nativeDisplayInput(message, viewport) {
  const scale = viewport?.mode === 'fixed' ? viewport.scale : 1;
  if (scale === 1 || !message.method.startsWith('Input.')) return message;
  const params = { ...message.params };
  const position = value => Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, ['x', 'y', 'radiusX', 'radiusY'].includes(key) && Number.isFinite(item) ? item * scale : item]));
  if (['Input.dispatchMouseEvent', 'Input.synthesizeTapGesture', 'Input.synthesizePinchGesture', 'Input.synthesizeScrollGesture'].includes(message.method)) {
    Object.assign(params, position(params));
    if (message.method === 'Input.synthesizeScrollGesture') for (const key of ['xDistance', 'yDistance', 'xOverscroll', 'yOverscroll', 'speed']) if (Number.isFinite(params[key])) params[key] *= scale;
  } else if (message.method === 'Input.dispatchTouchEvent' && Array.isArray(params.touchPoints)) params.touchPoints = params.touchPoints.map(position);
  else return message;
  return { ...message, params };
}
