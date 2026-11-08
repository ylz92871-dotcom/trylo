"""MultiSelect and MultiEdit tools — batch element interaction."""

import json
from typing import Literal

from mcp.types import ToolAnnotations
from windows_mcp.infrastructure import with_analytics
from windows_mcp.tools._action_helpers import project_dispatched_action
from windows_mcp.tools.input import (
    _as_bool,
    _as_point,
    _convert_loc,
    _parse_expected_postconditions,
    _postcondition_unconfirmed_note,
    _validate_label_id,
)
from windows_mcp.runtime.target_resolver import ResolvedTarget
from fastmcp import Context


def _as_loc(value: list | str | None) -> list | None:
    """Coerce a JSON-stringified list back to a list (Claude Desktop workaround)."""
    if value is None or isinstance(value, list):
        return value
    return json.loads(value)


def register(mcp, *, get_desktop, get_analytics):
    @mcp.tool(
        name="MultiSelect",
        description="Selects multiple items such as files, folders, or checkboxes if press_ctrl=True, or performs multiple clicks if False. Pass locs (list of coordinates) or labels (list of UI element labels/ids). When both are given, locs win (labels are ignored). Bind the batch to one fresh snapshot_id; all targets must still resolve uniquely in one window. Bind the batch to one exact window by copying a Window Receipt verbatim from the last Snapshot into window_receipt; the server refuses the batch when the receipt no longer matches the resolved window. coordinate_space='screenshot' maps through that Snapshot's FrameRef. The whole batch consumes the snapshot. expected_postconditions (v1: parameterless predicate names only — 'frame_changed', 'element_exists', 'element_gone') verifies a change at the batch anchor after the batch; the result confirms only when EVERY predicate is satisfied.",
        annotations=ToolAnnotations(
            title="MultiSelect",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Multi-Select-Tool")
    def multi_select_tool(
        locs: list[list[int]] | str | None = None,
        labels: list[int] | str | None = None,
        press_ctrl: bool | str = True,
        coordinate_space: Literal["screen", "screenshot"] = "screen",
        snapshot_id: str | None = None,
        window_receipt: dict | None = None,
        expected_postconditions: list[str] | str | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        locs = _as_loc(locs)
        labels = _as_loc(labels)
        if locs is None and labels is None:
            raise ValueError("Either locs or labels must be provided.")
        locs = locs or []
        press_ctrl = _as_bool(press_ctrl, "press_ctrl")
        postconditions = _parse_expected_postconditions(expected_postconditions)
        effective_snapshot_id = snapshot_id
        if locs:
            if not all(isinstance(loc, (list, tuple)) and len(loc) == 2 for loc in locs):
                raise ValueError("locs must be a list of [x, y] coordinate pairs")
            locs = [_as_point(list(loc), f"locs[{index}]") for index, loc in enumerate(locs)]
        elif labels is not None:
            if not isinstance(labels, list):
                raise ValueError("labels must be a list of non-negative integers")
            labels = [_validate_label_id(label, f"labels[{index}]") for index, label in enumerate(labels)]

        dispatcher = getattr(desktop, "dispatch_multi_select_targets", None)
        dispatched = (
            dispatcher(
                locs=locs or None,
                labels=labels if not locs else None,
                snapshot_id=snapshot_id,
                coordinate_space=coordinate_space,
                press_ctrl=press_ctrl,
                **({"window_receipt": window_receipt} if window_receipt is not None else {}),
                **(
                    {"expected_postconditions": postconditions}
                    if postconditions is not None
                    else {}
                ),
            )
            if callable(dispatcher)
            else None
        )
        batch_target = None
        if isinstance(dispatched, dict) and isinstance(dispatched.get("locs"), list):
            locs = dispatched["locs"]
            effective_snapshot_id = dispatched.get("snapshot_id")
            resolved_batch = dispatched.get("resolved_targets")
            if isinstance(resolved_batch, list) and resolved_batch:
                batch_target = resolved_batch[0]
        elif locs:
            resolver = getattr(desktop, "resolve_action_points", None)
            resolved = (
                resolver(
                    locs=locs,
                    snapshot_id=snapshot_id,
                    coordinate_space=coordinate_space,
                )
                if callable(resolver)
                else None
            )
            if isinstance(resolved, list) and all(
                isinstance(item, ResolvedTarget) for item in resolved
            ):
                locs = [list(item.screen_point) for item in resolved]
                if resolved:
                    effective_snapshot_id = resolved[0].receipt.snapshot_id
            else:
                locs = [
                    _convert_loc(desktop, loc, coordinate_space, snapshot_id)
                    for loc in locs
                ]
            desktop.multi_select(press_ctrl, locs)
        else:
            try:
                resolver = getattr(desktop, "resolve_action_points", None)
                resolved = (
                    resolver(labels=labels, snapshot_id=snapshot_id)
                    if callable(resolver)
                    else None
                )
                if isinstance(resolved, list) and all(
                    isinstance(item, ResolvedTarget) for item in resolved
                ):
                    resolved_locs = [item.screen_point for item in resolved]
                    if resolved:
                        effective_snapshot_id = resolved[0].receipt.snapshot_id
                else:
                    resolved_locs = (
                        [
                            desktop.get_coordinates_from_snapshot_ref(
                                snapshot_id, label=label
                            )
                            for label in labels
                        ]
                        if snapshot_id
                        else desktop.get_coordinates_from_labels(labels)
                    )
                locs.extend([list(loc) for loc in resolved_locs])
            except Exception as e:
                raise ValueError(f"Failed to resolve labels {labels}: {e}")
            desktop.multi_select(press_ctrl, locs)
        elements_str = "\n".join([f"({loc[0]},{loc[1]})" for loc in locs])
        batch_receipt = getattr(batch_target, "receipt", None)
        message = f"Multi-selected elements at:\n{elements_str}"
        verification = (
            dispatched.get("verification") if isinstance(dispatched, dict) else None
        )
        message += _postcondition_unconfirmed_note(dispatched)
        return project_dispatched_action(
            desktop,
            message,
            target_kind="screen_points",
            target_description=f"{len(locs)} screen point(s)",
            execution_channel="send_input",
            snapshot_id=effective_snapshot_id,
            window_handle=batch_receipt.window_handle if batch_receipt else None,
            process_id=batch_receipt.process_id if batch_receipt else None,
            verification=verification,
            pre_revision=dispatched.get("pre_revision", 0) if isinstance(dispatched, dict) else 0,
            post_revision=dispatched.get("post_revision") if isinstance(dispatched, dict) else None,
            takeover=dispatched.get("takeover") if isinstance(dispatched, dict) else None,
        )

    @mcp.tool(
        name="MultiEdit",
        description="Enters text into multiple input fields at specified coordinates locs=[[x,y,text], ...] or labels=[[label,text], ...]. Provide locs or labels; when both are given, locs win. Bind the batch to one fresh snapshot_id; all fields must resolve uniquely in one window. Bind the batch to one exact window by copying a Window Receipt verbatim from the last Snapshot into window_receipt; the server refuses the batch when the receipt no longer matches the resolved window. coordinate_space='screenshot' maps through that Snapshot's FrameRef. The whole batch consumes the snapshot, and typed text is never echoed in the result.",
        annotations=ToolAnnotations(
            title="MultiEdit",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Multi-Edit-Tool")
    def multi_edit_tool(
        locs: list[list] | str | None = None,
        labels: list[list] | str | None = None,
        coordinate_space: Literal["screen", "screenshot"] = "screen",
        snapshot_id: str | None = None,
        window_receipt: dict | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        locs = _as_loc(locs)
        labels = _as_loc(labels)
        if locs is None and labels is None:
            raise ValueError("Either locs or labels must be provided.")
        locs = locs or []
        effective_snapshot_id = snapshot_id
        if locs:
            normalized_locs = []
            for index, item in enumerate(locs):
                if not isinstance(item, (list, tuple)) or len(item) != 3:
                    raise ValueError(f"Each locs item must be [x, y, text]. Invalid: {item}")
                x, y, text = item
                point = _as_point([x, y], f"locs[{index}]")
                normalized_locs.append([point[0], point[1], text])
            locs = normalized_locs
        elif labels is not None:
            if not isinstance(labels, list):
                raise ValueError("labels must be a list of [label, text] pairs")
            processed_labels = []
            for item in labels:
                if not isinstance(item, (list, tuple)) or len(item) != 2:
                    raise ValueError(f"Each label item must be [label, text]. Invalid: {item}")
                try:
                    processed_labels.append(
                        [_validate_label_id(item[0], "label"), item[1]]
                    )
                except (ValueError, TypeError):
                    raise ValueError(f"Invalid label id in item: {item}")
            labels = processed_labels

        dispatcher = getattr(desktop, "dispatch_multi_edit_targets", None)
        dispatched = (
            dispatcher(
                locs=locs or None,
                labels=labels if not locs else None,
                snapshot_id=snapshot_id,
                coordinate_space=coordinate_space,
                **({"window_receipt": window_receipt} if window_receipt is not None else {}),
            )
            if callable(dispatcher)
            else None
        )
        edit_target = None
        if isinstance(dispatched, dict) and isinstance(dispatched.get("locs"), list):
            locs = dispatched["locs"]
            effective_snapshot_id = dispatched.get("snapshot_id")
            edit_resolved = dispatched.get("resolved_targets")
            edit_target = (
                edit_resolved[0]
                if isinstance(edit_resolved, list) and edit_resolved
                else None
            )
        elif locs:
            raw_points = [[item[0], item[1]] for item in locs]
            resolver = getattr(desktop, "resolve_action_points", None)
            resolved = (
                resolver(
                    locs=raw_points,
                    snapshot_id=snapshot_id,
                    coordinate_space=coordinate_space,
                )
                if callable(resolver)
                else None
            )
            if isinstance(resolved, list) and all(
                isinstance(item, ResolvedTarget) for item in resolved
            ):
                locs = [
                    [target.screen_point[0], target.screen_point[1], item[2]]
                    for target, item in zip(resolved, locs)
                ]
                if resolved:
                    effective_snapshot_id = resolved[0].receipt.snapshot_id
            else:
                converted_locs = []
                for x, y, text in locs:
                    sx, sy = _convert_loc(
                        desktop, [x, y], coordinate_space, snapshot_id
                    )
                    converted_locs.append([sx, sy, text])
                locs = converted_locs
            desktop.multi_edit(locs)
        else:
            try:
                processed_labels = labels or []
                label_ids = [item[0] for item in processed_labels]
                resolver = getattr(desktop, "resolve_action_points", None)
                resolved = (
                    resolver(labels=label_ids, snapshot_id=snapshot_id)
                    if callable(resolver)
                    else None
                )
                if isinstance(resolved, list) and all(
                    isinstance(item, ResolvedTarget) for item in resolved
                ):
                    resolved_coords = [item.screen_point for item in resolved]
                    if resolved:
                        effective_snapshot_id = resolved[0].receipt.snapshot_id
                else:
                    resolved_coords = (
                        [
                            desktop.get_coordinates_from_snapshot_ref(
                                snapshot_id, label=label
                            )
                            for label in label_ids
                        ]
                        if snapshot_id
                        else desktop.get_coordinates_from_labels(label_ids)
                    )
                for (x, y), (_, text) in zip(resolved_coords, processed_labels):
                    locs.append([x, y, text])
            except Exception as e:
                raise ValueError(f"Failed to process labels: {e}")
            desktop.multi_edit(locs)
        # Do not echo text payloads into MCP transcripts or the ActionResult
        # journal.  Coordinates are sufficient to identify the dispatched work.
        elements_str = ", ".join([f"({e[0]},{e[1]})" for e in locs])
        edit_receipt = getattr(edit_target, "receipt", None)
        return project_dispatched_action(
            desktop,
            f"Multi-edited {len(locs)} element(s) at: {elements_str}",
            target_kind="screen_points",
            target_description=f"{len(locs)} editable screen point(s)",
            execution_channel="send_keys_or_clipboard",
            snapshot_id=effective_snapshot_id,
            window_handle=edit_receipt.window_handle if edit_receipt else None,
            process_id=edit_receipt.process_id if edit_receipt else None,
            takeover=dispatched.get("takeover") if isinstance(dispatched, dict) else None,
        )
