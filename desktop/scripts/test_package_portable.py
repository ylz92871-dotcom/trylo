"""Exercise the portable packager against a complete, isolated core distribution."""
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile


class CorePortableTest(unittest.TestCase):
    def test_core_packages_without_a_cowork_manifest_or_runtime(self):
        scratch = Path(__file__).resolve().parents[2] / "_workspace" / "tmp" / "portable-packager-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="trylo-core-portable-", dir=scratch) as directory:
            root = Path(directory)
            source = Path(__file__).with_name("package-portable.py")

            def write(relative, content):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content if isinstance(content, bytes) else content.encode())

            profile = json.dumps({
                "distribution": "core", "defaultCliRuntime": "trylo-v1",
                "components": {"coworkRuntime": {"bundled": False, "status": "retired"}},
            })
            write("desktop/package.json", '{"version":"test"}')
            write("desktop/distribution.json", profile)
            write("desktop/src-tauri/resources/distribution.json", profile)
            for tree in ["desktop-services", "sidecars/desktop-companion/publish",
                         "sidecars/hermes-capabilities", "cli", "runtime"]:
                write(f"desktop/src-tauri/resources/{tree}/owned.txt", tree)
            # A stale optional tree must never enter the archive.
            write("desktop/src-tauri/resources/workd/retired.txt", "retired")
            write("desktop/src-tauri/resources/work/bin/trylo-workd.mjs", "retired")
            executable = bytearray(256)
            executable[:2] = b"MZ"
            struct.pack_into("<I", executable, 0x3c, 64)
            executable[64:68] = b"PE\0\0"
            struct.pack_into("<H", executable, 64 + 24 + 68, 2)
            for name in ["trylo-desktop.exe", "Start-Trylo.exe"]:
                write(f"desktop/src-tauri/target/release/{name}", bytes(executable))
            write("desktop/scripts/Start-Trylo.ps1", "# launcher")
            write("desktop/README-Portable.txt", "Core distribution")
            for name in ["NODE-v24.14.1-LICENSE.txt", "TRYLO-LICENSE.txt"]:
                write(f"_workspace/artifacts/result/desktop/{name}", "notice")
            script = root / "desktop/scripts/package-portable.py"
            shutil.copyfile(source, script)
            output = root / "portable.zip"
            result = subprocess.run(
                [sys.executable, str(script), "--component", "desktop", "--output", str(output)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                self.assertIn("cli/owned.txt", names)
                self.assertIn("trylo-desktop.exe", names)
                self.assertFalse(any(name.startswith(("work/", "workd/")) for name in names))
            write("desktop/src-tauri/resources/cli/dist/internal/adapters/managed-work/runner.js", "retired")
            rejected = root / "rejected.zip"
            result = subprocess.run(
                [sys.executable, str(script), "--output", str(rejected)],
                capture_output=True, text=True, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Retired CoWork build output remains", result.stderr)
            self.assertFalse(rejected.exists())

    def test_retired_component_is_rejected_before_packaging(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("package-portable.py")),
             "--component", "cowork"], capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("invalid choice", result.stderr)


if __name__ == "__main__":
    unittest.main()
