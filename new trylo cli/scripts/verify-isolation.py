"""Bounded reference isolation entry point, independent of the caller's directory."""

import json
from pathlib import Path
import sys

CLI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI_ROOT / "scripts/quality"))
from verify_isolation import check


if __name__ == "__main__":
    result = check(CLI_ROOT)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["ok"] else 1)
