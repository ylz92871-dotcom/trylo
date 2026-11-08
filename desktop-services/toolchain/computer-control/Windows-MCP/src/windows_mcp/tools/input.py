"""Input tools — Click, Type, Scroll, Move, Shortcut, Wait, WaitFor."""

import json
import math
import time
from collections.abc import Callable, Iterator
from typing import Any, Literal

from mcp.types import ToolAnnotations
from windows_mcp.infrastructure import with_analytics
from windows_mcp.runtime.results import DispatchStatus, VerificationEvidence
from windows_mcp.runtime.predicates import Predicate
from windows_mcp.runtime import predicates as _predicates
from windows_mcp.tools._action_helpers import project_dispatched_action
from windows_mcp.runtime.target_resolver import ResolvedTarget
from fastmcp import Context


WaitForCondition = Literal[
    "text_exists",
    "active_window",
    "element_exists",
    "element_enabled",
    "focused_element",
    "frame_changed",
]


def _project_input_action(
    desktop: Any,
    legacy_text: str,
    *,
    action_name: str,
    execution_channel: str,
    resolved_loc: list | None = None,
    snapshot_id: str | None = None,
    element_id: str | None = None,
    label: int | None = None,
    element: str | None = None,
    resolved_target: ResolvedTarget | None = None,
    dispatch_status: DispatchStatus = DispatchStatus.ACCEPTED,
    verification: VerificationEvidence | None = None,
    pre_revision: int = 0,
    post_revision: int | None = None,
    takeover: str | None = None,
) -> str:
    window_handle = None
    process_id = None
    if resolved_target is not None:
        receipt = resolved_target.receipt
        target_kind = receipt.target_kind
        target_description = receipt.description
        snapshot_id = receipt.snapshot_id
        element_id = receipt.element_id
        window_handle = receipt.window_handle
        process_id = receipt.process_id
    elif element_id is not None:
        target_kind = "element"
        target_description = f"snapshot element {element_id}"
    elif label is not None:
        target_kind = "snapshot_label"
        target_description = f"snapshot label {label}"
    elif element is not None:
        target_kind = "element_query"
        target_description = f"element query {element!r}"
    elif resolved_loc is not None:
        target_kind = "screen_point"
        target_description = f"screen point ({resolved_loc[0]},{resolved_loc[1]})"
    else:
        target_kind = "focused_control"
        target_description = "currently focused control"
    return project_dispatched_action(
        desktop,
        legacy_text,
        target_kind=target_kind,
        target_description=f"{action_name} on {target_description}",
        execution_channel=execution_channel,
        snapshot_id=snapshot_id,
        element_id=element_id,
        window_handle=window_handle,
        process_id=process_id,
        window_title=_resolved_window_title(desktop, resolved_target),
        dispatch_status=dispatch_status,
        verification=verification,
        pre_revision=pre_revision,
        post_revision=post_revision,
        takeover=takeover,
    )


def _resolved_window_title(desktop: Any, resolved_target: Any) -> str | None:
    """Best-effort display title of the resolved window, for the host's
    approval summary. Any failure just omits it."""
    handle = getattr(getattr(resolved_target, "receipt", None), "window_handle", None)
    if handle is None:
        return None
    try:
        import win32gui

        return win32gui.GetWindowText(int(handle)) or None
    except Exception:
        return None


def _resolve_label(
    desktop: Any, label: int, snapshot_id: str | None = None
) -> list[int]:
    """Resolve a UI element label to screen coordinates."""
    _validate_label_id(label)
    if snapshot_id:
        try:
            return list(
                desktop.get_coordinates_from_snapshot_ref(snapshot_id, label=label)
            )
        except Exception as e:
            raise ValueError(
                f"Failed to resolve label {label} in snapshot {snapshot_id!r}: {e}"
            ) from e
    try:
        return list(desktop.get_coordinates_from_label(label))
    except Exception as e:
        raise ValueError(f"Failed to find element with label {label}: {e}")


def _resolve_element_id(
    desktop: Any, snapshot_id: str | None, element_id: str
) -> list[int]:
    if not snapshot_id:
        raise ValueError("snapshot_id is required when element_id is provided")
    if not element_id.strip():
        raise ValueError("element_id must not be empty")
    try:
        return list(
            desktop.get_coordinates_from_snapshot_ref(
                snapshot_id, element_id=element_id.strip()
            )
        )
    except Exception as e:
        raise ValueError(
            f"Failed to resolve element_id {element_id!r} in snapshot "
            f"{snapshot_id!r}: {e}"
        ) from e


def _validate_label_id(label: object, name: str = "label") -> int:
    """Return a valid snapshot label; reject bools and negative indexing.

    Python treats bool as int and sequences accept negative indexes.  Both are
    unsafe for an action target because ``-1`` would silently select a real,
    unrelated element from the end of the snapshot.
    """
    if type(label) is not int or label < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return label


def _resolve_element(desktop: Any, element: str) -> list[int]:
    """Resolve a UI element by its textual description to screen coordinates."""
    try:
        return list(desktop.get_coordinates_from_element(element))
    except Exception as e:
        raise ValueError(f"Failed to resolve element {element!r}: {e}")


def _resolve_target(
    desktop: Any,
    loc: list | None,
    label: int | None,
    element: str | None,
    snapshot_id: str | None = None,
    element_id: str | None = None,
    coordinate_space: str = "screen",
) -> tuple[list | None, ResolvedTarget | None]:
    """Resolve a click target with explicit priority: loc > label > element.

    Only the FIRST provided targeting signal is honored. A precise loc= is the
    agent's calibrated intent and must never be hijacked by a fuzzy element=
    match (stress-test finding: element='发送文件按钮' silently re-targeted a
    calibrated loc= to the WeChat nav button).
    """
    resolver = getattr(desktop, "resolve_action_point", None)
    if callable(resolver):
        resolved = resolver(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
        )
        if isinstance(resolved, ResolvedTarget):
            point = list(resolved.screen_point) if resolved.screen_point is not None else None
            return point, resolved
    if loc is not None:
        return loc, None
    if element_id is not None:
        return _resolve_element_id(desktop, snapshot_id, element_id), None
    if label is not None:
        return _resolve_label(desktop, label, snapshot_id), None
    if element is not None:
        return _resolve_element(desktop, element), None
    return None, None


def _convert_loc(
    desktop: Any,
    loc: list | None,
    coordinate_space: str | None,
    snapshot_id: str | None = None,
) -> list | None:
    """Convert loc from image-pixel space to screen space when the caller asks
    for coordinate_space='screenshot'. Fails fast when no screenshot state
    exists to derive the mapping from, so a caller is never silently mis-targeted.
    """
    if loc is None or coordinate_space != "screenshot":
        return loc
    if snapshot_id:
        sx, sy = desktop.snapshot_image_to_screen(snapshot_id, loc[0], loc[1])
        return [sx, sy]
    sx, sy = desktop.image_to_screen_strict(loc[0], loc[1])
    return [sx, sy]


def _conversion_note(loc: list | None, converted: list | None, coordinate_space: str | None) -> str:
    """Short result suffix when a screenshot-space loc was converted to screen
    coordinates, so the caller sees the exact mapping that was applied."""
    if (
        coordinate_space == "screenshot"
        and loc is not None
        and converted is not None
        and len(loc) == 2
        and len(converted) == 2
        and (loc[0] != converted[0] or loc[1] != converted[1])
    ):
        return f" [image pixel ({loc[0]},{loc[1]}) -> screen ({converted[0]},{converted[1]})]"
    return ""


def _actual_cursor_position(desktop: Any, x: int, y: int) -> tuple[int, int] | None:
    """Best-effort readback of the cursor's real landing position after a move.

    This is the calibration aid: one return value replaces a whole Move ->
    screenshot -> eyeball round trip. Returns None when the probe is
    unavailable (mocked desktops, transient Win32 failure) so the caller can
    fall back to the plain move message instead of fabricating a readback.
    """
    try:
        return desktop.get_cursor_location()
    except Exception:
        return None


def _as_bool(value: bool | str, name: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    raise ValueError(f"{name} must be true or false")


# §13.2 v1 contract: expected_postconditions accepts ONLY no-argument
# predicate names. Postconditions are a change-detection surface — content
# assertions (text/element queries, window titles) stay with WaitFor, and
# dict-shaped parameterized predicates wait for real-machine matrix feedback.
def _postcondition_unconfirmed_note(dispatch: Any) -> str:
    """Legacy-text note when a caller-supplied expected_postcondition was not
    confirmed in the post-dispatch observation window. The result's effect
    already degrades to unknown_outcome (no verification evidence); this note
    names WHAT to re-check so the model does not read silence as success."""
    unconfirmed = (
        dispatch.get("postconditions_unconfirmed")
        if isinstance(dispatch, dict)
        else None
    )
    if not unconfirmed:
        return ""
    return (
        " Expected postconditions not confirmed: "
        + ", ".join(unconfirmed)
        + ". Obtain a fresh observation before relying on the effect."
    )


def _parse_expected_postconditions(
    value: list[str] | str | None,
) -> tuple[Predicate, ...] | None:
    """Normalize an expected_postconditions argument to Predicate objects.

    Accepts a list, a JSON-stringified list, or a single name (Claude
    Desktop workaround, same style as _as_loc/_as_str_list). Unknown or
    parameterized predicate names raise ValueError naming the v1 vocabulary.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    builders = {
        "frame_changed": _predicates.frame_changed,
        "element_exists": _predicates.exists,
        "element_gone": _predicates.gone,
    }
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("["):
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "expected_postconditions is not a valid list of predicate names"
                ) from exc
        else:
            value = [stripped]
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("expected_postconditions must be a list of predicate names")
    parsed: list[Predicate] = []
    seen: set[str] = set()
    for item in value:
        normalized = item.strip().lower().replace("-", "_")
        builder = builders.get(normalized)
        if builder is None:
            raise ValueError(
                "expected_postconditions supports only parameterless predicate names: "
                + ", ".join(sorted(builders))
            )
        if normalized not in seen:
            seen.add(normalized)
            parsed.append(builder())
    return tuple(parsed) if parsed else None


def _as_str_list(value: list[str] | str | None, name: str) -> list[str] | None:
    """Coerce a modifiers argument (list, JSON-stringified list, or space/
    plus-separated string like 'ctrl+shift') to a list of key names."""
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{name} is not a valid list of modifier keys") from exc
            if not isinstance(parsed, list) or not all(isinstance(v, str) for v in parsed):
                raise ValueError(f"{name} must be a list of modifier key names")
            return parsed
        for separator in ("+", " "):
            if separator in stripped:
                return [part for part in stripped.split(separator) if part]
        return [stripped] if stripped else None
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return value
    raise ValueError(f"{name} must be a list of modifier key names")


def _as_number(value: object, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number between {minimum} and {maximum}")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number between {minimum} and {maximum}") from exc
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"{name} must be a number between {minimum} and {maximum}")
    return number


def _focus_window(desktop: Any, window: str | None) -> str:
    """Focus the named window before an input action (P1: clicks and keys
    must land in the TARGET window, not whichever happens to be frontmost).
    Raises when nothing matches so the caller fails fast instead of typing
    into the wrong app."""
    if window is None or not str(window).strip():
        return ""
    return desktop.focus_window(str(window).strip())


def _ime_note_from_layout(layout: dict[str, object] | None) -> str:
    """Warning appended to Type results when a non-English layout / open
    IME may have intercepted characters (P1-8: IME awareness)."""
    if layout is None:
        return ""
    if layout.get("is_english") is not False:
        return ""
    detail = f"layout {layout.get('layout_id')}"
    if layout.get("ime_open"):
        detail += ", IME open"
    return (
        f" Warning: non-English keyboard layout active ({detail}) — characters may "
        "have been intercepted or converted by the input method. If the text did "
        "not arrive verbatim, switch to an English layout, or set the text via "
        "Clipboard (mode='set') and press Ctrl+V with Shortcut."
    )


def _ime_note(desktop: Any) -> str:
    try:
        layout = desktop.keyboard_layout()
    except Exception:
        return ""
    return _ime_note_from_layout(layout)


def _focused_control_is_protected(desktop: Any) -> bool | None:
    """Read the focused UIA control's IsPassword flag.

    True  — the focused control is password/protected: results must not echo
            or summarize the text (no value, no hash, no length).
    False — control reports itself as not a password field.
    None  — probe unavailable (mocked desktop, COM failure, non-Windows test
            host): treat as not protected, the sensitive-echo ban still holds.
    """
    getter = getattr(desktop, "focused_control_is_protected", None)
    if getter is None:
        return None
    try:
        result = getter()
    except Exception:
        return None
    if isinstance(result, bool):
        return result
    return None


def _type_result_summary(text: str, *, protected: bool | None) -> dict[str, object]:
    """Build the Type result body without the text itself (WCC-P0-01 / A-12):
    the tool result must never carry the typed characters — they land in
    transcripts and logs. Protected (password) targets get no content facts
    at all: no length, no non-ASCII flag, nothing to correlate."""
    length = len(text)
    return {
        "char_count": None if protected else length,
        "has_non_ascii": None if protected else any(ord(c) > 127 for c in text),
    }


def _validate_finite_number(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")


def _as_loc(value: list | str | None) -> list | None:
    """Coerce a JSON-stringified list back to a list.

    Claude Desktop strips anyOf schemas and the model serializes lists as
    strings (e.g. '[100, 200]'). Parsing here keeps the tools working.
    """
    if value is None or isinstance(value, list):
        return value
    return json.loads(value)


def _as_point(value: object, name: str) -> list[int]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{name} must be a list of exactly 2 integers [x, y]")
    parsed = []
    for item in value:
        if isinstance(item, bool):
            raise ValueError(f"{name} must contain integers, not booleans")
        if isinstance(item, int):
            parsed.append(item)
            continue
        if isinstance(item, str):
            stripped = item.strip()
            if stripped and stripped.lstrip("+-").isdigit():
                parsed.append(int(stripped))
                continue
        raise ValueError(f"{name} must contain exactly 2 integers")
    return parsed


def _text_matches(value: object | None, expected: str | None) -> bool:
    if expected is None:
        return True
    if value is None:
        return False
    return expected.casefold() in str(value).casefold()


def _metadata_text_matches(metadata: dict[str, object], expected: str | None) -> bool:
    return any(_text_matches(value, expected) for value in metadata.values())


def _iter_nodes(desktop_state: Any) -> Iterator[Any]:
    tree_state = getattr(desktop_state, "tree_state", None)
    if tree_state is None:
        return
    yield from getattr(tree_state, "interactive_nodes", [])
    yield from getattr(tree_state, "scrollable_nodes", [])


def _iter_text_sources(desktop_state: Any) -> Iterator[object]:
    active_window = getattr(desktop_state, "active_window", None)
    if active_window is not None:
        yield active_window.name

    for window in getattr(desktop_state, "windows", []):
        yield window.name

    tree_state = getattr(desktop_state, "tree_state", None)
    if tree_state is None:
        return

    for node in _iter_nodes(desktop_state):
        yield node.name
        yield node.control_type
        yield node.window_name
        for value in getattr(node, "metadata", {}).values():
            yield value

    for node in getattr(tree_state, "dom_informative_nodes", []):
        yield getattr(node, "text", "")


def _node_matches(node: Any, text: str | None, window_name: str | None) -> bool:
    metadata: dict[str, object] = getattr(node, "metadata", {})
    return (
        _text_matches(getattr(node, "name", ""), text)
        or _text_matches(getattr(node, "control_type", ""), text)
        or _metadata_text_matches(metadata, text)
    ) and _text_matches(getattr(node, "window_name", ""), window_name)


def _node_is_enabled(node: Any) -> bool:
    metadata = getattr(node, "metadata", {})
    # Historical snapshots contain only enabled actionable nodes and therefore
    # have no explicit flag.  New/live evaluators should provide is_enabled.
    return metadata.get("is_enabled", True) is True


def _matches_wait_condition(
    desktop_state: Any,
    condition: WaitForCondition,
    text: str | None,
    window_name: str | None,
) -> tuple[bool, str]:
    if condition == "text_exists":
        for source in _iter_text_sources(desktop_state):
            if _text_matches(source, text):
                return True, f"text {text!r} appeared"
        return False, f"text {text!r} was absent"

    if condition == "active_window":
        expected = window_name or text
        active_window = getattr(desktop_state, "active_window", None)
        active_name = active_window.name if active_window else ""
        if _text_matches(active_name, expected):
            return True, f"active window matched {active_name!r}"
        return False, f"active window was {active_name!r}"

    if condition == "element_exists":
        for node in _iter_nodes(desktop_state):
            if _node_matches(node, text, window_name):
                return True, f"element matched {getattr(node, 'name', '')!r}"
        return False, "matching element was absent"

    if condition == "element_enabled":
        disabled_match = False
        for node in _iter_nodes(desktop_state):
            if _node_matches(node, text, window_name):
                if _node_is_enabled(node):
                    return True, f"enabled element matched {getattr(node, 'name', '')!r}"
                disabled_match = True
        if disabled_match:
            return False, "matching element exists but is disabled"
        return False, "matching element was absent"

    if condition == "focused_element":
        for node in _iter_nodes(desktop_state):
            metadata = getattr(node, "metadata", {})
            if metadata.get("has_focused") and _node_matches(node, text, window_name):
                return True, f"focused element matched {getattr(node, 'name', '')!r}"
        return False, "matching focused element was absent"

    raise ValueError(f"Unsupported WaitFor condition: {condition}")


def _validate_wait_for_args(
    condition: str,
    text: str | None,
    window_name: str | None,
    timeout: float,
    interval: float,
) -> WaitForCondition:
    _validate_finite_number(timeout, "timeout")
    _validate_finite_number(interval, "interval")

    normalized = condition.strip().lower().replace("-", "_")
    aliases = {
        "text": "text_exists",
        "window": "active_window",
        "element": "element_exists",
        "enabled": "element_enabled",
        "focused": "focused_element",
    }
    normalized = aliases.get(normalized, normalized)
    valid_conditions = {
        "text_exists",
        "active_window",
        "element_exists",
        "element_enabled",
        "focused_element",
        "frame_changed",
    }
    if normalized not in valid_conditions:
        raise ValueError(
            "condition must be one of: text_exists, active_window, element_exists, "
            "element_enabled, focused_element, frame_changed"
        )

    if timeout <= 0 or timeout > 120:
        raise ValueError("timeout must be greater than 0 and at most 120 seconds")
    if interval <= 0 or interval > 5:
        raise ValueError("interval must be greater than 0 and at most 5 seconds")

    if normalized == "text_exists" and not text:
        raise ValueError("text is required when condition is text_exists")
    if normalized == "active_window" and not (text or window_name):
        raise ValueError("text or window_name is required when condition is active_window")
    if normalized in {"element_exists", "element_enabled"} and not (text or window_name):
        raise ValueError(
            "text or window_name is required when condition is element_exists or element_enabled"
        )

    return normalized


def register(
    mcp: Any,
    *,
    get_desktop: Callable[[], Any],
    get_analytics: Callable[[], Any],
) -> None:
    @mcp.tool(
        name="Click",
        description=(
            "Performs mouse clicks at specified coordinates [x, y], a UI element's label/id, "
            "or by an element's on-screen text (element='Send'). "
            "Priority when more than one is given: loc > label > element — a precise loc= "
            "is never overridden by a fuzzy element= match. "
            "Coordinate space: loc= is physical screen (virtual desktop) pixel by default; "
            "pass coordinate_space='screenshot' when the coordinates were measured on the "
            "last Screenshot/Snapshot image and the tool will convert them for you. "
            "Supports button types: 'left' for selection/activation, 'right' for context menus, "
            "'middle' (double middle click = Zoom Extents in AutoCAD). "
            "Supports clicks: 0=hover only (no click), 1=single click (select/focus), 2=double click (open/activate); "
            "double-click timing is honored for EVERY button. "
            "Set modifiers=['ctrl'] (or 'ctrl+shift') for Ctrl/Shift/Alt/Win+Click (multi-select, range select). "
            "Set action='down' to press and hold, then action='up' (loc optional) to release — "
            "for custom press-drag-release gestures. "
            "Set hold_seconds=<seconds> to press, dwell, and release in ONE call (long press, "
            "e.g. WeChat camera icon ~1.5s) with deterministic timing. "
            "To bind this action to ONE exact window, copy a Window Receipt verbatim from the last Snapshot into window_receipt. The server verifies the receipt against the window the action will hit and refuses (stale_window) when the app restarted or the receipt belongs to a different window. Set window='AutoCAD' (fuzzy title/process match) to focus and restore the target window first "
            "so the click cannot land in the wrong app. "
            "The result reports the window the click landed on and warns when the point is "
            "outside the foreground window's client area (the click may have been swallowed). "
            "For reliable targeting, pass snapshot_id with element_id (preferred) or label from the "
            "same Snapshot. A targeted mutation consumes that snapshot; capture a fresh Snapshot "
            "before the next mutation. screenshot coordinates are interpreted through that "
            "snapshot's FrameRef. Provide exactly one of loc, label, or element (none required "
            "when action='up'). "
            "expected_postconditions (v1: parameterless predicate names only — 'frame_changed', "
            "'element_exists', 'element_gone') verifies a change after the click: the result "
            "confirms only when EVERY predicate is satisfied, otherwise it names the unconfirmed "
            "predicates and reports unknown_outcome."
        ),
        annotations=ToolAnnotations(
            title="Click",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Click-Tool")
    def click_tool(
        loc: list[int] | str | None = None,
        label: int | None = None,
        element: str | None = None,
        snapshot_id: str | None = None,
        element_id: str | None = None,
        button: Literal["left", "right", "middle"] = "left",
        clicks: int = 1,
        modifiers: list[str] | str | None = None,
        action: Literal["click", "down", "up"] = "click",
        hold_seconds: float | int | str | None = None,
        coordinate_space: Literal["screen", "screenshot"] = "screen",
        window: str | None = None,
        window_receipt: dict | None = None,
        expected_postconditions: list[str] | str | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        original_loc = list(loc) if loc is not None else None
        if action != "up" and all(
            value is None for value in (loc, label, element, element_id)
        ):
            raise ValueError("Either loc, label, or element must be provided.")
        if loc is not None and len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
        if loc is not None:
            loc = _as_point(loc, "loc")
        if label is not None:
            label = _validate_label_id(label)
        modifier_list = _as_str_list(modifiers, "modifiers")
        postconditions = _parse_expected_postconditions(expected_postconditions)
        if clicks not in (0, 1, 2, 3):
            raise ValueError("clicks must be 0 (hover), 1, 2, or 3")
        dispatch = desktop.dispatch_click_target(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
            window=window,
            **({"window_receipt": window_receipt} if window_receipt is not None else {}),
            button=button,
            clicks=clicks,
            modifiers=modifier_list,
            action=action,
            hold_seconds=hold_seconds,
            **(
                {"expected_postconditions": postconditions}
                if postconditions is not None
                else {}
            ),
        )
        loc = dispatch["loc"]
        resolved_target = dispatch["resolved_target"]
        focus_note = dispatch["focus_note"]
        hit_note = dispatch["hit_note"]
        execution_channel = dispatch.get("execution_channel", "send_input")
        semantic_action = dispatch.get("semantic_action", "raw_click")
        dispatch_status = dispatch.get("dispatch_status", DispatchStatus.ACCEPTED)
        verification = dispatch.get("verification")
        position = f"({loc[0]},{loc[1]})" if loc is not None else "at the current cursor position"
        modifier_note = (
            f" with {'+'.join(m.lower() for m in modifier_list)}" if modifier_list else ""
        )
        conversion_note = _conversion_note(original_loc, loc, coordinate_space)
        if semantic_action != "raw_click":
            if verification is not None:
                message = f"Confirmed UIA {semantic_action} effect for {position}."
            elif dispatch_status is DispatchStatus.POSSIBLE:
                message = (
                    f"UIA {semantic_action} may have been dispatched for {position}; "
                    "the dispatch outcome is indeterminate. Observe before retrying."
                )
            else:
                message = (
                    f"Dispatched UIA {semantic_action} for {position}; "
                    "the UI effect is not yet verified."
                )
        elif action == "down":
            message = (
                f"Pressed and held {button} mouse button {position}{modifier_note}."
                f"{conversion_note}{hit_note}"
            )
        elif action == "up":
            message = f"Released {button} mouse button {position}{modifier_note}."
        elif hold_seconds is not None and float(hold_seconds) > 0:
            message = (
                f"Held {button} for {float(hold_seconds):g}s at {position}{modifier_note}."
                f"{conversion_note}{hit_note}"
            )
        else:
            num_clicks = {0: "Hover", 1: "Single", 2: "Double", 3: "Triple"}
            click_note = "" if clicks == 1 else f" x{clicks}"
            message = (
                f"{focus_note}{num_clicks.get(clicks, 'Multi')} {button}{click_note} clicked "
                f"at {position}{modifier_note}.{conversion_note}{hit_note}"
            )
        if semantic_action == "raw_click" and verification is not None:
            message += " Confirmed the expected UI state through scoped read-back."
        message += _postcondition_unconfirmed_note(dispatch)
        return _project_input_action(
            desktop,
            message,
            action_name="click",
            execution_channel=execution_channel,
            resolved_loc=loc,
            snapshot_id=snapshot_id,
            element_id=element_id,
            label=label,
            element=element,
            resolved_target=resolved_target,
            dispatch_status=dispatch_status,
            verification=verification,
            pre_revision=dispatch.get("pre_revision", 0),
            post_revision=dispatch.get("post_revision"),
            takeover=dispatch.get("takeover"),
        )

    @mcp.tool(
        name="Type",
        description=(
            "Types text into the current FOCUSED control (omit loc/label/element entirely — no click "
            "is sent; ideal for command lines where a stray click is itself an input, e.g. the AutoCAD "
            "command line), or targets coordinates/label/element as with Click (priority loc > label > element). "
            "Coordinate space: loc= is physical screen pixel by default; pass coordinate_space='screenshot' "
            "for coordinates measured on the last Screenshot/Snapshot image. "
            "Set clear=True to clear existing text first, False to append. Set press_enter=True to submit "
            "after typing. Set caret_position to 'start' (beginning), 'end' (end), or 'idle' (default). "
            "Newlines in text become Enter keystrokes (multi-line sequences ride one call). "
            "interval=<seconds> controls the per-key delay (default 0.04; raise it for slow prompt-driven "
            "CLIs, lower it for long pastes — text >=20 chars without special keys rides the clipboard "
            "paste path automatically). "
            "Non-ASCII text (Chinese, accented chars, emoji) is ALWAYS auto-routed through the clipboard "
            "(Ctrl+V) to bypass the IME — Microsoft Pinyin etc. intercept per-key typing. "
            "To bind this action to ONE exact window, copy a Window Receipt verbatim from the last Snapshot into window_receipt; the server refuses the action when the receipt no longer matches the resolved window. Set window='AutoCAD' (fuzzy title/process match) to focus and restore the target window first "
            "so keystrokes cannot land in the wrong app. Non-English keyboard layouts / open IMEs are "
            "detected and reported in the result. For privacy the typed text is NEVER echoed back — "
            "the result reports the character count (and for password fields, nothing about the content). "
            "For a targeted field, pass snapshot_id with element_id (preferred) or label from one fresh "
            "Snapshot. The mutation consumes that snapshot, so observe again before another mutation. "
            "expected_postconditions (v1: parameterless predicate names only — 'frame_changed', "
            "'element_exists', 'element_gone') verifies a change after typing: the result "
            "confirms only when EVERY predicate is satisfied, otherwise it names the unconfirmed "
            "predicates and reports unknown_outcome."
        ),
        annotations=ToolAnnotations(
            title="Type",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Type-Tool")
    def type_tool(
        text: str,
        loc: list[int] | str | None = None,
        label: int | None = None,
        element: str | None = None,
        snapshot_id: str | None = None,
        element_id: str | None = None,
        clear: bool | str = False,
        caret_position: Literal["start", "idle", "end"] = "idle",
        press_enter: bool | str = False,
        interval: float | int | str | None = None,
        coordinate_space: Literal["screen", "screenshot"] = "screen",
        window: str | None = None,
        window_receipt: dict | None = None,
        expected_postconditions: list[str] | str | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        if loc is not None and len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
        if loc is not None:
            loc = _as_point(loc, "loc")
        if label is not None:
            label = _validate_label_id(label)
        if interval is not None:
            interval = _as_number(interval, "interval", 0.0, 0.5)
        postconditions = _parse_expected_postconditions(expected_postconditions)
        dispatch = desktop.dispatch_type_target(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
            window=window,
            **({"window_receipt": window_receipt} if window_receipt is not None else {}),
            text=text,
            caret_position=caret_position,
            clear=clear,
            press_enter=press_enter,
            interval=interval,
            **(
                {"expected_postconditions": postconditions}
                if postconditions is not None
                else {}
            ),
        )
        loc = dispatch["loc"]
        resolved_target = dispatch["resolved_target"]
        protected = dispatch["protected"]
        execution_channel = dispatch.get(
            "execution_channel", "send_keys_or_clipboard"
        )
        semantic_action = dispatch.get("semantic_action", "raw_type")
        dispatch_status = dispatch.get("dispatch_status", DispatchStatus.ACCEPTED)
        verification = dispatch.get("verification")
        position = f"at ({loc[0]},{loc[1]})" if loc is not None else "into the focused control"
        summary = _type_result_summary(text, protected=protected)
        if verification is not None:
            result = "Confirmed the typed value through scoped UIA read-back. Text remains redacted."
        elif semantic_action != "raw_type" and dispatch_status is DispatchStatus.POSSIBLE:
            result = (
                "UIA set_value may have been dispatched; its outcome is indeterminate. "
                "Text remains redacted. Observe before retrying."
            )
        elif protected:
            # Password/protected target: report delivery only — no length,
            # no character-class facts, nothing to correlate (WCC-P0-01).
            result = (
                f"Typed <redacted> {position}. "
                "Text facts withheld: the target is a protected field."
            )
        else:
            result = f"Typed {summary['char_count']} character(s) {position}."
            if summary["has_non_ascii"]:
                # Auto-routed through the clipboard inside desktop.type; tell the
                # caller so they do not re-do the clipboard dance by hand.
                result += " Auto-routed through the clipboard (Ctrl+V) to bypass the IME."
            else:
                result += _ime_note_from_layout(dispatch["keyboard_layout"])
        result += _postcondition_unconfirmed_note(dispatch)
        return _project_input_action(
            desktop,
            result,
            action_name="type",
            execution_channel=execution_channel,
            resolved_loc=loc,
            snapshot_id=snapshot_id,
            element_id=element_id,
            label=label,
            element=element,
            resolved_target=resolved_target,
            dispatch_status=dispatch_status,
            verification=verification,
            pre_revision=dispatch.get("pre_revision", 0),
            post_revision=dispatch.get("post_revision"),
            takeover=dispatch.get("takeover"),
        )

    @mcp.tool(
        name="Scroll",
        description=(
            "Scrolls at coordinates [x, y], a UI element's label/id, by an element's on-screen text "
            "(element='list'), or current mouse position if loc/label/element are all omitted. "
            "Priority when more than one is given: loc > label > element. "
            "Coordinate space: loc= is physical screen pixel by default; pass coordinate_space='screenshot' "
            "for coordinates measured on the last Screenshot/Snapshot image. "
            "Type: vertical (default) or horizontal. Direction: up/down for vertical, left/right for horizontal. "
            "wheel_times controls the number of wheel notches (1 wheel ≈ 3-5 lines). "
            "wheel_delta (default 120 = one full notch) scales each notch: values below 120 give "
            "finer-than-notch zoom in apps that accumulate partial wheel deltas (AutoCAD zoom, map canvases) "
            "— e.g. wheel_delta=30 scrolls a quarter notch per event. "
            "To bind this action to ONE exact window, copy a Window Receipt verbatim from the last Snapshot into window_receipt; the server refuses the action when the receipt no longer matches the resolved window. Set window='AutoCAD' to focus the target window first. "
            "When targeting a point or element, bind it to a fresh snapshot_id; element_id is preferred "
            "over label, and screenshot coordinates use that snapshot's FrameRef. The mutation consumes "
            "the snapshot. Use for navigating long content, lists, web pages, and fine view zoom. "
            "expected_postconditions (v1: parameterless predicate names only — 'frame_changed', "
            "'element_exists', 'element_gone') verifies a change after scrolling: the result "
            "confirms only when EVERY predicate is satisfied, otherwise it names the unconfirmed "
            "predicates and reports unknown_outcome."
        ),
        annotations=ToolAnnotations(
            title="Scroll",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Scroll-Tool")
    def scroll_tool(
        loc: list[int] | str | None = None,
        label: int | None = None,
        element: str | None = None,
        snapshot_id: str | None = None,
        element_id: str | None = None,
        type: Literal["horizontal", "vertical"] = "vertical",
        direction: Literal["up", "down", "left", "right"] = "down",
        wheel_times: int = 1,
        wheel_delta: int | str | None = None,
        coordinate_space: Literal["screen", "screenshot"] = "screen",
        window: str | None = None,
        window_receipt: dict | None = None,
        expected_postconditions: list[str] | str | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        original_loc = list(loc) if loc is not None else None
        if loc and len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
        if loc is not None:
            loc = _as_point(loc, "loc")
        if label is not None:
            label = _validate_label_id(label)
        if (
            isinstance(wheel_times, bool)
            or not isinstance(wheel_times, int)
            or not 1 <= wheel_times <= 100
        ):
            raise ValueError("wheel_times must be an integer between 1 and 100")
        delta = 120 if wheel_delta is None else int(_as_number(wheel_delta, "wheel_delta", 1, 120))
        postconditions = _parse_expected_postconditions(expected_postconditions)
        dispatch = desktop.dispatch_scroll_target(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
            window=window,
            **({"window_receipt": window_receipt} if window_receipt is not None else {}),
            scroll_type=type,
            direction=direction,
            wheel_times=wheel_times,
            wheel_delta=delta,
            **(
                {"expected_postconditions": postconditions}
                if postconditions is not None
                else {}
            ),
        )
        loc = dispatch["loc"]
        resolved_target = dispatch["resolved_target"]
        response = dispatch["response"]
        execution_channel = dispatch.get("execution_channel", "send_input")
        semantic_action = dispatch.get("semantic_action", "raw_scroll")
        dispatch_status = dispatch.get("dispatch_status", DispatchStatus.ACCEPTED)
        verification = dispatch.get("verification")
        if semantic_action != "raw_scroll":
            if verification is not None:
                response = "Confirmed UIA scroll effect through scoped read-back."
            elif dispatch_status is DispatchStatus.POSSIBLE:
                response = (
                    "UIA scroll may have been dispatched; its outcome is indeterminate. "
                    "Observe before retrying."
                )
            else:
                response = "Dispatched UIA scroll; the UI effect is not yet verified."
        if response:
            return _project_input_action(
                desktop,
                response,
                action_name="scroll",
                execution_channel=execution_channel,
                resolved_loc=loc,
                snapshot_id=snapshot_id,
                element_id=element_id,
                label=label,
                element=element,
                resolved_target=resolved_target,
                dispatch_status=dispatch_status,
                verification=verification,
                pre_revision=dispatch.get("pre_revision", 0),
                post_revision=dispatch.get("post_revision"),
            )
        conversion_note = _conversion_note(original_loc, loc, coordinate_space)
        base = f"Scrolled {type} {direction} by {wheel_times} wheel times"
        if delta != 120:
            base += f" (delta {delta}/notch)"
        if loc:
            base += f" at ({loc[0]},{loc[1]})."
            base += conversion_note
        if verification is not None:
            base += " Confirmed the expected scroll state through scoped read-back."
        base += _postcondition_unconfirmed_note(dispatch)
        return _project_input_action(
            desktop,
            base,
            action_name="scroll",
            execution_channel=execution_channel,
            resolved_loc=loc,
            snapshot_id=snapshot_id,
            element_id=element_id,
            label=label,
            element=element,
            resolved_target=resolved_target,
            dispatch_status=dispatch_status,
            verification=verification,
            pre_revision=dispatch.get("pre_revision", 0),
            post_revision=dispatch.get("post_revision"),
            takeover=dispatch.get("takeover"),
        )

    @mcp.tool(
        name="Move",
        description=(
            "Moves mouse cursor to coordinates [x, y], a UI element's label/id, or by an element's on-screen text (element='Save'). "
            "Priority when more than one is given: loc > label > element. "
            "Coordinate space: loc= is physical screen pixel by default; pass coordinate_space='screenshot' "
            "for coordinates measured on the last Screenshot/Snapshot image (from_loc= too, when dragging). "
            "Set drag=True to perform a drag-and-drop operation from the current mouse position "
            "to the target coordinates, or provide from_loc=[x, y] to make the drag explicit-start "
            "and atomic in one tool call. Optional duration controls bounded intermediate movement. "
            "drag button: 'left' (default), 'right' (context-menu drag, e.g. AutoCAD right-drag paste "
            "options), or 'middle' (pan). "
            "Default (drag=False) is a simple cursor move (hover); the result reports the ACTUAL "
            "cursor landing position, so you can read back the real coordinate the OS placed the "
            "cursor at (no separate screenshot needed for calibration). "
            "Pass a fresh snapshot_id for every targeted move/drag; element_id is preferred over label, "
            "and screenshot coordinates use that snapshot's FrameRef. A targeted mutation consumes the "
            "snapshot. To bind this action to ONE exact window, copy a Window Receipt verbatim from the last Snapshot into window_receipt; the server refuses the action when the receipt no longer matches the resolved window. Provide exactly one of loc, label, or element."
        ),
        annotations=ToolAnnotations(
            title="Move",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Move-Tool")
    def move_tool(
        loc: list[int] | str | None = None,
        label: int | None = None,
        element: str | None = None,
        snapshot_id: str | None = None,
        element_id: str | None = None,
        drag: bool | str = False,
        from_loc: list[int] | str | None = None,
        duration: float | int | str | None = None,
        button: Literal["left", "right", "middle"] = "left",
        coordinate_space: Literal["screen", "screenshot"] = "screen",
        window_receipt: dict | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        from_loc = _as_loc(from_loc)
        drag = _as_bool(drag, "drag")
        if all(value is None for value in (loc, label, element, element_id)):
            raise ValueError("Either loc, label, or element must be provided.")
        if loc is not None and (not isinstance(loc, list) or len(loc) != 2):
            raise ValueError("loc must be a list of exactly 2 integers [x, y]")
        if from_loc is not None and (not isinstance(from_loc, list) or len(from_loc) != 2):
            raise ValueError("from_loc must be a list of exactly 2 integers [x, y]")
        has_drag_only_options = any(
            value is not None
            for value in (
                from_loc,
                duration,
            )
        )
        if has_drag_only_options and not drag:
            raise ValueError("from_loc and duration require drag=True")
        if button != "left" and not drag:
            raise ValueError("button requires drag=True")
        if loc is not None:
            loc = _as_point(loc, "loc")
        if label is not None:
            label = _validate_label_id(label)
        original_loc = list(loc) if loc is not None else None
        if from_loc is not None:
            from_loc = _as_point(from_loc, "from_loc")
        dispatcher = getattr(desktop, "dispatch_move_target", None)
        if callable(dispatcher):
            dispatch = dispatcher(
                loc=loc,
                label=label,
                element=element,
                snapshot_id=snapshot_id,
                element_id=element_id,
                coordinate_space=coordinate_space,
                **({"window_receipt": window_receipt} if window_receipt is not None else {}),
                drag=drag,
                from_loc=from_loc,
                duration=duration,
                button=button,
            )
        else:
            # Compatibility for third-party/test Desktop facades predating the
            # actor-atomic command. Production DesktopRuntime always exposes
            # dispatch_move_target, so target resolution and injection remain
            # one non-interleavable actor turn there.
            loc, resolved_target = _resolve_target(
                desktop,
                loc,
                label,
                element,
                snapshot_id,
                element_id,
                coordinate_space,
            )
            if loc is None:
                raise ValueError("Failed to resolve the move target")
            if original_loc is not None:
                loc = _convert_loc(desktop, loc, coordinate_space, snapshot_id)
            converted_from = from_loc
            if converted_from is not None:
                converted_from = _convert_loc(
                    desktop, converted_from, coordinate_space, snapshot_id
                )
            if drag:
                drag_result = desktop.drag(
                    loc,
                    from_loc=converted_from,
                    duration=duration,
                    button=button,
                )
                cursor = None
            else:
                desktop.move(loc)
                drag_result = None
                cursor = _actual_cursor_position(desktop, loc[0], loc[1])
            dispatch = {
                "loc": loc,
                "from_loc": converted_from,
                "resolved_target": resolved_target,
                "drag_result": drag_result,
                "cursor": cursor,
            }
        loc = dispatch["loc"]
        from_loc = dispatch["from_loc"]
        resolved_target = dispatch["resolved_target"]
        if drag:
            loc = _as_point(loc, "loc")
        x, y = loc[0], loc[1]
        conversion_note = _conversion_note(original_loc, loc, coordinate_space)
        if drag:
            result = dispatch["drag_result"]
            start_x, start_y = result["start"]
            effective_duration = result["duration"]
            button_note = "" if button == "left" else f" with the {button} button"
            if effective_duration is None:
                message = (
                    f"Dragged from ({start_x},{start_y}) to ({x},{y})"
                    f"{button_note}.{conversion_note}"
                )
            else:
                message = (
                    f"Dragged from ({start_x},{start_y}) to ({x},{y}){button_note} "
                    f"over {effective_duration:.3f} seconds.{conversion_note}"
                )
        else:
            readback = dispatch["cursor"]
            if readback is None:
                message = f"Moved the mouse pointer to ({x},{y}).{conversion_note}"
            else:
                ax, ay = readback
                if (ax, ay) == (x, y):
                    message = (
                        f"Moved the mouse pointer to ({x},{y}); "
                        f"actual cursor position ({ax},{ay}).{conversion_note}"
                    )
                else:
                    message = (
                        f"Moved the mouse pointer to ({x},{y}); actual cursor position "
                        f"({ax},{ay}) — target and landing differ, the coordinates may be "
                        f"in a different space.{conversion_note}"
                    )
        return _project_input_action(
            desktop,
            message,
            action_name="drag" if drag else "move",
            execution_channel="send_input",
            resolved_loc=loc,
            snapshot_id=snapshot_id,
            element_id=element_id,
            label=label,
            element=element,
            resolved_target=resolved_target,
            takeover=dispatch.get("takeover") if isinstance(dispatch, dict) else None,
        )

    @mcp.tool(
        name="Shortcut",
        description='Executes keyboard shortcuts using key combinations separated by +. Examples: "ctrl+c" (copy), "ctrl+v" (paste), "alt+tab" (switch apps), "win+r" (Run dialog), "win" (Start menu), "ctrl+shift+esc" (Task Manager). Use for quick actions and system commands.',
        annotations=ToolAnnotations(
            title="Shortcut",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Shortcut-Tool")
    def shortcut_tool(shortcut: str, ctx: Context = None):
        desktop = get_desktop()
        desktop.shortcut(shortcut)
        return _project_input_action(
            desktop,
            f"Pressed {shortcut}.",
            action_name="shortcut",
            execution_channel="send_keys",
        )

    @mcp.tool(
        name="Wait",
        description="Pauses execution for specified duration in seconds. Use when waiting for: applications to launch/load, UI animations to complete, page content to render, dialogs to appear, or between rapid actions. Helps ensure UI is ready before next interaction.",
        annotations=ToolAnnotations(
            title="Wait",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Wait-Tool")
    def wait_tool(duration: int, ctx: Context = None) -> str:
        time.sleep(duration)
        return f"Waited for {duration} seconds."

    @mcp.tool(
        name="WaitFor",
        description=(
            "Waits until a UI condition is satisfied. Polls the Windows accessibility "
            "tree inside the tool (event-woken when the desktop event stream is live, "
            "with bounded reconciliation polling as fallback) to avoid repeated Snapshot "
            "calls. Conditions: text_exists, active_window, element_exists, "
            "element_enabled, focused_element. Provide text and/or window_name depending "
            "on the condition. Set use_dom=True for browser DOM text."
        ),
        annotations=ToolAnnotations(
            title="WaitFor",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "WaitFor-Tool")
    def wait_for_tool(
        condition: str,
        text: str | None = None,
        window_name: str | None = None,
        timeout: float = 10.0,
        interval: float = 0.25,
        use_dom: bool | str = False,
        ctx: Context = None,
    ) -> str:
        normalized = _validate_wait_for_args(
            condition=condition,
            text=text,
            window_name=window_name,
            timeout=timeout,
            interval=interval,
        )
        desktop = get_desktop()
        use_dom_bool = _as_bool(use_dom, "use_dom")
        started_at = time.monotonic()
        deadline = started_at + timeout
        attempts = 0
        last_detail = "condition was not evaluated"
        # Event wake-up (WCC-P1-05): the desktop exposes a wait callable backed
        # by the EventBroker; when absent (or on any wake failure) the loop
        # falls back to the interval sleep, so correctness never depends on
        # the event stream.
        wait_for_change = getattr(desktop, "wait_for_ui_change", None)
        wait_usable = callable(wait_for_change)

        def _sleep_until_wake(remaining: float) -> None:
            nonlocal wait_usable
            if not wait_usable:
                time.sleep(min(interval, remaining))
                return
            try:
                woken = wait_for_change(min(remaining, interval))
            except Exception:
                wait_usable = False
                time.sleep(min(interval, remaining))
                return
            if not woken:
                time.sleep(min(0.05, remaining))

        frame_digest: str | None = None
        while True:
            attempts += 1
            if normalized == "frame_changed":
                matched = False
                probe = getattr(desktop, "frame_digest_for_window", None)
                if callable(probe):
                    try:
                        digest, frame_status = probe(window_name)
                    except Exception:
                        digest, frame_status = None, "probe_error"
                    if frame_digest is None and digest is not None:
                        frame_digest = digest
                        last_detail = "baseline frame captured; waiting for it to change"
                    elif frame_digest is not None and digest is not None and digest != frame_digest:
                        matched, last_detail = True, "frame content changed (pixel digest differs)"
                    elif digest is None:
                        last_detail = f"frame unavailable for change detection (status={frame_status})"
                    else:
                        last_detail = "frame unchanged since baseline"
                else:
                    last_detail = "frame_changed unsupported by this desktop backend"
                if matched:
                    elapsed = time.monotonic() - started_at
                    return (
                        f"WaitFor condition '{normalized}' satisfied after "
                        f"{elapsed:.2f}s and {attempts} attempt(s): {last_detail}."
                    )
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"Timed out after {timeout:.2f}s waiting for '{normalized}': {last_detail}."
                    )
                _sleep_until_wake(remaining)
                continue
            else:
                live_query = getattr(desktop, "query_element_condition", None)
            if normalized in {
                "element_exists",
                "element_enabled",
                "focused_element",
            } and callable(live_query):
                matched, last_detail = live_query(
                    text,
                    window_name,
                    require_enabled=normalized == "element_enabled",
                    require_focused=normalized == "focused_element",
                )
            else:
                try:
                    desktop_state = desktop.get_state(
                        use_vision=False,
                        use_dom=use_dom_bool,
                        use_ui_tree=True,
                        use_annotation=False,
                        publish_state=False,
                    )
                except TypeError as exc:
                    # Test doubles and third-party Desktop adapters predating
                    # publish_state retain compatibility. Production Desktop
                    # always takes the non-publishing branch above.
                    if "publish_state" not in str(exc):
                        raise
                    desktop_state = desktop.get_state(
                        use_vision=False,
                        use_dom=use_dom_bool,
                        use_ui_tree=True,
                        use_annotation=False,
                    )
                matched, last_detail = _matches_wait_condition(
                    desktop_state=desktop_state,
                    condition=normalized,
                    text=text,
                    window_name=window_name,
                )
            if matched:
                elapsed = time.monotonic() - started_at
                return (
                    f"WaitFor condition '{normalized}' satisfied after "
                    f"{elapsed:.2f}s and {attempts} attempt(s): {last_detail}."
                )

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"Timed out after {timeout:.2f}s waiting for '{normalized}': {last_detail}."
                )
            _sleep_until_wake(remaining)
