from .runtime_temp import ensure_runtime_temp

# Must run before COM wrappers or any desktop services are imported.
ensure_runtime_temp()
