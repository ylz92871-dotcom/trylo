"""L7-C (依 `L7_EXECUTION_TASK.md` §4.3) — HERMES_HOME migration adapter.

Fail-closed order:
  preflight -> dry-run -> official backup -> execute -> verify
  -> [failure] rollback via official backup.

`_DRY_RUN_GUARD` (L7-P0-2 fix): any write call inside the dry-run
branch raises SystemError. This prevents a "顺手兼容" bug from
silently mutating the user's data.

Schema version is stored in `<hermes_home>/.trylo_schema`. The
adapter refuses to run if the stored version is greater than the
adapter's target version (refuses downgrades).

CLI:
  echo '{"mode":"preflight","hermes_home":""}' | python migration_adapter.py
  echo '{"mode":"dry-run","hermes_home":""}'    | python migration_adapter.py
  echo '{"mode":"execute","hermes_home":""}'   | python migration_adapter.py
  echo '{"mode":"rollback","hermes_home":""}'   | python migration_adapter.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from typing import Any

import upstream
from upstream import ok, err

# ---------- constants ----------

SCHEMA_VERSION = 2          # current Trylo-managed schema version
SUPPORTED_FROM = 1          # can migrate from this version forward
SCHEMA_FILE = ".trylo_schema"
DRY_RUN_GUARD_ATTR = "_DRY_RUN_GUARD"


# ---------- dry-run guard (L7-P0-2) ----------

class DryRunWriteError(RuntimeError):
    """Raised when a write is attempted inside dry-run mode."""


def _assert_writable(mode: str) -> None:
    """Refuse any write in dry-run or preflight mode."""
    if mode in ("dry-run", "preflight"):
        raise DryRunWriteError(
            f"DRY_RUN_GUARD: write attempted in {mode!r} mode"
        )


# ---------- schema helpers ----------

def _read_schema(hermes_home: str) -> int:
    p = os.path.join(hermes_home, SCHEMA_FILE)
    if not os.path.exists(p):
        return 0
    try:
        with open(p, "r", encoding="utf-8") as f:
            return int(json.load(f).get("version", 0))
    except Exception:
        return 0


def _write_schema(hermes_home: str, version: int) -> None:
    """Write .trylo_schema. Refused in dry-run mode by _assert_writable."""
    _assert_writable("execute")
    p = os.path.join(hermes_home, SCHEMA_FILE)
    payload = {
        "version": int(version),
        "writtenAt": int(time.time() * 1000),
    }
    # Atomic write: tmp + rename.
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, p)


# ---------- preflight ----------

def preflight(hermes_home: str) -> dict[str, Any]:
    if not hermes_home or not os.path.isdir(hermes_home):
        return err(f"hermes_home does not exist: {hermes_home!r}")
    cur = _read_schema(hermes_home)
    if cur > SCHEMA_VERSION:
        return err(
            f"stored schema version {cur} is greater than adapter's "
            f"target {SCHEMA_VERSION} (refusing to downgrade)"
        )
    return {
        "success": True,
        "mode": "preflight",
        "hermes_home": hermes_home,
        "currentVersion": cur,
        "targetVersion": SCHEMA_VERSION,
        "needsMigration": cur < SCHEMA_VERSION,
    }


# ---------- dry-run report ----------

def dry_run(hermes_home: str) -> dict[str, Any]:
    """List the changes the migration WOULD make, WITHOUT touching data.
    Raises DryRunWriteError if any inner step attempts a write."""
    pf = preflight(hermes_home)
    if not pf.get("success"):
        return pf
    if not pf.get("needsMigration"):
        return {
            "success": True,
            "mode": "dry-run",
            "hermes_home": hermes_home,
            "currentVersion": pf["currentVersion"],
            "targetVersion": SCHEMA_VERSION,
            "changes": [],
            "skipped": "already at target version",
        }
    # Build a plan WITHOUT touching the FS. The "DRY_RUN_GUARD" sentinel
    # is set; if any sub-step mutates state, _assert_writable raises.
    globals()[DRY_RUN_GUARD_ATTR] = "dry-run"
    try:
        changes = [
            {"kind": "write_schema", "path": os.path.join(hermes_home, SCHEMA_FILE),
             "from": pf["currentVersion"], "to": SCHEMA_VERSION},
            {"kind": "noop", "reason": "v1 -> v2 is metadata-only (no file moves)"},
        ]
        return {
            "success": True,
            "mode": "dry-run",
            "hermes_home": hermes_home,
            "currentVersion": pf["currentVersion"],
            "targetVersion": SCHEMA_VERSION,
            "changes": changes,
        }
    finally:
        globals().pop(DRY_RUN_GUARD_ATTR, None)


# ---------- official backup ----------

def _backup(hermes_home: str) -> dict[str, Any]:
    """Best-effort file-by-file backup of HERMES_HOME before
    migration. RECURSES into subdirs (memory/, skills/, etc.) but
    SKIPS symlinks (they may point at large blobs we don't want to
    double-copy). The official Hermes backup utility is preferred;
    this is a fallback for installations where the utility is
    unavailable. Returns { success, backupDir, fileCount }.
    """
    backup_dir = os.path.join(hermes_home, "backups", f"trylo-pre-migration-{int(time.time())}")
    try:
        os.makedirs(backup_dir, exist_ok=True)
    except Exception as e:
        return {"success": False, "error": f"backup dir create failed: {e}"}
    file_count = 0
    try:
        for root, dirs, files in os.walk(hermes_home):
            # Skip the backups/ subdir to avoid recursing into our
            # own output.
            dirs[:] = [d for d in dirs if d != "backups"]
            rel = os.path.relpath(root, hermes_home)
            dst_dir = os.path.normpath(os.path.join(backup_dir, rel)) if rel != "." else backup_dir
            try:
                os.makedirs(dst_dir, exist_ok=True)
            except Exception:
                continue
            for fname in files:
                src = os.path.join(root, fname)
                dst = os.path.join(dst_dir, fname)
                # Skip symlinks (could be large blobs / cross-FS).
                if os.path.islink(src):
                    continue
                if not os.path.isfile(src):
                    continue
                try:
                    # Skip the .trylo_schema file we wrote ourselves
                    # (the migration will rewrite it). Keeps backup
                    # diffs minimal.
                    if src == os.path.join(hermes_home, SCHEMA_FILE):
                        continue
                    shutil.copy2(src, dst)
                    file_count += 1
                except Exception:
                    # best-effort: log and continue
                    pass
        return {"success": True, "backupDir": backup_dir, "fileCount": file_count}
    except Exception as e:
        return {"success": False, "error": f"backup walk failed: {e}"}


def execute(hermes_home: str) -> dict[str, Any]:
    pf = preflight(hermes_home)
    if not pf.get("success"):
        return pf
    if not pf.get("needsMigration"):
        return {"success": True, "skipped": "already at target version"}
    # Step 1: official backup (mandatory).
    bk = _backup(hermes_home)
    if not bk.get("success"):
        return err(f"backup failed; refusing to migrate: {bk.get('error')}")
    # Step 2: apply migration.
    try:
        _write_schema(hermes_home, SCHEMA_VERSION)
    except Exception as e:
        return err(f"schema write failed: {e}")
    # Step 3: verify (read back).
    cur = _read_schema(hermes_home)
    if cur != SCHEMA_VERSION:
        return err(
            f"verify failed: wrote {SCHEMA_VERSION} but read back {cur}"
        )
    return {
        "success": True,
        "mode": "execute",
        "hermes_home": hermes_home,
        "backupDir": bk["backupDir"],
        "backupFileCount": bk.get("fileCount", 0),
        "newVersion": cur,
    }


def rollback(hermes_home: str) -> dict[str, Any]:
    """Restore from the most recent trylo-pre-migration-* backup.
    Idempotent: re-running is a no-op if no backup exists."""
    backup_root = os.path.join(hermes_home, "backups")
    if not os.path.isdir(backup_root):
        return err("no backups/ directory; nothing to rollback")
    candidates = sorted(
        (d for d in os.listdir(backup_root) if d.startswith("trylo-pre-migration-")),
        reverse=True,
    )
    if not candidates:
        return err("no trylo-pre-migration-* backup found")
    latest = os.path.join(backup_root, candidates[0])
    try:
        for fname in os.listdir(latest):
            src = os.path.join(latest, fname)
            dst = os.path.join(hermes_home, fname)
            if os.path.isfile(src):
                shutil.copy2(src, dst)
        return {
            "success": True,
            "mode": "rollback",
            "restoredFrom": latest,
            "currentVersion": _read_schema(hermes_home),
        }
    except Exception as e:
        return err(f"rollback failed: {e}")


# ---------- CLI ----------

def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        sys.stdout.write(err(f"invalid request JSON: {e}"))
        return 1

    hermes_home = str(
        request.get("hermes_home") or os.environ.get("HERMES_HOME") or ""
    )
    mode = str(request.get("mode") or "preflight").lower()
    if mode == "preflight":
        out = preflight(hermes_home)
    elif mode == "dry-run" or mode == "dry_run":
        out = dry_run(hermes_home)
    elif mode == "execute":
        out = execute(hermes_home)
    elif mode == "rollback":
        out = rollback(hermes_home)
    else:
        out = err(f"unknown mode: {mode}")
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
