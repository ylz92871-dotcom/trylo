// Trylo Desktop Services — request method registry. See migration spec §5.2.
//
// The host reads a request frame, looks up the registered handler by method
// name, invokes it with (params, ctx), and routes the result to a response
// frame. Unknown methods fail-closed with UNKNOWN_METHOD (never silently no-op).
//
// Ownership: the only place method names are bound to handlers. Method names
// are namespace-qualified ("pet.enable", "remote.pairingInfo", ...). New
// domains append here and in the TS mirror desktop/src/services-host/methods.ts.
//
// Handler contract:
//   handler(params, ctx) -> result | Promise<result>
// Thrown errors become { ok:false, error:{ code, message } } responses; an
// Error with a `.code` field carries a custom code, otherwise INTERNAL.

export class MethodRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(namespace, method, handler) {
    const name = `${namespace}.${method}`;
    if (this.handlers.has(name)) {
      throw new Error(`registry: method already registered '${name}'`);
    }
    this.handlers.set(name, { handler });
    return this;
  }

  has(name) {
    return this.handlers.has(name);
  }

  /// Returns { handled:true, result } | { handled:false, name } .
  // eslint-disable-next-line class-methods-use-this
  async dispatch(name, params, ctx) {
    const entry = this.handlers.get(name);
    if (!entry) return { handled: false, name };
    let result;
    try {
      result = await entry.handler(params, ctx);
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'INTERNAL';
      const message =
        err instanceof Error ? err.message : `method '${name}' failed`;
      return { handled: true, isError: true, code, message };
    }
    return { handled: true, isError: false, result };
  }
}

export const UNKNOWN_METHOD = 'UNKNOWN_METHOD';
export const INTERNAL = 'INTERNAL';