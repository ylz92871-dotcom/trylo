"""Keep startup independent of the host application's working directory."""

import os
from pathlib import Path
import sys
import tempfile


def ensure_runtime_temp() -> str:
    """Use the normal temp directory, or a writable directory in our own venv.

    Windows source runtimes can have Low integrity while the system TEMP and
    the user's project have Medium integrity. tempfile then has no fallback
    and COM cache import fails before MCP initialize. Never change ACLs: verify
    a private runtime directory with an actual temporary file instead.
    """
    try:
        return tempfile.gettempdir()
    except OSError:
        runtime_temp = Path(sys.prefix) / "trylo-runtime-temp"
        try:
            runtime_temp.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=runtime_temp):
                pass
        except OSError as failure:
            raise RuntimeError("Windows-MCP has no writable runtime temporary directory") from failure
        tempfile.tempdir = str(runtime_temp)
        for name in ("TEMP", "TMP", "TMPDIR"):
            os.environ[name] = str(runtime_temp)
        return str(runtime_temp)
