"""Check only CLI source/package inputs; never walk external reference checkouts."""

from __future__ import annotations

import json
from pathlib import Path

POLICY = json.loads(Path(__file__).with_name("reference-isolation.json").read_text(encoding="utf-8"))
OPEN_IMPORT_MARKERS = tuple(POLICY["importMarkers"])


def find_open_imports(repo_root: Path) -> list[str]:
    hits: list[str] = []
    src = repo_root / "src"
    if not src.is_dir():
        return hits
    for path in src.rglob("*.ts"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        if any(marker in text for marker in OPEN_IMPORT_MARKERS):
            hits.append(str(path.relative_to(repo_root)).replace("\\", "/"))
    return hits


def find_open_deps(repo_root: Path) -> list[str]:
    hits: list[str] = []
    package_path = repo_root / "package.json"
    if not package_path.is_file():
        return hits
    text = package_path.read_text(encoding="utf-8", errors="ignore")
    if any(marker in text for marker in POLICY["dependencyMarkers"]):
        hits.append("package.json")
    return hits


def check(repo_root: Path) -> dict[str, object]:
    imports = find_open_imports(repo_root)
    deps = find_open_deps(repo_root)
    return {
        "ok": not imports and not deps,
        "importHits": imports,
        "depHits": deps,
        "skipped": POLICY["excludedTrees"],
    }
