import pytest

from windows_mcp.desktop import service
from windows_mcp.desktop.service import Desktop


def _desktop() -> Desktop:
    desktop = Desktop.__new__(Desktop)
    desktop.desktop_state = None
    return desktop


def _patch_primitives(
    monkeypatch: pytest.MonkeyPatch,
    *,
    fail: bool = False,
) -> list[tuple]:
    """Patch the mouse primitives desktop.drag composes. Records every call
    as (name, args) in order; with fail=True any call raises so tests can
    prove validation happens BEFORE input."""
    events: list[tuple] = []

    def record(name: str):
        def fn(*args) -> None:
            if fail:
                pytest.fail(f"input primitive {name} must not be called")
            events.append((name, *args))

        return fn

    monkeypatch.setattr(service, "sleep", lambda seconds: None)
    monkeypatch.setattr(service.uia, "PressMouse", record("PressMouse"))
    monkeypatch.setattr(service.uia, "MoveTo", record("MoveTo"))
    monkeypatch.setattr(service.uia, "MoveToDuration", record("MoveToDuration"))
    monkeypatch.setattr(service.uia, "ReleaseMouse", record("ReleaseMouse"))
    monkeypatch.setattr(service.uia, "RightPressMouse", record("RightPressMouse"))
    monkeypatch.setattr(service.uia, "RightReleaseMouse", record("RightReleaseMouse"))
    monkeypatch.setattr(service.uia, "MiddlePressMouse", record("MiddlePressMouse"))
    monkeypatch.setattr(service.uia, "MiddleReleaseMouse", record("MiddleReleaseMouse"))
    return events


def test_desktop_drag_uses_explicit_start_and_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _patch_primitives(monkeypatch)
    desktop = _desktop()

    result = desktop.drag(
        [100, 200],
        from_loc=[10, 20],
        duration="0.25",
    )

    assert events == [
        ("PressMouse", 10, 20, 0.05),
        ("MoveToDuration", 100, 200, 0.25, 0.05),
        ("ReleaseMouse", 0.5),
    ]
    assert result["start"] == [10, 20]
    assert result["end"] == [100, 200]
    assert result["duration"] == 0.25
    assert result["button"] == "left"


def test_desktop_drag_legacy_start_uses_current_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _patch_primitives(monkeypatch)
    monkeypatch.setattr(service.uia, "GetCursorPos", lambda: (7, 8))
    desktop = _desktop()

    result = desktop.drag((30, 40))

    assert events == [
        ("PressMouse", 7, 8, 0.05),
        ("MoveTo", 30, 40, 1, 0.05),
        ("ReleaseMouse", 0.5),
    ]
    assert result["start"] == [7, 8]
    assert result["end"] == [30, 40]
    assert result["duration"] is None


def test_desktop_drag_supports_right_and_middle_buttons(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _patch_primitives(monkeypatch)
    desktop = _desktop()

    result = desktop.drag([50, 60], from_loc=[1, 2], button="right")

    assert events == [
        ("RightPressMouse", 1, 2, 0.05),
        ("MoveTo", 50, 60, 1, 0.05),
        ("RightReleaseMouse", 0.5),
    ]
    assert result["button"] == "right"

    events.clear()
    desktop.drag([50, 60], from_loc=[1, 2], button="middle")
    assert events[0][0] == "MiddlePressMouse"
    assert events[-1][0] == "MiddleReleaseMouse"


def test_desktop_drag_rejects_unknown_button(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _patch_primitives(monkeypatch)
    desktop = _desktop()

    with pytest.raises(ValueError, match="button"):
        desktop.drag([1, 2], from_loc=[3, 4], button="side")

    assert events == []


def test_desktop_drag_rejects_non_finite_duration() -> None:
    desktop = _desktop()

    with pytest.raises(ValueError, match="finite"):
        desktop.drag([1, 2], from_loc=[3, 4], duration="nan")


@pytest.mark.parametrize("duration", [True, False])
def test_desktop_drag_rejects_boolean_duration_before_input(
    duration: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    desktop = _desktop()
    _patch_primitives(monkeypatch, fail=True)

    with pytest.raises(ValueError, match="finite"):
        desktop.drag([1, 2], from_loc=[3, 4], duration=duration)


@pytest.mark.parametrize(
    ("argument", "value"),
    [
        ("loc", [1]),
        ("loc", [1, True]),
        ("loc", [1, 2.0]),
        ("loc", [1, "2"]),
        ("from_loc", (3,)),
        ("from_loc", (3, False)),
        ("from_loc", (3.0, 4)),
        ("from_loc", ("3", 4)),
    ],
)
def test_desktop_drag_rejects_invalid_points_before_waiting_or_input(
    argument: str,
    value: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    desktop = _desktop()
    _patch_primitives(monkeypatch, fail=True)
    kwargs: dict[str, object] = {
        "loc": [1, 2],
        "from_loc": [3, 4],
        argument: value,
    }

    with pytest.raises(ValueError, match=argument):
        desktop.drag(**kwargs)
