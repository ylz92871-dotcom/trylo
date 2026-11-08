"""audit:release-topology — discover RED, do not fake green. P00 may exit 0 with RED."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TRYLO = REPO.parent
OUT_DIR = TRYLO / "_workspace" / "tasks" / "release-topology"
ROOT_FILES = ("README.md", "package.json", "LICENSE", "LICENSE.md", "NOTICE")

NODES = [
    {"id": "new-cli", "path": REPO, "gate": "P00"},
    {"id": "desktop", "path": TRYLO / "desktop", "gate": "P08"},
    {"id": "desktop-services", "path": TRYLO / "desktop-services", "gate": "P08"},
    # Retired work and the historical official runtime are local archives,
    # not release components. Current Desktop code owns its required modules.
    {"id": "toolchain", "path": TRYLO / "desktop-services" / "toolchain", "gate": "P08"},
    {"id": "mobile-app", "path": TRYLO / "mobile-app", "gate": "P08"},
    {"id": "legacy-cli-compat", "path": TRYLO / "desktop" / "compat" / "legacy-cli", "gate": "P08"},
]


def inspect_node(node: dict) -> dict:
    path: Path = node["path"]
    present = path.is_dir()
    files = {}
    if present:
        for name in ROOT_FILES:
            files[name] = (path / name).is_file()
    license_known = bool(files.get("LICENSE") or files.get("LICENSE.md"))
    package_license = None
    if files.get("package.json"):
        try:
            package = json.loads((path / "package.json").read_text(encoding="utf-8"))
            package_license = package.get("license")
        except (OSError, json.JSONDecodeError):
            package_license = "unreadable"
    red = (not present) or (not license_known) or package_license in {"UNLICENSED", "SEE LICENSE IN README.md"}
    item = {
        "id": node["id"],
        "path": str(path),
        "present": present,
        "licenseFile": license_known,
        "packageLicense": package_license,
        "files": files,
        "owner": "unassigned",
        "disposition": "audit" if red else "retain",
        "dependsOn": [],
        "latestGate": node["gate"],
        "severity": "RED" if red else "GREEN",
    }
    if not present:
        item["reason"] = "path-missing"
    elif not license_known:
        item["reason"] = "no-LICENSE-file"
    elif package_license == "UNLICENSED":
        item["reason"] = "package-UNLICENSED"
    elif package_license == "SEE LICENSE IN README.md":
        item["reason"] = "see-license-in-readme"
    else:
        item["reason"] = "license-file-present"
    return item


def main() -> int:
    items = [inspect_node(node) for node in NODES]
    reds = [item for item in items if item["severity"] == "RED"]
    payload = {
        "gate": "audit:release-topology",
        "phase": "P00",
        "okToReportRed": True,
        "scanned": [item["id"] for item in items],
        "skipped": ["open/", "trylo cli/src", "lockfile-closure", "installer-unpack"],
        "redCount": len(reds),
        "items": items,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "release-topology-backlog.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    print(f"RED {len(reds)} / {len(items)} (P00 allowed; owner=unassigned stub)")
    for item in reds:
        print(f"  RED {item['id']} owner={item['owner']} gate={item['latestGate']} {item['reason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
