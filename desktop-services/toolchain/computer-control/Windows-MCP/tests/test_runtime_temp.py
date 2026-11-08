import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    "runtime_temp_under_test", Path(__file__).parents[1] / "src/windows_mcp/runtime_temp.py"
)
runtime_temp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_temp)


def test_preserves_a_working_system_temp(monkeypatch):
    monkeypatch.setattr(runtime_temp.tempfile, "gettempdir", lambda: "existing-temp")
    monkeypatch.setenv("TEMP", "operator-temp")
    assert runtime_temp.ensure_runtime_temp() == "existing-temp"
    assert runtime_temp.os.environ["TEMP"] == "operator-temp"


def test_recovers_before_com_import_without_a_writable_project_or_system_temp(monkeypatch, tmp_path):
    def unavailable():
        raise FileNotFoundError("No usable temporary directory found")

    monkeypatch.setattr(runtime_temp.tempfile, "gettempdir", unavailable)
    monkeypatch.setattr(runtime_temp.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(runtime_temp.tempfile, "tempdir", None)
    for name in ("TEMP", "TMP", "TMPDIR"):
        monkeypatch.setenv(name, "unwritable-system-temp")
    result = runtime_temp.ensure_runtime_temp()
    assert result == str(tmp_path / "trylo-runtime-temp")
    assert runtime_temp.tempfile.tempdir == result
    assert all(runtime_temp.os.environ[name] == result for name in ("TEMP", "TMP", "TMPDIR"))
    assert list(Path(result).iterdir()) == []


def test_reports_a_real_failure_if_the_private_runtime_is_unwritable(monkeypatch, tmp_path):
    def unavailable():
        raise FileNotFoundError("No usable temporary directory found")

    def denied(*args, **kwargs):
        raise PermissionError("runtime denied")

    monkeypatch.setattr(runtime_temp.tempfile, "gettempdir", unavailable)
    monkeypatch.setattr(runtime_temp.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(runtime_temp.Path, "mkdir", denied)
    with pytest.raises(RuntimeError, match="no writable runtime"):
        runtime_temp.ensure_runtime_temp()
