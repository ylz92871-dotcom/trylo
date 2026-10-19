from windows_mcp.desktop.utils import (
    resolve_known_folder_guid_path,
)
from windows_mcp.powershell.utils import ps_quote
from windows_mcp.powershell import PowerShellExecutor
from windows_mcp.vdm.core import (
    get_all_desktops,
    get_current_desktop,
    is_window_on_current_desktop,
)
from windows_mcp.desktop.views import DesktopState, Window, Browser, Status, Size, Display
from windows_mcp.tree.views import BoundingBox, TreeElementNode, TreeState, SemanticNode
from PIL import ImageFont, ImageDraw, Image
from windows_mcp.tree.service import Tree
from windows_mcp.desktop import screenshot as screenshot_capture
from windows_mcp.desktop import flash_overlay
from windows_mcp.desktop import control_overlay
from windows_mcp.desktop.ocr_backend import (
    OcrBackend,
    WindowsOcrPowerShellBackend,
)
from windows_mcp.runtime.clock import SystemClock
from windows_mcp.runtime.action_router import ActionRouter
from windows_mcp.runtime.backends import BackendOutcome, UiaPatternBackend
from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.identity import IdentityFactory, ReacquireLocator, WindowRef
from windows_mcp.runtime.generation_registry import GenerationRegistry
from windows_mcp.runtime.observation_builder import build_observation_receipt
from windows_mcp.runtime.observations import Rect
from windows_mcp.runtime.results import ActionResult, DispatchStatus, EffectStatus, VerificationEvidence
from windows_mcp.runtime.metrics import METRICS
from windows_mcp.runtime.predicates import PredicateOperator
from windows_mcp.runtime.snapshot_store import SnapshotStore
from windows_mcp.runtime.target_resolver import (
    LiveElementCandidate,
    ResolvedTarget,
    TargetResolutionError,
    TargetResolver,
)
from windows_mcp.capture import CaptureService
from windows_mcp.runtime.verifier import BrokerWakeSource, PostconditionVerifier
from windows_mcp.runtime.takeover import (
    TakeoverDetector,
    TakeoverState,
    TryloTakeoverGuard,
)
from windows_mcp.runtime.user_input_hook import UserInputHookWatcher
from windows_mcp.infrastructure import validate_url
from urllib.parse import urljoin
from locale import getpreferredencoding
from typing import Callable, Literal
from markdownify import markdownify
from fuzzywuzzy import fuzz, process
from time import sleep, time, perf_counter, monotonic
from psutil import Process
import math
import win32process
import win32gui
import win32con
import requests
import logging
import random
import ctypes
import csv
import re
import os
import io
from collections import deque
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

import windows_mcp.uia as uia  # noqa: E402

# Key name aliases for shortcut keys that differ from UIA SpecialKeyNames
_KEY_ALIASES = {
    "backspace": "Back",
    "capslock": "Capital",
    "scrolllock": "Scroll",
    "windows": "Win",
    "command": "Win",
    "option": "Alt",
}


def _snapshot_profile_enabled() -> bool:
    value = os.getenv("WINDOWS_MCP_PROFILE_SNAPSHOT", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _run_with_timeout(fn, timeout_sec=5.0):
    """Run *fn* in a worker thread with a hard timeout.

    Returns the result of *fn()*, or raises ``TimeoutError`` if the thread
    does not finish within *timeout_sec* seconds.  This is used to guard
    against UIA COM calls that can hang indefinitely when a target process
    is unresponsive.
    """
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn)
        try:
            return future.result(timeout=timeout_sec)
        except FuturesTimeoutError:
            raise TimeoutError(f"UIA call did not complete within {timeout_sec}s")


def _escape_text_for_sendkeys(text: str) -> str:
    """Escape special characters so uia.SendKeys types them correctly."""
    result = []
    for ch in text:
        if ch == "{":
            result.append("{{}")
        elif ch == "}":
            result.append("{}}")
        elif ch == "\n":
            result.append("{Enter}")
        elif ch == "\t":
            result.append("{Tab}")
        elif ch == "\r":
            continue
        else:
            result.append(ch)
    return "".join(result)


def _start_user_input_hook_watcher() -> UserInputHookWatcher | None:
    """Start the LL-hook takeover watcher, or return None when disabled.

    ``WINDOWS_MCP_DISABLE_INPUT_HOOK=1`` (the test suite sets it in
    conftest) skips real system-wide hook installation entirely. Any other
    failure inside start() is swallowed into None: the takeover guard then
    keeps the tick heuristic — the watcher is an upgrade, never a
    dependency.
    """
    import os

    if os.getenv("WINDOWS_MCP_DISABLE_INPUT_HOOK", "").strip() == "1":
        return None
    try:
        watcher = UserInputHookWatcher()
        watcher.start()
        return watcher
    except Exception:
        return None


class Desktop:
    def __init__(self):
        self.encoding = getpreferredencoding()
        self.tree = Tree(self)
        self.desktop_state = None
        self._runtime_clock = SystemClock()
        self._identity_factory = IdentityFactory()
        self._producer_generation = 1
        self._producer_id = self._identity_factory.new_id("producer")
        self._observation_revision = 0
        self._generation_registry = GenerationRegistry(
            producer_generation=self._producer_generation
        )
        self.snapshot_store = SnapshotStore(clock=self._runtime_clock)
        self._latest_snapshot_id: str | None = None
        self._target_resolver = TargetResolver(
            snapshots=self.snapshot_store,
            generations=self._generation_registry,
            backend=self,
            current_desktop_session=self.current_desktop_session_id,
        )
        self._uia_pattern_backend = UiaPatternBackend(
            self._reacquire_uia_control_for_target
        )
        self._action_router = ActionRouter(patterns=self._uia_pattern_backend)
        # Broker-fed wake source: verification waits on desktop events when
        # the EventBroker streams, and falls back to bounded reconciliation
        # polling whenever the stream is absent, gapped, or retired.
        self._wake_source = BrokerWakeSource()
        self._capture_service = CaptureService()
        self._verifier = PostconditionVerifier(
            self._uia_pattern_backend.read_state,
            clock=self._runtime_clock,
            wake_source=self._wake_source,
            verifier_name="scoped_uia_event_poll",
            frame_reader=self._frame_evidence,
        )
        self._action_results: deque[ActionResult] = deque(maxlen=32)
        self._held_mouse_buttons: set[str] = set()
        self._held_modifier_keys: set[int] = set()
        # §11.3 用户接管 (DoD-7): the takeover state machine. One guard per
        # Desktop actor service; every mutation dispatch runs inside
        # `_mutation_takeover()` so a real user input during AGENT_PREPARING
        # cancels the action, during AGENT_DISPATCHING forces
        # SAFE_RELEASE → YIELDED, and during VERIFYING withdraws the right
        # to mutate while read-only verification finishes.
        self._takeover_guard = TryloTakeoverGuard()
        self._takeover_terminal: TakeoverState | None = None
        # WCC 精确接管检测 (spec §11.3): the LL-hook watcher upgrades the
        # takeover detector from the GetLastInputInfo tick heuristic (which
        # needs an own-dispatch compensation margin) to hard dwExtraInfo
        # evidence. start() never throws and a failed install leaves the
        # guard on the tick heuristic — fail-open. The watcher records
        # primitives only; the state machine consumes it through the
        # detector (P2-04: the machine itself stays pure).
        self._user_input_hook = _start_user_input_hook_watcher()
        if self._user_input_hook is not None:
            self._takeover_guard = TryloTakeoverGuard(
                TakeoverDetector(user_input_hook=self._user_input_hook)
            )

    def record_action_result(self, result: ActionResult) -> None:
        """Keep a bounded diagnostic journal owned by the Desktop actor."""
        results = getattr(self, "_action_results", None)
        if results is None:
            results = deque(maxlen=32)
            self._action_results = results
        results.append(result)
        # §18.3 journal classification: every mutation result feeds the
        # counters here — confirmed-success rate (v1 mutation granularity)
        # and unknown-outcome volume. Pure counter math; cannot alter the
        # result contract (§7.5).
        METRICS.inc("mutation_total")
        if result.effect is EffectStatus.UNKNOWN_OUTCOME:
            METRICS.inc("unknown_outcome_count")
        elif result.effect is EffectStatus.CONFIRMED_SUCCESS:
            METRICS.inc("mutation_confirmed_success_total")

    def last_action_result(self) -> ActionResult | None:
        results = getattr(self, "_action_results", None)
        return results[-1] if results else None

    # ── §11.3 用户接管: mutation dispatch window ─────────────────────────

    def takeover_state(self) -> str:
        """Diagnostics view of the takeover state machine."""
        guard = getattr(self, "_takeover_guard", None)
        return guard.state.value if guard is not None else TakeoverState.IDLE.value

    def _mutation_takeover(self, dispatch: Callable[[], dict[str, object]], *,
                           feedback_click: bool = False) -> dict[str, object]:
        # A refused operation must not light up as an agent action.
        if getattr(self, "_takeover_terminal", None) is not None:
            return self._mutation_takeover_inner(dispatch)
        activity = control_overlay.begin()
        try:
            result = self._mutation_takeover_inner(dispatch)
        except BaseException:
            control_overlay.finish(activity)
            raise
        control_overlay.finish(activity, result, click=feedback_click)
        return result

    def _mutation_takeover_inner(self, dispatch: Callable[[], dict[str, object]]) -> dict[str, object]:
        """Run one mutation inside the §11.3 takeover window.

        Phase mapping:
          enter (IDLE → AGENT_PREPARING)  before resolve/plan work;
          arm   (→ AGENT_DISPATCHING)     immediately before the injection;
          check after the injection: a real user input flips to SAFE_RELEASE
                (caller releases held buttons/keys, then YIELDED);
          verify(→ VERIFYING)             the read-only postcondition window;
          exit  (→ IDLE)                  when no takeover fired.

        WCC-P2-04 host wiring (consume-on-arrival): a takeover terminal is
        CONSUMED BY THE NEXT MUTATION — the next dispatch refuses once with
        ``CANCELLED_BY_USER_INPUT`` and then automatically re-arms. The
        refusal carries the takeover fact to the model exactly once (the
        model learns WHY it was refused and asks the user to resume), while
        the host's per-call approval gate stays the hard authority: every
        subsequent desktop call in this conversation is a forced approval
        until the rearm flag the host derives from the fact expires (TTL).
        A permanent lockout would only force the model into a blind retry
        loop it can never win (§19.7 never-retry discipline); a single honest
        refusal + forced approvals achieve the same human-in-control outcome
        without the deadlock.
        """
        guard = getattr(self, "_takeover_guard", None)
        if guard is None:
            return dispatch()
        # Consume-on-arrival: a terminal from a PREVIOUS window refuses this
        # call once, annotates the refusal, then re-arms the machine.
        terminal = getattr(self, "_takeover_terminal", None)
        if terminal is not None:
            self.takeover_rearm()
            raise TargetResolutionError(
                ErrorCode.CANCELLED_BY_USER_INPUT,
                f"user takeover ({terminal.value}) during the previous action; "
                "ask the user to resume — the next desktop action requires "
                "fresh approval",
            )
        guard.guard_enter_dispatch()
        dispatch_started = monotonic()
        try:
            guard.guard_arm_dispatch()
            result = dispatch()
            if guard.guard_takeover_check() is not None:
                self._takeover_terminal = guard.guard_yield_release_done()
                self.safe_release_input()
                self._annotate_takeover(result, self._takeover_terminal)
                # §18.3 user_takeover_latency_ms: dispatch anchor → YIELDED
                # (release done, control fully back with the user).
                METRICS.observe_ms(
                    "user_takeover_latency_ms", (monotonic() - dispatch_started) * 1000.0
                )
                return result
            guard.guard_enter_verification()
            if guard.guard_takeover_check() is not None:
                self._takeover_terminal = TakeoverState.VERIFYING
                self._annotate_takeover(result, TakeoverState.VERIFYING)
                guard.guard_exit()
                return result
            guard.guard_exit()
            METRICS.observe_ms("action_ms", (monotonic() - dispatch_started) * 1000.0)
            return result
        except BaseException:
            # A failing mutation still leaves the machine consistent; the
            # dispatch never happened or its failure is reported by the tool
            # layer. An existing terminal (if any) stays armed until the
            # next call consumes it.
            guard.guard_exit()
            raise

    def _mutation_takeover_check_terminal(self) -> None:
        """The consume-on-arrival check shared by ``_refuse_if_takeover``
        (pre-dispatch) — refuses once, then re-arms the machine."""
        terminal = getattr(self, "_takeover_terminal", None)
        if terminal is None:
            return
        self.takeover_rearm()
        raise TargetResolutionError(
            ErrorCode.CANCELLED_BY_USER_INPUT,
            f"user takeover ({terminal.value}) during the previous action; "
            "ask the user to resume — the next desktop action requires "
            "fresh approval",
        )

    @staticmethod
    def _annotate_takeover(result: dict[str, object], state: TakeoverState) -> None:
        """Stamp the takeover fact onto a dispatch result (identity only —
        no user content)."""
        result["takeover"] = state.value

    def takeover_rearm(self) -> str:
        """Open the next dispatch window after a user takeover. The server
        calls this itself when the NEXT mutation consumes the terminal
        (consume-on-arrival); a host-side call after an explicit approval
        has the same effect."""
        guard = getattr(self, "_takeover_guard", None)
        self._takeover_terminal = None
        if guard is not None:
            guard.guard_reset()
        return TakeoverState.IDLE.value

    def _refuse_if_takeover(self) -> None:
        """Consume-on-arrival refusal: a terminal from a previous window
        refuses THIS call once (the model learns why), then re-arms."""
        self._mutation_takeover_check_terminal()

    def safe_release_input(self) -> None:
        """Release only buttons/keys that this Desktop instance left held."""
        releases = {
            "left": uia.ReleaseMouse,
            "right": uia.RightReleaseMouse,
            "middle": uia.MiddleReleaseMouse,
        }
        held_buttons = getattr(self, "_held_mouse_buttons", set())
        for button in tuple(held_buttons):
            try:
                releases[button](0.0)
            finally:
                held_buttons.discard(button)
        held_keys = getattr(self, "_held_modifier_keys", set())
        for vk in tuple(held_keys):
            try:
                uia.ReleaseKey(vk, waitTime=0.0)
            finally:
                held_keys.discard(vk)

    def note_focus_change(
        self,
        runtime_id: tuple[int, ...] | None,
        name: str | None,
    ) -> None:
        """Receive a primitive-only hint from the separate watchdog STA."""
        self._last_focus_hint = (runtime_id, name, perf_counter())
        logger.debug("[WatchDog] Focus changed to: %r (%r)", name, runtime_id)

    def capture_exact_window_frame(
        self,
        hwnd: int | None = None,
        window_name: str | None = None,
    ) -> dict[str, object]:
        """Capture one exact-window frame (flag-gated provider selection).

        Returns a DTO: ``frame`` (FrameRef dict or None), ``outcome``
        (captured/idle/unavailable), ``png_bytes`` (client-area PNG when a
        frame was captured), and the window identity. No frame bytes are
        written to logs or the ActionResult journal.
        """
        resolved_hwnd = hwnd
        title = None
        if resolved_hwnd is None and window_name:
            window, _error = self._find_window_by_name(window_name, refresh_state=False)
            if window is None:
                return {"frame": None, "outcome": "unavailable", "png_bytes": None, "window_title": None}
            resolved_hwnd = int(window.handle)
            title = window.name
        elif resolved_hwnd is None:
            import win32gui

            resolved_hwnd = int(win32gui.GetForegroundWindow() or 0) or None
            if resolved_hwnd:
                try:
                    title = win32gui.GetWindowText(resolved_hwnd) or None
                except Exception:
                    title = None
        if not resolved_hwnd:
            return {"frame": None, "outcome": "unavailable", "png_bytes": None, "window_title": None}

        ref, outcome = self._capture_service.capture_exact_window(int(resolved_hwnd))
        png = None
        if ref is not None:
            stored = self._capture_service.store.get(ref.frame_id)
            if stored is not None:
                png = stored[1]
        return {
            "frame": ref.to_dict() if ref is not None else None,
            "outcome": outcome,
            "png_bytes": png,
            "window_title": title,
        }

    def _frame_evidence(self, resolved: ResolvedTarget) -> dict[str, object]:
        """Verifier pixel-evidence reader (§6.8): digest of a COMPLETE frame
        captured strictly after dispatch; anything else degrades to None so
        the frame predicate evaluates UNKNOWN instead of confirming."""
        handle = resolved.receipt.window_handle if resolved is not None else None
        if not handle:
            return {"frame_digest": None, "frame_status": "no_window"}
        try:
            ref, outcome = self._capture_service.capture_exact_window(int(handle))
        except Exception:
            return {"frame_digest": None, "frame_status": "capture_error"}
        if ref is None or ref.status != "complete":
            return {"frame_digest": None, "frame_status": outcome or "incomplete"}
        stored = self._capture_service.store.get(ref.frame_id)
        png = stored[1] if stored is not None else None
        if not png:
            return {"frame_digest": None, "frame_status": "incomplete"}
        import hashlib

        return {"frame_digest": hashlib.sha256(png).hexdigest(), "frame_status": ref.status}

    def frame_digest_for_window(self, window_name: str | None = None) -> tuple[str | None, str]:
        """WaitFor's ``frame_changed`` live probe: (digest, status)."""
        resolved = self.capture_exact_window_frame(None, window_name)
        frame = resolved.get("frame")
        png = resolved.get("png_bytes")
        if not frame or frame.get("status") != "complete" or not png:
            return None, str(resolved.get("outcome") or "unavailable")
        import hashlib

        return hashlib.sha256(png).hexdigest(), "complete"

    def wait_for_ui_change(self, timeout: float) -> bool:
        """Block until a desktop event arrives or *timeout* elapses.

        WaitFor's sleep replacement (WCC-P1-05). Backed by the broker-fed
        wake source; returns False when no event fired, which callers treat
        as a reconciliation tick — never as proof that nothing changed.
        The wait is unscoped (any event wakes) and disarms the source behind
        itself, so a leftover verification wake cannot short-circuit it.
        """
        source = getattr(self, "_wake_source", None)
        if source is None:
            return False
        try:
            woken = bool(source.wait(max(0.0, float(timeout))))
            if woken:
                source.unsubscribe()
            return woken
        except Exception:
            return False

    def feed_desktop_event(
        self,
        window_handle: int | None,
        kind: str,
        changed_properties: tuple[str, ...] = (),
    ) -> None:
        """Deliver one broker event into the wake source.

        Called by the supervisor pump thread (or tests). Primitive-only: no
        COM object may cross this boundary.
        """
        if kind == "foreground_changed":
            # §18.3 focus_theft_count: the shell-level "another window took
            # the foreground" fact (winevent source). Counted server-side at
            # consumption so broker crashes/restarts cannot lose the count.
            # Semantic limit (2026-10 audit): WinEvent carries no causality,
            # so this counts ALL foreground switches — including the agent's
            # own focus_window/bring_to_top. Treat as foreground-competition
            # volume; matrix-period host correlation separates agent-caused
            # switches (lease revocation itself is digest-based, not
            # event-driven, and is unaffected).
            METRICS.inc("focus_theft_count")
        source = getattr(self, "_wake_source", None)
        if source is None:
            return
        try:
            source.feed(window_handle, kind, changed_properties)
        except Exception:
            logger.debug("dropping malformed desktop event", exc_info=True)

    def create_observation_receipt(self, desktop_state: DesktopState, ttl_seconds: float = 30.0):
        """Create and store a V2 receipt for an already-captured state."""
        self._observation_revision += 1
        receipt, labels = build_observation_receipt(
            desktop_state,
            identity_factory=self._identity_factory,
            producer_id=self._producer_id,
            producer_generation=self._producer_generation,
            revision=self._observation_revision,
            ttl_seconds=ttl_seconds,
            clock=self._runtime_clock,
            generation_registry=self._generation_registry,
        )
        self.snapshot_store.put(receipt, labels)
        self._latest_snapshot_id = receipt.snapshot_id
        return receipt

    def get_state(
        self,
        use_annotation: bool | str = True,
        use_vision: bool | str = False,
        use_dom: bool | str = False,
        use_ui_tree: bool | str = True,
        as_bytes: bool | str = False,
        scale: float = 1.0,
        grid_lines: tuple[int, int] | None = None,
        display_indices: list[int] | None = None,
        region: list[int] | tuple[int, ...] | None = None,
        max_image_size: Size | None = None,
        publish_state: bool = True,
    ) -> DesktopState:
        use_annotation = use_annotation is True or (
            isinstance(use_annotation, str) and use_annotation.lower() == "true"
        )
        use_vision = use_vision is True or (
            isinstance(use_vision, str) and use_vision.lower() == "true"
        )
        use_dom = use_dom is True or (isinstance(use_dom, str) and use_dom.lower() == "true")
        use_ui_tree = use_ui_tree is True or (
            isinstance(use_ui_tree, str) and use_ui_tree.lower() == "true"
        )
        as_bytes = as_bytes is True or (isinstance(as_bytes, str) and as_bytes.lower() == "true")

        if use_dom and not use_ui_tree:
            raise ValueError("use_dom=True requires use_ui_tree=True")

        # §18.3 observe_ms: full observation-build duration, entry to exit.
        # Covers every get_state caller, including the refresh inside
        # _find_window_by_name — i.e. this is the observation path's total
        # latency histogram, not a Snapshot-tool-only figure.
        observe_started = self._runtime_clock.monotonic()
        start_time = time()
        profile_enabled = _snapshot_profile_enabled()
        profile_started_at = perf_counter()
        stage_started_at = profile_started_at
        desktop_context_ms = 0.0
        tree_capture_ms = 0.0
        region_filter_ms = 0.0
        screenshot_capture_ms = 0.0
        screenshot_resize_ms = 0.0
        state_build_ms = 0.0
        displays = self.get_displays()
        available_displays = [self._display_to_view(display) for display in displays]
        region_rect = self.parse_region_selection(region)
        capture_rect = (
            region_rect
            if region_rect is not None
            else (
                self.get_display_union_rect(display_indices, displays) if display_indices else None
            )
        )
        screenshot_region = self._rect_to_bounding_box(capture_rect) if capture_rect else None

        # Window enumeration is shared by Snapshot and Screenshot so both can
        # report "Focused Window" / "Opened Windows"; the heavy part that
        # Screenshot skips is the UI tree crawl below. Enumeration MUST run on
        # the current thread. The IUIAutomation COM singleton is apartment-
        # affine, and scheduling these UIA/COM calls on a ThreadPoolExecutor
        # worker (an MTA thread) makes every COM interaction fail — a previous
        # "fast path" that wrapped get_windows/get_active_window in a thread
        # timeout always degraded to an empty window list even while a full
        # Snapshot on the main thread listed every window.
        controls_handles = self.get_controls_handles()  # Taskbar, Program Manager, Apps, Dialogs
        windows, windows_handles = self.get_windows(controls_handles=controls_handles)  # Apps
        active_window = self.get_active_window(windows=windows)  # Active Window
        active_window_handle = active_window.handle if active_window else None

        cursor_position = self.get_cursor_location()

        try:
            active_desktop = get_current_desktop()
            all_desktops = get_all_desktops()
        except RuntimeError:
            active_desktop = {
                "id": "00000000-0000-0000-0000-000000000000",
                "name": "Default Desktop",
            }
            all_desktops = [active_desktop]

        if active_window is not None and active_window in windows:
            windows.remove(active_window)

        if profile_enabled:
            desktop_context_ms = (perf_counter() - stage_started_at) * 1000
            stage_started_at = perf_counter()

        logger.debug(f"Active window: {active_window or 'No Active Window Found'}")
        logger.debug(f"Windows: {windows}")

        if use_ui_tree:
            other_windows_handles = set(controls_handles - windows_handles)
            if active_window_handle is not None:
                other_windows_handles.discard(active_window_handle)
            tree_active_window_handle = active_window_handle
            if screenshot_region:
                active_window_in_region = (
                    self._filter_window_to_region(active_window, screenshot_region) is not None
                )
                tree_active_window_handle = (
                    active_window_handle if active_window_in_region else None
                )
                # Scoped capture (live finding, matrix batch 2): crawl ONLY
                # the windows that intersect the region. Everything else is
                # filtered out of the result below anyway — crawling it just
                # burns the capture budget, and on a busy desktop it starves
                # the scoped window of elements entirely.
                other_windows_handles = {
                    window.handle
                    for window in windows
                    if self._filter_window_to_region(window, screenshot_region) is not None
                }
                other_windows_handles.discard(tree_active_window_handle)
            tree_state = self.tree.get_state(
                tree_active_window_handle, list(other_windows_handles), use_dom=use_dom
            )
        else:
            root_box = screenshot_region or self.tree.screen_box
            tree_state = TreeState(
                status=True,
                root_node=TreeElementNode(
                    name="Desktop",
                    control_type="PaneControl",
                    bounding_box=root_box,
                    center=root_box.get_center(),
                    window_name="Desktop",
                    metadata={},
                ),
            )

        if profile_enabled:
            tree_capture_ms = (perf_counter() - stage_started_at) * 1000
            stage_started_at = perf_counter()

        if screenshot_region:
            active_window = self._filter_window_to_region(active_window, screenshot_region)
            windows = self._filter_windows_to_region(windows, screenshot_region)
            if use_ui_tree:
                tree_state = self._filter_tree_state_to_region(tree_state, screenshot_region)
            if cursor_position and not self._point_in_region(cursor_position, screenshot_region):
                cursor_position = None

        if profile_enabled:
            region_filter_ms = (perf_counter() - stage_started_at) * 1000
            stage_started_at = perf_counter()

        screenshot_original_size = None
        applied_scale = None
        if use_vision:
            if use_annotation:
                nodes = tree_state.interactive_nodes
                screenshot = self.get_annotated_screenshot(
                    nodes=nodes,
                    cursor_pos=cursor_position,
                    grid_lines=grid_lines,
                    capture_rect=capture_rect,
                )
            else:
                screenshot = self.get_screenshot(capture_rect=capture_rect)

            screenshot_original_size = Size(width=screenshot.width, height=screenshot.height)

            if profile_enabled:
                screenshot_capture_ms = (perf_counter() - stage_started_at) * 1000
                stage_started_at = perf_counter()

            if max_image_size:
                scale_width = (
                    max_image_size.width / screenshot.width
                    if screenshot.width > max_image_size.width
                    else 1.0
                )
                scale_height = (
                    max_image_size.height / screenshot.height
                    if screenshot.height > max_image_size.height
                    else 1.0
                )
                scale = min(scale, scale_width, scale_height)

            applied_scale = scale
            if scale != 1.0:
                screenshot = screenshot.resize(
                    (int(screenshot.width * scale), int(screenshot.height * scale)),
                    Image.LANCZOS,
                )

            if profile_enabled:
                screenshot_resize_ms = (perf_counter() - stage_started_at) * 1000
                stage_started_at = perf_counter()

            if as_bytes:
                buffered = io.BytesIO()
                screenshot.save(buffered, format="PNG", optimize=True, compress_level=6)
                screenshot = buffered.getvalue()
                buffered.close()
        else:
            screenshot = None

        captured_state = DesktopState(
            active_window=active_window,
            windows=windows,
            active_desktop=active_desktop,
            all_desktops=all_desktops,
            screenshot=screenshot,
            cursor_position=cursor_position,
            screenshot_original_size=screenshot_original_size,
            screenshot_scale=applied_scale,
            screenshot_region=screenshot_region,
            screenshot_displays=display_indices,
            available_displays=available_displays,
            tree_state=tree_state,
            screenshot_backend=getattr(self, "_last_screenshot_backend", None)
            if use_vision
            else None,
            capture_sec=time() - start_time,
        )
        if profile_enabled:
            state_build_ms = (perf_counter() - stage_started_at) * 1000
            total_profile_ms = (perf_counter() - profile_started_at) * 1000
            logger.info(
                "Snapshot profile: desktop_context_ms=%.1f tree_capture_ms=%.1f region_filter_ms=%.1f screenshot_capture_ms=%.1f screenshot_resize_ms=%.1f state_build_ms=%.1f total_ms=%.1f use_vision=%s use_dom=%s use_ui_tree=%s use_annotation=%s displays=%s",
                desktop_context_ms,
                tree_capture_ms,
                region_filter_ms,
                screenshot_capture_ms,
                screenshot_resize_ms,
                state_build_ms,
                total_profile_ms,
                use_vision,
                use_dom,
                use_ui_tree,
                use_annotation,
                display_indices,
            )
        # Log the time taken to capture the state
        end_time = time()
        logger.info(f"Desktop State capture took {end_time - start_time:.2f} seconds")
        METRICS.observe_ms(
            "observe_ms", (self._runtime_clock.monotonic() - observe_started) * 1000.0
        )
        if publish_state:
            self.desktop_state = captured_state
        return captured_state

    def get_window_status(self, control: uia.Control) -> Status:
        if uia.IsIconic(control.NativeWindowHandle):
            return Status.MINIMIZED
        elif uia.IsZoomed(control.NativeWindowHandle):
            return Status.MAXIMIZED
        elif uia.IsWindowVisible(control.NativeWindowHandle):
            return Status.NORMAL
        else:
            return Status.HIDDEN

    def get_cursor_location(self) -> tuple[int, int]:
        return uia.GetCursorPos()

    def image_to_screen(self, x: int, y: int) -> tuple[int, int]:
        """Convert image-pixel coordinates — as measured on the last
        Snapshot/Screenshot image the caller saw — to virtual-desktop screen
        coordinates.

        Uses the last captured desktop state's screenshot region and scale.
        When no screenshot state exists (or vision was disabled), the input is
        returned unchanged, so a caller is never silently mis-converted.
        """
        state = self.desktop_state
        if state is None or state.screenshot_scale is None or state.screenshot_scale <= 0:
            return x, y
        factor = 1.0 / state.screenshot_scale
        region = state.screenshot_region
        left = region.left if region is not None else 0
        top = region.top if region is not None else 0
        return left + int(round(x * factor)), top + int(round(y * factor))

    def image_to_screen_strict(self, x: int, y: int) -> tuple[int, int]:
        """Convert using published state, failing when no mapping exists."""
        state = self.desktop_state
        if state is None or state.screenshot_scale is None:
            raise ValueError(
                "coordinate_space='screenshot' requires a prior Screenshot/Snapshot "
                "with vision enabled (so the image->screen mapping is known)."
            )
        return self.image_to_screen(x, y)

    def click_hit_note(self, x: int, y: int) -> str:
        """Hit-test feedback for a click at screen coordinates (x, y): the
        top-level window under the point and whether it lies inside the
        foreground window's client area. Returns "" when the probe itself
        fails — the click has already happened, feedback must never raise.
        """
        try:
            under_handle = uia.WindowFromPoint(x, y)
            foreground_handle = uia.GetForegroundWindow()
            top_handle = uia.GetAncestor(under_handle, 2) if under_handle else 0  # GA_ROOT
            if not top_handle or not win32gui.IsWindow(top_handle):
                top_handle = under_handle
            under_title = (uia.GetWindowText(top_handle) if top_handle else "").strip()
            fg_title = ""
            fg_rect = None
            if foreground_handle:
                fg_title = (uia.GetWindowText(foreground_handle) or "").strip()
                fg_rect = uia.GetWindowRect(foreground_handle)
            if fg_rect is None or not fg_rect.contains(x, y):
                if fg_title:
                    return (
                        f" WARNING: click point ({x},{y}) is OUTSIDE the foreground "
                        f"window {fg_title!r} client area — the click may have been "
                        f"swallowed. Window under the point: "
                        f"{under_title or 'unknown'}."
                    )
                return (
                    f" WARNING: click point ({x},{y}) is outside any foreground "
                    f"window. Window under the point: {under_title or 'unknown'}."
                )
            return (
                f" Landed on {under_title or 'unknown'} (foreground window: "
                f"{fg_title or 'unknown'})."
            )
        except Exception:
            return ""

    def get_apps_from_start_menu(self) -> dict[str, str]:
        """Get installed apps. Tries Get-StartApps first, falls back to shortcut scanning."""
        command = "Get-StartApps | ConvertTo-Csv -NoTypeInformation"
        apps_info, status = PowerShellExecutor.execute_command(command)

        if status == 0 and apps_info and apps_info.strip():
            try:
                reader = csv.DictReader(io.StringIO(apps_info.strip()))
                apps = {
                    row.get("Name", "").lower(): row.get("AppID", "")
                    for row in reader
                    if row.get("Name") and row.get("AppID")
                }
                if apps:
                    return apps
            except Exception as e:
                logger.warning(f"Error parsing Get-StartApps output: {e}")

        # Fallback: scan Start Menu shortcut folders (works on all Windows versions)
        logger.info("Get-StartApps unavailable, falling back to Start Menu folder scan")
        return self._get_apps_from_shortcuts()

    def _get_apps_from_shortcuts(self) -> dict[str, str]:
        """Scan Start Menu folders for .lnk shortcuts as a fallback for Get-StartApps."""
        import glob

        apps = {}
        start_menu_paths = [
            os.path.join(
                os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
                r"Microsoft\Windows\Start Menu\Programs",
            ),
            os.path.join(
                os.environ.get("APPDATA", ""),
                r"Microsoft\Windows\Start Menu\Programs",
            ),
        ]
        for base_path in start_menu_paths:
            if not os.path.isdir(base_path):
                continue
            for lnk_path in glob.glob(os.path.join(base_path, "**", "*.lnk"), recursive=True):
                name = os.path.splitext(os.path.basename(lnk_path))[0].lower()
                if name and name not in apps:
                    apps[name] = lnk_path
        return apps

    def execute_command(
        self, command: str, timeout: int = 10, shell: str | None = None
    ) -> tuple[str, int]:
        return PowerShellExecutor.execute_command(command, timeout, shell)

    def is_window_browser(self, node: uia.Control):
        """Give any node of the app and it will return True if the app is a browser, False otherwise."""
        try:
            process = Process(node.ProcessId)
            return Browser.has_process(process.name())
        except Exception:
            return False

    def _find_window_by_name(
        self, name: str, refresh_state: bool = False
    ) -> tuple["Window | None", str]:
        """Find a window by fuzzy name match. Returns (window, error_msg).
        If the returned window is None, error_msg describes the failure reason.

        If refresh_state is True, always refresh desktop_state before searching;
        otherwise refresh only when desktop_state is absent or empty.
        """
        if refresh_state or self.desktop_state is None or not self.desktop_state.windows:
            self.get_state()
        if self.desktop_state is None:
            return None, "Failed to get desktop state. Please try again."

        window_list = [
            w
            for w in [self.desktop_state.active_window] + (self.desktop_state.windows or [])
            if w is not None
        ]
        if not window_list:
            return None, "No windows found on the desktop."

        # 1) Fuzzy-match against window titles (the primary signal).
        def _process_name(window: Window) -> str:
            try:
                return Process(window.process_id).name()
            except Exception:
                return ""

        def _process_base(window: Window) -> str:
            return re.sub(r"\.exe$", "", _process_name(window), flags=re.IGNORECASE).strip()

        def _unique_match(
            cue_pairs: list[tuple[str, Window]], signal: str
        ) -> tuple[Window | None, str]:
            scored = sorted(
                (
                    (fuzz.WRatio(name, cue), cue, window)
                    for cue, window in cue_pairs
                    if cue and cue.strip()
                ),
                key=lambda item: item[0],
                reverse=True,
            )
            scored = [item for item in scored if item[0] >= 70]
            if not scored:
                return None, ""
            best_score = scored[0][0]
            contenders = [item for item in scored if best_score - item[0] <= 8]
            unique_handles = {item[2].handle for item in contenders}
            if len(unique_handles) > 1:
                choices = ", ".join(
                    f"{cue!r} (handle={window.handle}, score={score})"
                    for score, cue, window in contenders[:5]
                )
                return None, (
                    f"Application {name!r} is ambiguous by {signal}: {choices}. "
                    "Use a more specific window title."
                )
            return scored[0][2], ""

        matched_window, ambiguity = _unique_match(
            [(window.name, window) for window in window_list], "window title"
        )
        if ambiguity:
            return None, ambiguity
        if matched_window is not None:
            return matched_window, ""

        # 2) Fall back to the executable process base name (deduped, like
        # titles). This lets callers target an app by its app name ("Notepad")
        # even when the window title only echoes a file name.
        matched_process, ambiguity = _unique_match(
            [(_process_base(window).lower(), window) for window in window_list],
            "process name",
        )
        if ambiguity:
            return None, ambiguity
        if matched_process is not None:
            return matched_process, ""

        # 3) Match the requested name against localized start-menu app display
        # names (e.g. 记事本 on a Chinese Windows), then tie the matched app to a
        # running window through its executable process base name.
        try:
            apps = self.get_apps_from_start_menu()
            matched_app = process.extractOne(name, list(apps.keys()), score_cutoff=70)
            if matched_app is not None:
                appid = apps[matched_app[0]]
                exe_base = None
                if appid and (os.path.exists(appid) or "\\" in appid):
                    try:
                        exe_path = resolve_known_folder_guid_path(appid)
                        exe_base = os.path.splitext(os.path.basename(exe_path))[0].lower()
                    except Exception:
                        exe_base = None
                if exe_base:
                    matching_windows = [
                        window
                        for window in window_list
                        if _process_base(window).lower() == exe_base
                    ]
                    if len(matching_windows) == 1:
                        return matching_windows[0], ""
                    if len(matching_windows) > 1:
                        choices = ", ".join(
                            f"{window.name!r} (handle={window.handle})"
                            for window in matching_windows[:5]
                        )
                        return None, (
                            f"Application {name!r} maps to multiple running windows: "
                            f"{choices}. Use a specific window title."
                        )
        except Exception:
            pass

        return None, f"Application {name.title()} not found."

    def resize_app(
        self, name: str | None = None, size: tuple[int, int] = None, loc: tuple[int, int] = None
    ) -> tuple[str, int]:
        if name is not None:
            target_window, error = self._find_window_by_name(name, refresh_state=True)
            if target_window is None:
                return error, 1
        else:
            # If no name provided, try to resize the active window
            target_window = self.desktop_state.active_window if self.desktop_state else None

            if target_window is None:
                return "No active window found", 1

        # target_window is guaranteed to be non-None here
        if target_window.status == Status.MINIMIZED:
            return f"{target_window.name} is minimized", 1
        elif target_window.status == Status.MAXIMIZED:
            return f"{target_window.name} is maximized", 1
        else:
            window_control = uia.ControlFromHandle(target_window.handle)
            if loc is None:
                x = window_control.BoundingRectangle.left
                y = window_control.BoundingRectangle.top
                loc = (x, y)
            if size is None:
                width = window_control.BoundingRectangle.width()
                height = window_control.BoundingRectangle.height()
                size = (width, height)
            x, y = loc
            width, height = size
            window_control.MoveWindow(x, y, width, height)
            return (f"{target_window.name} resized to {width}x{height} at {x},{y}.", 0)

    def app(
        self,
        mode: Literal["launch", "switch", "resize"],
        name: str | None = None,
        loc: tuple[int, int] | None = None,
        size: tuple[int, int] | None = None,
    ):
        match mode:
            case "launch":
                response, status, pid = self.launch_app(name)
                if status != 0:
                    raise RuntimeError(response)

                # Smart wait using UIA Exists (avoids manual Python loops)
                # 228s 诊断为轮询超时叠加：用线程超时包裹 UIA 等待，防止单步阻塞
                launched = False
                if pid > 0:
                    try:
                        launched = _run_with_timeout(
                            lambda: uia.WindowControl(ProcessId=pid).Exists(maxSearchSeconds=3),
                            timeout_sec=5.0,
                        )
                    except Exception as ex:
                        logger.warning(f"App launch UIA wait by PID failed: {ex}")

                if not launched:
                    # Fallback: Regex search for the window title
                    safe_name = re.escape(name)
                    try:
                        launched = _run_with_timeout(
                            lambda: uia.WindowControl(RegexName=f"(?i).*{safe_name}.*").Exists(
                                maxSearchSeconds=3
                            ),
                            timeout_sec=5.0,
                        )
                    except Exception as ex:
                        logger.warning(f"App launch UIA wait by name failed: {ex}")

                if launched:
                    # If the window is already minimized (Win11 single-instance apps like Notepad
                    # open a new tab inside an existing minimized frame), restore and bring it
                    # forward so the caller actually sees it — avoids "launched but invisible".
                    try:
                        win, _ = _run_with_timeout(
                            lambda: self._find_window_by_name(name, refresh_state=True),
                            timeout_sec=5.0,
                        )
                        if win is not None and win.status == Status.MINIMIZED:
                            self.bring_window_to_top(win.handle)
                            return f"{name.title()} launched and restored from minimized."
                    except Exception:
                        pass
                    return f"{name.title()} launched."
                return f"Launching {name.title()} sent, but window not detected yet."
            case "resize":
                response, status = self.resize_app(name=name, size=size, loc=loc)
                if status != 0:
                    raise RuntimeError(response)
                else:
                    return response
            case "switch":
                response, status = self.switch_app(name)
                if status != 0:
                    raise RuntimeError(response)
                else:
                    return response

    def _check_app_exists(self, app_id: str) -> bool:
        """Check if an app with the given AppID exists in shell:AppsFolder."""
        safe_app_id = ps_quote(app_id)
        command = (
            f"$folder = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder'); "
            f"if ($folder) {{ [bool]$folder.ParseName({safe_app_id}) }} else {{ $false }}"
        )
        response, status = PowerShellExecutor.execute_command(command)
        return status == 0 and response.strip().lower() == "true"

    def launch_app(self, name: str) -> tuple[str, int, int]:
        apps_map = self.get_apps_from_start_menu()
        matched_app = process.extractOne(name, apps_map.keys(), score_cutoff=70)
        if matched_app is None:
            return (f"{name.title()} not found in start menu.", 1, 0)
        app_name, _ = matched_app
        appid = apps_map.get(app_name)
        if appid is None:
            return (f"{name.title()} not found in start menu.", 1, 0)

        pid = 0
        if os.path.exists(appid) or "\\" in appid:
            exe_path = resolve_known_folder_guid_path(appid)
            safe_exe_path = ps_quote(exe_path)
            command = f"Start-Process {safe_exe_path} -PassThru | Select-Object -ExpandProperty Id"
            response, status = PowerShellExecutor.execute_command(command)
            if status == 0 and response.strip().isdigit():
                pid = int(response.strip())
        else:
            if not self._check_app_exists(appid):
                return (f"Invalid app identifier: {appid}", 1, 0)

            safe = ps_quote(f"shell:AppsFolder\\{appid}")
            command = f"Start-Process {safe}"
            response, status = PowerShellExecutor.execute_command(command)

        return response, status, pid

    def switch_app(self, name: str):
        try:
            window, error = self._find_window_by_name(name)
            if window is None:
                return error, 1

            target_handle = window.handle

            was_minimized = uia.IsIconic(target_handle)
            self.bring_window_to_top(target_handle)
            if was_minimized:
                content = f"Restored {window.name.title()} from minimized and switched to it."
            else:
                content = f"Switched to {window.name.title()} window."
            return content, 0
        except Exception as e:
            return (f"Error switching app: {str(e)}", 1)

    def bring_window_to_top(self, target_handle: int):
        if not win32gui.IsWindow(target_handle):
            raise ValueError("Invalid window handle")

        try:
            if win32gui.IsIconic(target_handle):
                win32gui.ShowWindow(target_handle, win32con.SW_RESTORE)

            foreground_handle = win32gui.GetForegroundWindow()

            # Validate both handles before proceeding
            if not win32gui.IsWindow(foreground_handle):
                # No valid foreground window, just try to set target as foreground
                win32gui.SetForegroundWindow(target_handle)
                win32gui.BringWindowToTop(target_handle)
                return

            # We attach our own thread (current_tid) to both the foreground and
            # target window threads to make focus change succeed.
            #
            # Simply attaching foreground_thread to target_thread is not sufficient:
            # SetForegroundWindow is called from our MCP thread, and Windows requires
            # the calling process to satisfy the "received the last input event"
            # criterion. Without attaching current_tid, the system may only bring the
            # target window to the front but refuse to transfer keyboard
            # focus, causing subsequent keyboard input to remain in the previous window.
            #
            # By attaching current_tid to both threads, our thread shares
            # their input state and inherits that eligibility, allowing the system to
            # grant the focus switch.
            foreground_thread, _ = win32process.GetWindowThreadProcessId(foreground_handle)
            target_thread, _ = win32process.GetWindowThreadProcessId(target_handle)
            current_tid = ctypes.windll.kernel32.GetCurrentThreadId()

            if not foreground_thread or not target_thread or foreground_thread == target_thread:
                win32gui.SetForegroundWindow(target_handle)
                win32gui.BringWindowToTop(target_handle)
                return

            ctypes.windll.user32.AllowSetForegroundWindow(-1)

            attached_threads = []
            try:
                for thread in (foreground_thread, target_thread):
                    if thread and thread != current_tid:
                        try:
                            win32process.AttachThreadInput(current_tid, thread, True)
                            attached_threads.append(thread)
                        except Exception as e:
                            # AttachThreadInput fails with Access Denied for elevated
                            # processes (e.g. Settings, Task Manager). Skip the attach
                            # and still attempt SetForegroundWindow below.
                            logger.debug(
                                f"AttachThreadInput failed for thread {thread} "
                                f"(likely elevated process), skipping: {e}"
                            )

                win32gui.SetForegroundWindow(target_handle)
                win32gui.BringWindowToTop(target_handle)

                win32gui.SetWindowPos(
                    target_handle,
                    win32con.HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_SHOWWINDOW,
                )

            finally:
                for tid in reversed(attached_threads):
                    win32process.AttachThreadInput(current_tid, tid, False)

        except Exception as e:
            logger.exception(f"Failed to bring window to top: {e}")
            raise RuntimeError(
                f"Failed to bring window handle {target_handle} to the foreground"
            ) from e

    # Ambiguity guard for element-name matching (stress-test finding: a fuzzy
    # element= match silently hijacked a calibrated loc=). When the top fuzzy
    # matches are too close to call, or the same name resolves to several
    # nodes, raising with the candidate list beats clicking the wrong element.
    # The dialog-item fallback chain (cached tree -> live UIA search) is
    # preserved: a clearly low-scoring cached set still falls through to live.
    _ELEMENT_MIN_SCORE = 70
    _ELEMENT_AMBIGUITY_DELTA = 8

    def get_coordinates_from_element(self, element: str) -> tuple[int, int]:
        """Resolve a UI element by its textual description to screen coordinates.

        Fuzzy-matches *element* (e.g. "Send", "search box") against the names of
        the interactive and scrollable nodes captured by the last Snapshot, then
        returns the matched element's center. Lets a caller target an element by
        its on-screen label instead of by numeric ``label`` id.

        If the cached tree has no match, falls back to a bounded live UIA
        search under the foreground window — native file dialogs often expose
        their list items ("acadiso.dwt", "Documents") only shallowly in the
        cached Snapshot tree, while UIA can still see them.

        Raises ``ValueError`` (rather than silently targeting) when the match is
        ambiguous: several nodes share the matched name, or the top two fuzzy
        candidates score within ``_ELEMENT_AMBIGUITY_DELTA`` points of each
        other. Callers should then fall back to ``loc=[x, y]``.
        """
        tree_state = self.desktop_state.tree_state
        nodes = list(tree_state.interactive_nodes) + list(tree_state.scrollable_nodes)
        candidates = [node.name for node in nodes if node.name and node.name.strip()]
        if candidates:
            matched = process.extract(element, candidates, limit=2)
            if matched:
                best_name, best_score = matched[0]
                if best_score >= self._ELEMENT_MIN_SCORE:
                    best_nodes = [node for node in nodes if node.name == best_name]
                    if len(best_nodes) > 1:
                        coords = [(node.center.x, node.center.y) for node in best_nodes]
                        raise ValueError(
                            f"Element {element!r} matched {len(best_nodes)} nodes named "
                            f"{best_name!r} at {coords}. Pass loc=[x, y] to pick one."
                        )
                    if len(matched) > 1 and matched[1][1] >= best_score - self._ELEMENT_AMBIGUITY_DELTA:
                        raise ValueError(
                            f"Element {element!r} is ambiguous: top matches are "
                            f"{best_name!r} ({best_score}) and {matched[1][0]!r} "
                            f"({matched[1][1]}). Pass loc=[x, y] directly or use a "
                            f"more specific element name."
                        )
                    return best_nodes[0].center.x, best_nodes[0].center.y
        live = self._live_element_match(element)
        if live is not None:
            return live
        raise ValueError(f"No UI element matched {element!r}.")

    # Control types worth matching by name in the live-tree fallback: the
    # selectable items of lists/trees/combo boxes plus buttons. Walking
    # EVERYTHING under a CAD-scale window would be thousands of COM calls.
    _LIVE_ELEMENT_TYPES = frozenset(
        {
            "ListItemControl",
            "TreeItemControl",
            "ComboBoxItemControl",
            "ButtonControl",
        }
    )
    _LIVE_ELEMENT_MAX_NODES = 400
    _LIVE_ELEMENT_MAX_DEPTH = 6

    def _live_element_match(self, element: str) -> tuple[int, int] | None:
        """Bounded depth-first UIA search for a named item under the
        foreground window. Runs on the current (apartment-affine) thread and
        stops after a fixed node budget — no thread timeouts, which would
        break UIA's COM apartment affinity. Returns the matched node's
        center, or None."""
        foreground_handle = uia.GetForegroundWindow()
        if not foreground_handle:
            return None
        try:
            root = uia.ControlFromHandle(foreground_handle)
        except Exception:
            return None

        matches: list[tuple[str, tuple[int, int]]] = []
        budget = self._LIVE_ELEMENT_MAX_NODES

        def center_of(control) -> tuple[int, int] | None:
            try:
                rect = control.BoundingRectangle
                if rect.isempty():
                    return None
                return (rect.left + rect.width() // 2, rect.top + rect.height() // 2)
            except Exception:
                return None

        def walk(node, depth: int):
            nonlocal budget
            if depth > self._LIVE_ELEMENT_MAX_DEPTH or budget <= 0:
                return
            try:
                children = node.GetChildren()
            except Exception:
                return
            for child in children:
                budget -= 1
                if budget <= 0:
                    return
                try:
                    ctype = child.ControlTypeName
                    name = child.Name
                except Exception:
                    continue
                if name and name.strip() and ctype in self._LIVE_ELEMENT_TYPES:
                    center = center_of(child)
                    if center is not None:
                        matches.append((name, center))
                walk(child, depth + 1)

        walk(root, 0)
        if not matches:
            return None
        ranked = [
            item
            for item in process.extract(
                element, [name for name, _ in matches], limit=2
            )
            if item[1] >= self._ELEMENT_MIN_SCORE
        ]
        if not ranked:
            return None
        best_name, best_score = ranked[0]
        best_centers = [center for name, center in matches if name == best_name]
        if len(best_centers) > 1:
            raise ValueError(
                f"Element {element!r} matched {len(best_centers)} nodes named "
                f"{best_name!r} at {best_centers}. Pass loc=[x, y] to pick one."
            )
        if len(ranked) > 1 and ranked[1][1] >= best_score - self._ELEMENT_AMBIGUITY_DELTA:
            raise ValueError(
                f"Element {element!r} is ambiguous: top matches are "
                f"{best_name!r} ({best_score}) and {ranked[1][0]!r} ({ranked[1][1]}). "
                f"Pass loc=[x, y] directly or use a more specific element name."
            )
        return best_centers[0]

    def focus_window(self, name: str) -> str:
        """Bring a window to the foreground by fuzzy title / process / app
        name match, restoring it from minimized first.

        This is the strong focus guarantee for input tools: Click/Type accept
        a ``window`` argument and call this before acting, so keystrokes and
        clicks never land in whichever window happens to be frontmost.
        """
        window, error = self._find_window_by_name(name, refresh_state=True)
        if window is None:
            raise ValueError(error)
        was_minimized = uia.IsIconic(window.handle)
        self.bring_window_to_top(window.handle)
        expected_pid = getattr(window, "process_id", None)
        if not self.verify_foreground_window(window.handle, expected_pid):
            raise RuntimeError(
                f"Focus verification failed for {window.name!r} "
                f"(handle={window.handle}, process_id={expected_pid})."
            )
        if was_minimized:
            return f"Restored {window.name} from minimized and focused it."
        return f"Focused {window.name}."

    @staticmethod
    def verify_foreground_window(
        target_handle: int,
        target_process_id: int | None = None,
        timeout: float = 0.75,
    ) -> bool:
        """Poll the real foreground HWND and owner PID after a focus request."""
        deadline = monotonic() + max(0.0, timeout)
        while True:
            try:
                foreground = win32gui.GetForegroundWindow()
                _, foreground_pid = win32process.GetWindowThreadProcessId(foreground)
                handle_matches = foreground == target_handle
                pid_matches = (
                    target_process_id is None or foreground_pid == target_process_id
                )
                if handle_matches and pid_matches:
                    return True
            except Exception:
                pass
            if monotonic() >= deadline:
                return False
            sleep(0.025)

    def query_element_condition(
        self,
        text: str | None,
        window_name: str | None,
        *,
        require_enabled: bool = False,
        require_focused: bool = False,
        max_nodes: int = 400,
        max_depth: int = 8,
    ) -> tuple[bool, str]:
        """Evaluate an element condition against fresh live UIA properties.

        This path deliberately bypasses the rendered Snapshot tree: that tree
        omits many disabled nodes, so using it made ``element_enabled`` mean
        exactly the same thing as ``element_exists``.  Traversal is scoped to
        one top-level window and bounded by both depth and node count.
        """
        handle = uia.GetForegroundWindow()
        resolved_name = "foreground window"
        if window_name:
            previous_state = self.desktop_state
            try:
                window, error = self._find_window_by_name(
                    window_name, refresh_state=True
                )
            finally:
                # Wait/query captures must not replace the user's last
                # addressable Snapshot and its numeric labels.
                self.desktop_state = previous_state
            if window is None:
                return False, error
            handle = window.handle
            resolved_name = window.name
        if not handle:
            return False, "no foreground window was available"
        try:
            root = uia.ControlFromHandle(handle)
        except Exception as exc:
            return False, f"failed to inspect {resolved_name}: {exc}"

        expected = text.casefold() if text else None
        stack: list[tuple[object, int]] = [(root, 0)]
        visited = 0
        matching_disabled = False
        while stack and visited < max_nodes:
            control, depth = stack.pop()
            visited += 1
            try:
                name = str(getattr(control, "Name", "") or "")
                control_type = str(
                    getattr(control, "LocalizedControlType", "")
                    or getattr(control, "ControlTypeName", "")
                    or ""
                )
                haystack = f"{name}\n{control_type}".casefold()
                matches = expected is None or expected in haystack
                if matches:
                    enabled = bool(getattr(control, "IsEnabled", False))
                    focused = bool(getattr(control, "HasKeyboardFocus", False))
                    if require_enabled and not enabled:
                        matching_disabled = True
                    elif require_focused and not focused:
                        pass
                    else:
                        return True, (
                            f"live element matched {name or control_type!r} in "
                            f"{resolved_name!r} (enabled={enabled}, focused={focused})"
                        )
                if depth < max_depth:
                    children = list(control.GetChildren() or [])
                    stack.extend((child, depth + 1) for child in reversed(children))
            except Exception:
                continue

        if matching_disabled and require_enabled:
            return False, "matching element exists but is disabled"
        suffix = " (node budget exhausted)" if stack else ""
        return False, f"matching live element was absent{suffix}"

    def keyboard_layout(self) -> dict[str, object]:
        """Best-effort input-method / keyboard-layout probe.

        Queries the layout of the FOREGROUND window's thread (what the user
        would actually type into), not the MCP thread. ``is_english`` is
        False for CJK layouts where letters and punctuation may be
        intercepted by the IME before reaching the target control.
        """
        try:
            foreground_handle = uia.GetForegroundWindow() or 0
            thread_id = 0
            if foreground_handle:
                thread_id = ctypes.windll.user32.GetWindowThreadProcessId(
                    foreground_handle, None
                )
            hkl = ctypes.windll.user32.GetKeyboardLayout(thread_id)
            lang_id = hkl & 0xFFFF
            primary_language = lang_id & 0x3FF
            buffer = ctypes.create_unicode_buffer(16)
            layout_id = f"{hkl & 0xFFFFFFFF:08X}"
            if ctypes.windll.user32.GetKeyboardLayoutNameW(buffer):
                layout_id = buffer.value
            is_english = primary_language == 0x009

            ime_open = None
            if foreground_handle and not is_english:
                try:
                    imm32 = ctypes.windll.imm32
                    himc = imm32.ImmGetContext(foreground_handle)
                    if himc:
                        ime_open = bool(imm32.ImmGetOpenStatus(himc))
                        imm32.ImmReleaseContext(foreground_handle, himc)
                except Exception:
                    ime_open = None

            return {
                "layout_id": layout_id,
                "language_id": f"0x{lang_id:04X}",
                "is_english": is_english,
                "ime_open": ime_open,
            }
        except Exception as exc:
            return {
                "layout_id": None,
                "language_id": None,
                "is_english": None,
                "ime_open": None,
                "error": str(exc),
            }

    # Windows OCR through a validated backend. The language override and the
    # PowerShell template live in desktop/ocr_backend.py (WCC-P0-01): caller
    # strings are regex-validated before any script is assembled, so OCR
    # parameters cannot inject PowerShell syntax.
    _ocr_backend: OcrBackend | None = None

    @classmethod
    def set_ocr_backend(cls, backend: OcrBackend | None) -> None:
        """Override the OCR backend (tests inject fakes; production leaves
        the default PowerShell backend in place)."""
        cls._ocr_backend = backend

    @classmethod
    def _get_ocr_backend(cls) -> OcrBackend:
        if cls._ocr_backend is None:
            cls._ocr_backend = WindowsOcrPowerShellBackend()
        return cls._ocr_backend

    def ocr_region(
        self,
        region: list[int] | tuple[int, ...] | None = None,
        scale_up: float = 2.0,
        language: str | None = None,
    ) -> dict[str, object]:
        """OCR a screen rectangle (virtual-desktop coordinates) or the full
        virtual screen. The region is captured with the same screenshot
        backend as Snapshot, upscaled (small CAD command-line prompts OCR
        badly at native size — 2x is the default for the same reason), and fed
        to the Windows.Media.Ocr engine — no extra runtime dependency. Use it
        to verify on-screen state the accessibility tree does not expose
        (command-line echoes, canvas text, status-bar hints).
        """
        capture_rect = None
        if region is not None:
            capture_rect = self.parse_region_selection(list(region))
        image = self.get_screenshot(capture_rect=capture_rect)
        try:
            upscale = float(scale_up)
        except (TypeError, ValueError) as exc:
            raise ValueError("scale_up must be a number between 1 and 4") from exc
        if not math.isfinite(upscale) or not 1.0 <= upscale <= 4.0:
            raise ValueError("scale_up must be a number between 1 and 4")
        if upscale != 1.0:
            image = image.resize(
                (int(image.width * upscale), int(image.height * upscale)),
                Image.LANCZOS,
            )

        recognized = self._get_ocr_backend().recognize(image, language)
        return {
            "text": recognized["text"],
            "engine_available": recognized["engine_available"],
            "language": recognized["language"],
            "image_size": [image.width, image.height],
            "region": list(region) if region is not None else None,
            # I-07: OCR reads raw pixels and cannot see the accessibility
            # tree's protected/IsPassword state — say so on every result so
            # consumers never treat OCR as a route around protected content
            # (I-09: the limitation must be visible, never silent).
            "warnings": [
                "ocr reads raw pixels and cannot honor protected/IsPassword "
                "state; do not use it to read password or protected fields"
            ],
        }

    def current_desktop_session_id(self) -> str:
        try:
            desktop = get_current_desktop()
            return str(desktop.get("id") or desktop.get("name") or "default")
        except Exception:
            state = self.desktop_state
            active = state.active_desktop if state is not None else {}
            return str(active.get("id") or active.get("name") or "default")

    @staticmethod
    def _live_candidate(control) -> LiveElementCandidate:
        def read(name: str):
            try:
                return getattr(control, name)
            except Exception:
                return None

        runtime_id = None
        try:
            runtime_id = tuple(int(part) for part in control.GetRuntimeId())
        except Exception:
            pass
        bounds = None
        rectangle = read("BoundingRectangle")
        if rectangle is not None:
            try:
                if not rectangle.isempty():
                    bounds = Rect(
                        int(rectangle.left),
                        int(rectangle.top),
                        int(rectangle.right),
                        int(rectangle.bottom),
                    )
            except Exception:
                bounds = None

        def text(name: str) -> str | None:
            value = read(name)
            return str(value) if value not in (None, "") else None

        return LiveElementCandidate(
            runtime_id=runtime_id,
            control_type=text("ControlTypeName")
            or text("LocalizedControlType")
            or "",
            automation_id=text("AutomationId"),
            class_name=text("ClassName"),
            framework_id=text("FrameworkId"),
            name=text("Name"),
            bounds=bounds,
        )

    def _walk_exact_window(
        self,
        window: WindowRef,
        *,
        max_nodes: int = 600,
        max_depth: int = 8,
    ):
        root = uia.ControlFromHandle(window.hwnd)
        stack = [(root, 0)]
        visited = 0
        while stack and visited < max_nodes:
            control, depth = stack.pop()
            visited += 1
            yield control
            if depth >= max_depth:
                continue
            try:
                children = control.GetChildren()
            except Exception:
                continue
            stack.extend((child, depth + 1) for child in reversed(children))

    def find_by_runtime_id(
        self,
        window: WindowRef,
        runtime_id: tuple[int, ...],
    ) -> list[LiveElementCandidate]:
        matches = []
        for control in self._walk_exact_window(window):
            try:
                candidate_id = tuple(int(part) for part in control.GetRuntimeId())
            except Exception:
                continue
            if candidate_id == runtime_id:
                matches.append(self._live_candidate(control))
        return matches

    def find_by_locator(
        self,
        window: WindowRef,
        locator: ReacquireLocator,
    ) -> list[LiveElementCandidate]:
        def normalize(value: str | None) -> str:
            return (value or "").casefold().replace(" ", "").removesuffix("control")

        matches = []
        for control in self._walk_exact_window(window):
            candidate = self._live_candidate(control)
            if normalize(candidate.control_type) != normalize(locator.control_type):
                continue
            if locator.automation_id and candidate.automation_id != locator.automation_id:
                continue
            if locator.class_name and candidate.class_name != locator.class_name:
                continue
            if locator.framework_id and candidate.framework_id != locator.framework_id:
                continue
            if (
                not locator.automation_id
                and locator.name_hint
                and (candidate.name or "").casefold() != locator.name_hint.casefold()
            ):
                continue
            matches.append(candidate)
        if len(matches) > 1 and locator.spatial_hint is not None:
            expected_x, expected_y = locator.spatial_hint
            spatial = [
                candidate
                for candidate in matches
                if candidate.center is not None
                and abs(candidate.center[0] - expected_x) <= 24
                and abs(candidate.center[1] - expected_y) <= 24
            ]
            if spatial:
                matches = spatial
        return matches

    def query_by_name(
        self,
        window: WindowRef,
        query: str,
    ) -> list[LiveElementCandidate]:
        query_tokens = set(query.casefold().split())
        matches = []
        for control in self._walk_exact_window(window):
            candidate = self._live_candidate(control)
            name = (candidate.name or "").strip()
            automation_id = (candidate.automation_id or "").strip()
            searchable = f"{name} {candidate.control_type} {automation_id}".casefold()
            exact = query.casefold() in {name.casefold(), automation_id.casefold()}
            if exact or (query_tokens and query_tokens.issubset(set(searchable.split()))):
                if candidate.center is not None:
                    matches.append(candidate)
        return matches

    def _reacquire_uia_control_for_target(self, target: ResolvedTarget):
        """Return exactly one live Control for semantic pattern dispatch.

        This second reacquisition happens immediately before the provider call.
        It prevents a control replacement between TargetResolver validation and
        Pattern acquisition from silently becoming a raw-coordinate fallback.
        """
        ref = target.element_ref
        if ref is None:
            raise TargetResolutionError(
                ErrorCode.STALE_ELEMENT,
                "semantic dispatch requires a snapshot-bound element",
            )

        def controls_with_runtime_id():
            if ref.runtime_id is None:
                return []
            found = []
            for control in self._walk_exact_window(ref.window):
                try:
                    runtime_id = tuple(int(part) for part in control.GetRuntimeId())
                except Exception:
                    continue
                if runtime_id == ref.runtime_id:
                    found.append(control)
            return found

        matches = controls_with_runtime_id()
        if not matches:
            locator = ref.locator

            def normalize(value: str | None) -> str:
                return (value or "").casefold().replace(" ", "").removesuffix(
                    "control"
                )

            for control in self._walk_exact_window(ref.window):
                candidate = self._live_candidate(control)
                if normalize(candidate.control_type) != normalize(locator.control_type):
                    continue
                if locator.automation_id and candidate.automation_id != locator.automation_id:
                    continue
                if locator.class_name and candidate.class_name != locator.class_name:
                    continue
                if locator.framework_id and candidate.framework_id != locator.framework_id:
                    continue
                if (
                    not locator.automation_id
                    and locator.name_hint
                    and (candidate.name or "").casefold() != locator.name_hint.casefold()
                ):
                    continue
                if locator.spatial_hint is not None and candidate.center is not None:
                    expected_x, expected_y = locator.spatial_hint
                    if (
                        abs(candidate.center[0] - expected_x) > 24
                        or abs(candidate.center[1] - expected_y) > 24
                    ):
                        continue
                matches.append(control)

        if not matches:
            raise TargetResolutionError(
                ErrorCode.STALE_ELEMENT,
                "UIA element disappeared before semantic dispatch",
            )
        if len(matches) > 1:
            raise TargetResolutionError(
                ErrorCode.AMBIGUOUS_TARGET,
                "UIA element reacquisition became ambiguous before semantic dispatch",
            )
        return matches[0]

    @staticmethod
    def window_at_point(x: int, y: int) -> tuple[int, int] | None:
        handle = uia.WindowFromPoint(x, y)
        if not handle:
            return None
        top = uia.GetAncestor(handle, 2) or handle
        if not win32gui.IsWindow(top):
            return None
        _, process_id = win32process.GetWindowThreadProcessId(top)
        return int(top), int(process_id)

    def resolve_action_point(
        self,
        *,
        loc: list[int] | tuple[int, int] | None = None,
        label: int | None = None,
        element: str | None = None,
        snapshot_id: str | None = None,
        element_id: str | None = None,
        coordinate_space: str = "screen",
    ) -> ResolvedTarget | None:
        """Resolve and live-revalidate one action target inside the actor."""
        resolver = getattr(self, "_target_resolver", None)
        if resolver is None:
            # Compatibility for lightweight test doubles built with __new__.
            if loc is not None:
                point = tuple(loc)
                if coordinate_space == "screenshot":
                    point = (
                        self.snapshot_image_to_screen(snapshot_id, *point)
                        if snapshot_id
                        else self.image_to_screen_strict(*point)
                    )
                return ResolvedTarget(
                    receipt=self._legacy_point_receipt(point),
                    screen_point=point,
                    source="legacy_test_adapter",
                )
            if element_id is not None and snapshot_id is not None:
                point = self.get_coordinates_from_snapshot_ref(
                    snapshot_id, element_id=element_id
                )
            elif label is not None:
                point = (
                    self.get_coordinates_from_snapshot_ref(snapshot_id, label=label)
                    if snapshot_id
                    else self.get_coordinates_from_label(label)
                )
            elif element is not None:
                point = self.get_coordinates_from_element(element)
            else:
                return None
            return ResolvedTarget(
                receipt=self._legacy_point_receipt(point),
                screen_point=point,
                source="legacy_test_adapter",
            )

        effective_snapshot = snapshot_id or self._latest_snapshot_id
        if loc is not None:
            if effective_snapshot is None:
                raise TargetResolutionError(
                    ErrorCode.STALE_SNAPSHOT,
                    "a fresh Snapshot is required before a point mutation",
                )
            if coordinate_space == "screenshot":
                return resolver.resolve_frame_point(effective_snapshot, int(loc[0]), int(loc[1]))
            return resolver.resolve_screen_point(effective_snapshot, int(loc[0]), int(loc[1]))
        if element_id is not None or label is not None:
            if effective_snapshot is None:
                raise TargetResolutionError(
                    ErrorCode.STALE_SNAPSHOT,
                    "a fresh Snapshot is required before an element mutation",
                )
            return resolver.resolve_element(
                effective_snapshot,
                label=label,
                element_id=element_id,
            )
        if element is not None:
            if effective_snapshot is None:
                raise TargetResolutionError(
                    ErrorCode.STALE_SNAPSHOT,
                    "a fresh Snapshot is required before an element query mutation",
                )
            return resolver.resolve_query(effective_snapshot, element)
        return None

    def resolve_action_points(
        self,
        *,
        locs: list[list[int]] | None = None,
        labels: list[int] | None = None,
        snapshot_id: str | None = None,
        coordinate_space: str = "screen",
    ) -> list[ResolvedTarget]:
        """Resolve a batch under one actor turn and reserve one snapshot."""
        resolver = getattr(self, "_target_resolver", None)
        if resolver is None:
            resolved = []
            if locs:
                for loc in locs:
                    point = tuple(loc)
                    if coordinate_space == "screenshot":
                        point = (
                            self.snapshot_image_to_screen(snapshot_id, *point)
                            if snapshot_id
                            else self.image_to_screen_strict(*point)
                        )
                    resolved.append(
                        ResolvedTarget(
                            receipt=self._legacy_point_receipt(point),
                            screen_point=point,
                            source="legacy_test_adapter",
                        )
                    )
                return resolved
            for label in labels or []:
                point = (
                    self.get_coordinates_from_snapshot_ref(snapshot_id, label=label)
                    if snapshot_id
                    else self.get_coordinates_from_label(label)
                )
                resolved.append(
                    ResolvedTarget(
                        receipt=self._legacy_point_receipt(point),
                        screen_point=point,
                        source="legacy_test_adapter",
                    )
                )
            return resolved

        effective_snapshot = snapshot_id or self._latest_snapshot_id
        if effective_snapshot is None:
            raise TargetResolutionError(
                ErrorCode.STALE_SNAPSHOT,
                "a fresh Snapshot is required before a batch mutation",
            )
        resolved = []
        if locs:
            for loc in locs:
                if coordinate_space == "screenshot":
                    target = resolver.resolve_frame_point(
                        effective_snapshot,
                        int(loc[0]),
                        int(loc[1]),
                        claim=False,
                    )
                else:
                    target = resolver.resolve_screen_point(
                        effective_snapshot,
                        int(loc[0]),
                        int(loc[1]),
                        claim=False,
                    )
                resolved.append(target)
        else:
            for label in labels or []:
                resolved.append(
                    resolver.resolve_element(
                        effective_snapshot,
                        label=label,
                        claim=False,
                    )
                )
        if resolved:
            self.snapshot_store.claim_for_mutation(
                effective_snapshot,
                self._producer_generation,
            )
        return resolved

    def _focus_resolved_target(self, resolved: ResolvedTarget | None) -> None:
        if resolved is None or resolved.receipt.window_handle is None:
            return
        handle = resolved.receipt.window_handle
        process_id = resolved.receipt.process_id
        if self.verify_foreground_window(handle, process_id, timeout=0.0):
            return
        self.bring_window_to_top(handle)
        if not self.verify_foreground_window(handle, process_id):
            raise TargetResolutionError(
                ErrorCode.TARGET_NOT_FOREGROUND,
                "resolved target window could not be verified as foreground",
            )

    def _finish_target_mutation(self, resolved: ResolvedTarget | None) -> None:
        if resolved is not None and resolved.receipt.snapshot_id is not None:
            self.mark_snapshot_mutated(resolved.receipt.snapshot_id)

    def _focus_resolved_batch(self, resolved: list[ResolvedTarget]) -> None:
        """Focus one batch target window or fail closed for cross-window input."""
        owners = {
            (target.receipt.window_handle, target.receipt.process_id)
            for target in resolved
            if target.receipt.window_handle is not None
        }
        if len(owners) > 1:
            raise TargetResolutionError(
                ErrorCode.AMBIGUOUS_TARGET,
                "batch targets span multiple windows; split the operation into fresh snapshots",
            )
        if resolved:
            self._focus_resolved_target(resolved[0])

    def _verify_window_receipt(self, window, window_receipt, resolved) -> None:
        """Fail closed when a model-supplied ``window_receipt`` does not match
        the window this action will actually hit (WCC-P2-02).

        The receipt is a verifier, not an alternative selector: the host
        scopes the user's approval to the receipt's digest, so approving and
        dispatching must resolve to the SAME window. A stale receipt (app
        restarted) or a receipt contradicting the ``window`` name refuses
        the action before any dispatch. ``None`` means the legacy path: no
        exact-target claim was made, nothing to verify.
        """
        if window_receipt is None:
            return
        try:
            claimed_hwnd = int(window_receipt.get("hwnd", 0))
            claimed_digest = str(window_receipt.get("digest", ""))
        except Exception:
            claimed_hwnd, claimed_digest = 0, ""
        if claimed_hwnd <= 0 or not claimed_digest:
            raise TargetResolutionError(
                ErrorCode.STALE_WINDOW,
                "window_receipt is malformed; capture a fresh Snapshot and copy a Window Receipt verbatim",
            )
        handle = None
        pid = None
        if window:
            found, _error = self._find_window_by_name(window, refresh_state=False)
            if found is not None:
                handle, pid = int(found.handle), int(found.process_id)
        elif resolved is not None and resolved.receipt.window_handle is not None:
            handle = int(resolved.receipt.window_handle)
            pid = resolved.receipt.process_id
        if handle is None:
            raise TargetResolutionError(
                ErrorCode.STALE_WINDOW,
                "window_receipt names an exact target but the action resolves to none; pass window= or a snapshot-bound target",
            )
        from windows_mcp.runtime.identity import process_start_100ns, window_receipt_digest

        live_digest = window_receipt_digest(handle, pid, process_start_100ns(pid))
        if claimed_hwnd != handle or claimed_digest != live_digest:
            raise TargetResolutionError(
                ErrorCode.STALE_WINDOW,
                f"window_receipt does not match the resolved window (handle={handle}); "
                "the app may have restarted or the receipt belongs to another window — capture a fresh Snapshot",
            )

    def _prepare_postcondition(self, resolved, predicates):
        verifier = getattr(self, "_verifier", None)
        if verifier is None or resolved is None or not predicates:
            return None
        # Live matrix batch 1 (s1) finding: `element_exists`/`element_gone`
        # need the verifier's element reader (`read_state` produces `exists`
        # only for element_ref-bound targets). Against a coordinate (loc)
        # target the predicate could never confirm and silently degraded the
        # whole mutation to unknown_outcome. Refuse that combination BEFORE
        # dispatch instead — an honest rejection, not a doomed verification.
        # Router-derived element predicates (toggle/selection/…) are out of
        # scope: they are only derived from observed element capabilities.
        if resolved.element_ref is None and any(
            predicate.operator in (PredicateOperator.EXISTS, PredicateOperator.GONE)
            for predicate in predicates
        ):
            raise ValueError(
                "expected_postconditions element_exists/element_gone require "
                "an element-bound target (element_id/label from a Snapshot). "
                "For a coordinate (loc) target use 'frame_changed', or verify "
                "the element with WaitFor element_exists."
            )
        return verifier.prepare(
            resolved,
            pre_revision=getattr(self, "_observation_revision", 0),
            predicates=tuple(predicates),
        )

    def _observe_postcondition(self, handle, predicates):
        """Observe EVERY predicate after dispatch (§13.2 expected_postconditions).

        Returns ``(evidence, unconfirmed_descriptions)``. Evidence is produced
        ONLY when every predicate is satisfied — one unconfirmed postcondition
        degrades the whole verification to unknown_outcome rather than a
        fabricated confirmed_success. A pre-satisfied predicate (already true
        at the baseline) yields no evidence by the verifier's contract and
        counts as unconfirmed: conservative, but honest about the effect.
        """
        verifier = getattr(self, "_verifier", None)
        if verifier is None or handle is None or not predicates:
            return None, []
        predicates = tuple(predicates)
        results = [
            verifier.observe_after_dispatch(
                handle,
                predicate,
                earliest_qpc=self._runtime_clock.qpc_ns(),
            )
            for predicate in predicates
        ]
        unconfirmed = [
            predicate.description
            for predicate, result in zip(predicates, results)
            if result.evidence is None
        ]
        if unconfirmed:
            return None, unconfirmed
        satisfied = [result.evidence for result in results]
        if len(satisfied) == 1:
            # The common single-predicate path keeps the verifier's own
            # evidence object (identity is asserted by contract tests).
            return satisfied[0], []
        return (
            VerificationEvidence(
                verifier=satisfied[0].verifier,
                predicate=" & ".join(evidence.predicate for evidence in satisfied),
                observed="all postconditions satisfied after dispatch",
                revision=satisfied[0].revision,
            ),
            [],
        )

    def dispatch_multi_select_targets(
        self,
        *,
        locs,
        labels,
        snapshot_id,
        coordinate_space,
        press_ctrl,
        window_receipt=None,
        expected_postconditions=None,
    ) -> dict[str, object]:
        """Resolve, focus, and select a batch without releasing the actor turn."""
        self._refuse_if_takeover()

        def _dispatch() -> dict[str, object]:
            resolved = self.resolve_action_points(
                locs=locs or None,
                labels=labels or None,
                snapshot_id=snapshot_id,
                coordinate_space=coordinate_space,
            )
            self._verify_window_receipt(None, window_receipt, resolved[0] if resolved else None)
            points = [list(target.screen_point) for target in resolved]
            # §13.2 v1: the batch's postconditions are observed against the
            # FIRST resolved target (the batch anchor). A per-item verifier
            # would need N preparation passes per batch — defer until the
            # real-machine matrix asks for it.
            predicates = tuple(expected_postconditions or ())
            verification_handle = self._prepare_postcondition(
                resolved[0] if resolved else None, predicates
            )

            try:
                self._focus_resolved_batch(resolved)
                self.multi_select(press_ctrl, points)
                verification, unconfirmed_postconditions = self._observe_postcondition(
                    verification_handle, predicates
                )
                return {
                    "locs": points,
                    "resolved_targets": resolved,
                    "snapshot_id": (
                        resolved[0].receipt.snapshot_id if resolved else snapshot_id
                    ),
                    "execution_channel": "send_input",
                    "verification": verification,
                    "postconditions_unconfirmed": unconfirmed_postconditions,
                    "pre_revision": (
                        verification_handle.pre_revision
                        if verification_handle is not None
                        else getattr(self, "_observation_revision", 0)
                    ),
                    "post_revision": verification.revision if verification else None,
                }
            finally:
                self._finish_target_mutation(resolved[0] if resolved else None)

        return self._mutation_takeover(_dispatch)

    def dispatch_multi_edit_targets(
        self,
        *,
        locs,
        labels,
        snapshot_id,
        coordinate_space,
        window_receipt=None,
    ) -> dict[str, object]:
        """Resolve and edit a same-window field batch in one actor command."""
        self._refuse_if_takeover()

        def _dispatch() -> dict[str, object]:
            if locs:
                raw_points = [[item[0], item[1]] for item in locs]
                texts = [item[2] for item in locs]
                label_ids = None
            else:
                raw_points = None
                label_ids = [item[0] for item in labels or []]
                texts = [item[1] for item in labels or []]
            resolved = self.resolve_action_points(
                locs=raw_points,
                labels=label_ids,
                snapshot_id=snapshot_id,
                coordinate_space=coordinate_space,
            )
            self._verify_window_receipt(None, window_receipt, resolved[0] if resolved else None)
            edit_locs = [
                [target.screen_point[0], target.screen_point[1], text]
                for target, text in zip(resolved, texts)
            ]
            try:
                self._focus_resolved_batch(resolved)
                self.multi_edit(edit_locs)
                return {
                    "locs": edit_locs,
                    "resolved_targets": resolved,
                    "snapshot_id": (
                        resolved[0].receipt.snapshot_id if resolved else snapshot_id
                    ),
                }
            finally:
                self._finish_target_mutation(resolved[0] if resolved else None)

        return self._mutation_takeover(_dispatch)

    def dispatch_click_target(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window,
        window_receipt=None,
        button,
        clicks,
        modifiers,
        action,
        hold_seconds,
        expected_postconditions=None,
    ) -> dict[str, object]:
        self._refuse_if_takeover()

        def _dispatch() -> dict[str, object]:
            return self._dispatch_click_target_locked(
                loc=loc,
                label=label,
                element=element,
                snapshot_id=snapshot_id,
                element_id=element_id,
                coordinate_space=coordinate_space,
                window=window,
                window_receipt=window_receipt,
                button=button,
                clicks=clicks,
                modifiers=modifiers,
                action=action,
                hold_seconds=hold_seconds,
                expected_postconditions=expected_postconditions,
            )

        return self._mutation_takeover(_dispatch, feedback_click=action == "click")

    def _dispatch_click_target_locked(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window,
        window_receipt=None,
        button,
        clicks,
        modifiers,
        action,
        hold_seconds,
        expected_postconditions=None,
    ) -> dict[str, object]:
        resolved = self.resolve_action_point(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
        )
        self._verify_window_receipt(window, window_receipt, resolved)
        point = list(resolved.screen_point) if resolved and resolved.screen_point else None
        focus_note = ""
        hit_note = ""
        router = getattr(self, "_action_router", None)
        semantic_eligible = (
            button == "left"
            and clicks == 1
            and not modifiers
            and action == "click"
            and hold_seconds is None
        )
        predicate = (
            router.click_postcondition(
                resolved, semantic_eligible=semantic_eligible
            )
            if router is not None
            else None
        )
        predicates = tuple(
            predicate for predicate in (predicate, *(expected_postconditions or ()))
            if predicate is not None
        )
        verification_handle = self._prepare_postcondition(resolved, predicates)

        def raw_dispatch() -> None:
            nonlocal focus_note, hit_note
            focus_note = self.focus_window(window) if window else ""
            self._focus_resolved_target(resolved)
            self.click(
                loc=point,
                button=button,
                clicks=clicks,
                modifiers=modifiers,
                action=action,
                hold_seconds=hold_seconds,
            )
            hit_note = (
                self.click_hit_note(point[0], point[1])
                if point is not None and action != "up"
                else ""
            )

        try:
            if router is None:
                raw_dispatch()
                route = None
            else:
                route = router.click(
                    resolved,
                    raw_dispatch,
                    semantic_eligible=semantic_eligible,
                )
            verification, unconfirmed_postconditions = self._observe_postcondition(
                verification_handle, predicates
            )
            return {
                "loc": point,
                "resolved_target": resolved,
                "focus_note": focus_note,
                "hit_note": hit_note,
                "execution_channel": route.channel if route else "send_input",
                "semantic_action": route.action.value if route else "raw_click",
                "dispatch_status": (
                    DispatchStatus.POSSIBLE
                    if route and route.outcome is BackendOutcome.POSSIBLE
                    else DispatchStatus.ACCEPTED
                ),
                "dispatch_detail": route.detail if route else "",
                "verification": verification,
                "postconditions_unconfirmed": unconfirmed_postconditions,
                "pre_revision": (
                    verification_handle.pre_revision
                    if verification_handle is not None
                    else getattr(self, "_observation_revision", 0)
                ),
                "post_revision": verification.revision if verification else None,
            }
        finally:
            self._finish_target_mutation(resolved)

    def dispatch_type_target(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window,
        window_receipt=None,
        text,
        caret_position,
        clear,
        press_enter,
        interval,
        expected_postconditions=None,
    ) -> dict[str, object]:
        self._refuse_if_takeover()

        def _dispatch() -> dict[str, object]:
            return self._dispatch_type_target_locked(
                loc=loc,
                label=label,
                element=element,
                snapshot_id=snapshot_id,
                element_id=element_id,
                coordinate_space=coordinate_space,
                window=window,
                window_receipt=window_receipt,
                text=text,
                caret_position=caret_position,
                clear=clear,
                press_enter=press_enter,
                interval=interval,
                expected_postconditions=expected_postconditions,
            )

        return self._mutation_takeover(_dispatch)

    def _dispatch_type_target_locked(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window,
        window_receipt=None,
        text,
        caret_position,
        clear,
        press_enter,
        interval,
        expected_postconditions=None,
    ) -> dict[str, object]:
        resolved = self.resolve_action_point(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
        )
        self._verify_window_receipt(window, window_receipt, resolved)
        point = list(resolved.screen_point) if resolved and resolved.screen_point else None
        protected = resolved.protected if resolved is not None else None
        router = getattr(self, "_action_router", None)
        clear_value = clear is True or (
            isinstance(clear, str) and clear.casefold() == "true"
        )
        enter_value = press_enter is True or (
            isinstance(press_enter, str) and press_enter.casefold() == "true"
        )
        semantic_eligible = (
            clear_value
            and not enter_value
            and caret_position == "idle"
            and interval is None
        )
        predicate = (
            router.set_value_postcondition(
                resolved,
                text,
                semantic_eligible=semantic_eligible,
            )
            if router is not None
            else None
        )
        predicates = tuple(
            predicate for predicate in (predicate, *(expected_postconditions or ()))
            if predicate is not None
        )
        verification_handle = self._prepare_postcondition(resolved, predicates)

        def raw_dispatch() -> None:
            nonlocal protected
            if window:
                self.focus_window(window)
            self._focus_resolved_target(resolved)
            if point is None:
                protected = self.focused_control_is_protected()
            dispatched_protected = self.type(
                loc=point,
                text=text,
                caret_position=caret_position,
                clear=clear,
                press_enter=press_enter,
                interval=interval,
            )
            if isinstance(dispatched_protected, bool):
                protected = dispatched_protected

        try:
            if router is None:
                raw_dispatch()
                route = None
            else:
                route = router.set_value(
                    resolved,
                    text,
                    raw_dispatch,
                    semantic_eligible=(
                        semantic_eligible
                    ),
                )
            verification, unconfirmed_postconditions = self._observe_postcondition(
                verification_handle, predicates
            )
            if route is None or route.action.value == "raw_type":
                try:
                    layout = self.keyboard_layout()
                except Exception:
                    layout = None
            else:
                layout = None
            return {
                "loc": point,
                "resolved_target": resolved,
                "protected": protected,
                "keyboard_layout": layout,
                "execution_channel": (
                    route.channel if route else "send_keys_or_clipboard"
                ),
                "semantic_action": route.action.value if route else "raw_type",
                "dispatch_status": (
                    DispatchStatus.POSSIBLE
                    if route and route.outcome is BackendOutcome.POSSIBLE
                    else DispatchStatus.ACCEPTED
                ),
                "dispatch_detail": route.detail if route else "",
                "verification": verification,
                "postconditions_unconfirmed": unconfirmed_postconditions,
                "pre_revision": (
                    verification_handle.pre_revision
                    if verification_handle is not None
                    else getattr(self, "_observation_revision", 0)
                ),
                "post_revision": verification.revision if verification else None,
            }
        finally:
            self._finish_target_mutation(resolved)

    def dispatch_scroll_target(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window,
        window_receipt=None,
        scroll_type,
        direction,
        wheel_times,
        wheel_delta,
        expected_postconditions=None,
    ) -> dict[str, object]:
        self._refuse_if_takeover()

        def _dispatch() -> dict[str, object]:
            return self._dispatch_scroll_target_locked(
                loc=loc,
                label=label,
                element=element,
                snapshot_id=snapshot_id,
                element_id=element_id,
                coordinate_space=coordinate_space,
                window=window,
                window_receipt=window_receipt,
                scroll_type=scroll_type,
                direction=direction,
                wheel_times=wheel_times,
                wheel_delta=wheel_delta,
                expected_postconditions=expected_postconditions,
            )

        return self._mutation_takeover(_dispatch)

    def _dispatch_scroll_target_locked(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window,
        window_receipt=None,
        scroll_type,
        direction,
        wheel_times,
        wheel_delta,
        expected_postconditions=None,
    ) -> dict[str, object]:
        resolved = self.resolve_action_point(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
        )
        self._verify_window_receipt(window, window_receipt, resolved)
        point = list(resolved.screen_point) if resolved and resolved.screen_point else None
        response = None
        router = getattr(self, "_action_router", None)
        semantic_eligible = wheel_delta == 120
        predicate = (
            router.scroll_postcondition(
                resolved,
                scroll_type=scroll_type,
                semantic_eligible=semantic_eligible,
            )
            if router is not None
            else None
        )
        predicates = tuple(
            predicate for predicate in (predicate, *(expected_postconditions or ()))
            if predicate is not None
        )
        verification_handle = self._prepare_postcondition(resolved, predicates)

        def raw_dispatch() -> None:
            nonlocal response
            if window:
                self.focus_window(window)
            self._focus_resolved_target(resolved)
            response = self.scroll(
                point,
                scroll_type,
                direction,
                wheel_times,
                wheel_delta=wheel_delta,
            )

        try:
            if router is None:
                raw_dispatch()
                route = None
            else:
                route = router.scroll(
                    resolved,
                    raw_dispatch,
                    scroll_type=scroll_type,
                    direction=direction,
                    wheel_times=wheel_times,
                    semantic_eligible=semantic_eligible,
                )
            verification, unconfirmed_postconditions = self._observe_postcondition(
                verification_handle, predicates
            )
            return {
                "loc": point,
                "resolved_target": resolved,
                "response": response,
                "execution_channel": route.channel if route else "send_input",
                "semantic_action": route.action.value if route else "raw_scroll",
                "dispatch_status": (
                    DispatchStatus.POSSIBLE
                    if route and route.outcome is BackendOutcome.POSSIBLE
                    else DispatchStatus.ACCEPTED
                ),
                "dispatch_detail": route.detail if route else "",
                "verification": verification,
                "postconditions_unconfirmed": unconfirmed_postconditions,
                "pre_revision": (
                    verification_handle.pre_revision
                    if verification_handle is not None
                    else getattr(self, "_observation_revision", 0)
                ),
                "post_revision": verification.revision if verification else None,
            }
        finally:
            self._finish_target_mutation(resolved)

    def dispatch_move_target(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window_receipt=None,
        drag,
        from_loc,
        duration,
        button,
    ) -> dict[str, object]:
        self._refuse_if_takeover()

        def _dispatch() -> dict[str, object]:
            return self._dispatch_move_target_locked(
                loc=loc,
                label=label,
                element=element,
                snapshot_id=snapshot_id,
                element_id=element_id,
                coordinate_space=coordinate_space,
                window_receipt=window_receipt,
                drag=drag,
                from_loc=from_loc,
                duration=duration,
                button=button,
            )

        return self._mutation_takeover(_dispatch)

    def _dispatch_move_target_locked(
        self,
        *,
        loc,
        label,
        element,
        snapshot_id,
        element_id,
        coordinate_space,
        window_receipt=None,
        drag,
        from_loc,
        duration,
        button,
    ) -> dict[str, object]:
        resolved = self.resolve_action_point(
            loc=loc,
            label=label,
            element=element,
            snapshot_id=snapshot_id,
            element_id=element_id,
            coordinate_space=coordinate_space,
        )
        self._verify_window_receipt(None, window_receipt, resolved)
        point = list(resolved.screen_point) if resolved and resolved.screen_point else None
        start = from_loc
        effective_snapshot = resolved.receipt.snapshot_id if resolved else snapshot_id
        if from_loc is not None and effective_snapshot is not None:
            auxiliary = self._target_resolver.resolve_additional_point(
                effective_snapshot,
                int(from_loc[0]),
                int(from_loc[1]),
                coordinate_space=coordinate_space,
            )
            start = list(auxiliary.screen_point) if auxiliary.screen_point else None
        elif from_loc is not None and coordinate_space == "screenshot":
            start = list(self.image_to_screen_strict(int(from_loc[0]), int(from_loc[1])))
        try:
            self._focus_resolved_target(resolved)
            if drag:
                action_result = self.drag(
                    point,
                    from_loc=start,
                    duration=duration,
                    button=button,
                )
                cursor = None
            else:
                self.move(point)
                action_result = None
                try:
                    cursor = self.get_cursor_location()
                except Exception:
                    cursor = None
            return {
                "loc": point,
                "from_loc": start,
                "resolved_target": resolved,
                "drag_result": action_result,
                "cursor": cursor,
            }
        finally:
            self._finish_target_mutation(resolved)

    @staticmethod
    def _legacy_point_receipt(point: tuple[int, int]):
        from windows_mcp.runtime.results import TargetReceipt

        return TargetReceipt(
            target_kind="screen_point",
            description=f"screen point ({point[0]},{point[1]})",
        )

    def get_coordinates_from_label(self, label: int) -> tuple[int, int]:
        if type(label) is not int or label < 0:
            raise ValueError("label must be a non-negative integer")
        if self.desktop_state is None or self.desktop_state.tree_state is None:
            raise ValueError("Desktop state is empty. Please call Snapshot first.")
        tree_state = self.desktop_state.tree_state
        if label < len(tree_state.interactive_nodes):
            element_node = tree_state.interactive_nodes[label]
        else:
            scroll_idx = label - len(tree_state.interactive_nodes)
            if scroll_idx < len(tree_state.scrollable_nodes):
                element_node = tree_state.scrollable_nodes[scroll_idx]
            else:
                raise IndexError(f"Label {label} out of range")
        return element_node.center.x, element_node.center.y

    def get_coordinates_from_snapshot_ref(
        self,
        snapshot_id: str,
        *,
        label: int | None = None,
        element_id: str | None = None,
    ) -> tuple[int, int]:
        node = self.snapshot_store.resolve_node(
            snapshot_id,
            label=label,
            element_id=element_id,
            producer_generation=self._producer_generation,
            for_mutation=True,
        )
        bounds = node.bounds_screen
        if bounds is None or bounds.right <= bounds.left or bounds.bottom <= bounds.top:
            raise ValueError("snapshot element has no actionable screen bounds")
        return (
            bounds.left + (bounds.right - bounds.left) // 2,
            bounds.top + (bounds.bottom - bounds.top) // 2,
        )

    def snapshot_image_to_screen(
        self, snapshot_id: str, x: int, y: int
    ) -> tuple[int, int]:
        record = self.snapshot_store.require_fresh(
            snapshot_id,
            self._producer_generation,
            for_mutation=True,
        )
        frame = record.receipt.frame
        if frame is None:
            raise ValueError("snapshot has no image frame")
        if not 0 <= x < frame.pixel_width or not 0 <= y < frame.pixel_height:
            raise ValueError(
                f"image point ({x}, {y}) lies outside frame "
                f"{frame.pixel_width}x{frame.pixel_height}"
            )
        screen_x, screen_y = frame.image_to_screen.apply(x, y)
        return int(round(screen_x)), int(round(screen_y))

    def mark_snapshot_mutated(self, snapshot_id: str) -> None:
        self.snapshot_store.mark_superseded_for_mutation(
            snapshot_id,
            self._producer_generation,
        )

    def get_coordinates_from_labels(self, labels: list[int]) -> list[tuple[int, int]]:
        """Resolve multiple UI element labels to screen coordinates in bulk."""
        if self.desktop_state is None or self.desktop_state.tree_state is None:
            raise ValueError("Desktop state is empty. Please call Snapshot first.")
        tree_state = self.desktop_state.tree_state
        interactive_nodes = tree_state.interactive_nodes
        scrollable_nodes = tree_state.scrollable_nodes
        interactive_len = len(interactive_nodes)

        results = []
        for label in labels:
            if type(label) is not int or label < 0:
                raise ValueError("every label must be a non-negative integer")
            if label < interactive_len:
                element_node = interactive_nodes[label]
            else:
                scroll_idx = label - interactive_len
                if scroll_idx < len(scrollable_nodes):
                    element_node = scrollable_nodes[scroll_idx]
                else:
                    raise IndexError(f"Label {label} out of range")
            results.append((element_node.center.x, element_node.center.y))
        return results

    # Modifiers accepted alongside a click, mapped to VK codes.
    _MODIFIER_VK = {
        "ctrl": "VK_CONTROL",
        "control": "VK_CONTROL",
        "alt": "VK_MENU",
        "shift": "VK_SHIFT",
        "win": "VK_LWIN",
    }

    def click(
        self,
        loc: tuple[int, int] | list[int] | None,
        button: str = "left",
        clicks: int = 1,
        modifiers: list[str] | tuple[str, ...] | None = None,
        action: str = "click",
        hold_seconds: float | None = None,
    ):
        """Click / press / release the mouse.

        action="click" performs the (possibly multi-) click at *loc*;
        action="down" presses the button at *loc* and leaves it held;
        action="up" releases the button (at *loc* when given, otherwise at
        the current cursor position — pass loc=None). *modifiers* holds
        key names ("ctrl", "alt", "shift", "win") held down for the whole
        gesture, e.g. ["ctrl"] for Ctrl+Click multi-select.

        *hold_seconds* (with action="click") presses the button, waits the
        given duration, then releases — a single-call long press for app
        gestures whose hold timing matters (e.g. WeChat's long-press camera).
        """
        x = y = None
        if loc is not None:
            if isinstance(loc, list):
                x, y = loc[0], loc[1]
            else:
                x, y = loc

        if hold_seconds is not None:
            try:
                hold = float(hold_seconds)
            except (TypeError, ValueError) as exc:
                raise ValueError("hold_seconds must be a number of seconds between 0 and 10") from exc
            if not math.isfinite(hold) or not 0.0 <= hold <= 10.0:
                raise ValueError("hold_seconds must be a number of seconds between 0 and 10")

        modifier_keys = []
        for name in modifiers or ():
            vk_name = self._MODIFIER_VK.get(str(name).strip().lower())
            if vk_name is None:
                raise ValueError(
                    f"Unknown modifier {name!r}. Use one of: ctrl, alt, shift, win"
                )
            modifier_keys.append(getattr(uia.Keys, vk_name))

        if action == "up":
            # Release a held button. Right/middle releases send at the
            # current cursor position, mirroring the PressMouse family.
            release = {
                "left": uia.ReleaseMouse,
                "right": uia.RightReleaseMouse,
                "middle": uia.MiddleReleaseMouse,
            }.get(button)
            if release is None:
                raise ValueError(f"Unsupported button {button!r}")
            if x is not None:
                uia.SetCursorPos(x, y)
            for vk in modifier_keys:
                uia.PressKey(vk, waitTime=0.02)
            release(0.05)
            getattr(self, "_held_mouse_buttons", set()).discard(button)
            for vk in reversed(modifier_keys):
                uia.ReleaseKey(vk, waitTime=0.02)
            return

        press = {
            "left": uia.PressMouse,
            "right": uia.RightPressMouse,
            "middle": uia.MiddlePressMouse,
        }.get(button)
        if press is None:
            raise ValueError(f"Unsupported button {button!r}")

        # Hold modifiers for the whole gesture so the OS click event
        # carries them (Ctrl+Click multi-select, Shift+Click ranges).
        for vk in modifier_keys:
            uia.PressKey(vk, waitTime=0.02)
            getattr(self, "_held_modifier_keys", set()).add(vk)
        try:
            if action == "down":
                press(x, y, 0.05)
                getattr(self, "_held_mouse_buttons", set()).add(button)
                return
            if hold_seconds is not None and hold > 0:
                # Single-call long press: down, dwell, up — the hold duration
                # is deterministic instead of split across two tool calls whose
                # round-trip latency the OS sees as arbitrary.
                release = {
                    "left": uia.ReleaseMouse,
                    "right": uia.RightReleaseMouse,
                    "middle": uia.MiddleReleaseMouse,
                }[button]
                press(x, y, 0.05)
                sleep(hold)
                release(0.05)
                return
            if clicks == 0:
                uia.SetCursorPos(x, y)
                return
            # The gap between consecutive clicks must be shorter than the
            # system double-click time or the OS never groups them — for
            # every button, not just left (AutoCAD's "double middle click
            # = Zoom Extents" is the highest-frequency example). Wait
            # half the double-click budget BETWEEN clicks, and the full
            # OPERATION_WAIT_TIME only after the last one.
            dbl_wait = uia.GetDoubleClickTime() / 2000.0
            for i in range(clicks):
                last = i >= clicks - 1
                gap = 0.5 if last else dbl_wait
                if button == "left":
                    uia.Click(x, y, waitTime=gap)
                elif button == "right":
                    uia.RightClick(x, y, waitTime=gap)
                else:
                    uia.MiddleClick(x, y, waitTime=gap)
        finally:
            for vk in reversed(modifier_keys):
                uia.ReleaseKey(vk, waitTime=0.02)
                getattr(self, "_held_modifier_keys", set()).discard(vk)

    # Strings longer than this typed via clipboard paste instead of
    # per-key SendKeys. SendKeys at high cadence loses keystrokes on
    # slower / loaded systems (Win11 VMs in particular) — observed
    # "hello from windows-mcp drive test" rendering as
    # "hello tttttttttttttttttttttttttt" on a 4-core Win11 VM. The
    # paste path is reliable because it bypasses the scan-code queue
    # entirely. Plain-text only; control chars route through SendKeys
    # so escape sequences ({Enter}, {Tab}, …) still work.
    _LONG_TEXT_PASTE_THRESHOLD = 20

    def type(
        self,
        loc: tuple[int, int] | list[int] | None,
        text: str,
        caret_position: Literal["start", "idle", "end"] = "idle",
        clear: bool | str = False,
        press_enter: bool | str = False,
        interval: float | None = None,
    ) -> bool:
        """Type text into the focused control.

        When *loc* is None the text goes straight to whatever control holds
        keyboard focus — no click is synthesized. Decoupling typing from
        clicking matters for command-line-style UIs (CAD command line,
        terminals): a stray click there is itself an input ("first corner
        of zoom window"), not a focus fix.

        *interval* is the per-key delay in seconds (default 0.04, kept
        from the earlier key-loss fix); raise it for slow prompt-driven
        CLIs, lower it for big pastes. Newlines in *text* become Enter
        keystrokes, so multi-line sequences ride one call.
        """
        if loc is not None:
            x, y = loc
            uia.Click(x, y)
        protected = self.focused_control_is_protected()
        if caret_position == "start":
            uia.SendKeys("{Home}", waitTime=0.05)
        elif caret_position == "end":
            uia.SendKeys("{End}", waitTime=0.05)
        if clear is True or (isinstance(clear, str) and clear.lower() == "true"):
            sleep(0.5)
            uia.SendKeys("{Ctrl}a", waitTime=0.05)
            uia.SendKeys("{Back}", waitTime=0.05)
        # Per-key SendKeys for short ASCII text (so escape sequences keep
        # working); clipboard paste for long text (so the scan-code queue can't
        # race) AND for any non-ASCII text (CJK, accented chars, emoji) — per-key
        # SendUnicodeChar is silently intercepted/converted by Microsoft Pinyin
        # and other IMEs, while clipboard injection bypasses the IME entirely.
        has_control_chars = any(c in text for c in ("\n", "\t", "{", "}"))
        has_non_ascii = any(ord(c) > 127 for c in text)
        if has_non_ascii:
            self._paste_text(text)
        elif len(text) >= self._LONG_TEXT_PASTE_THRESHOLD and not has_control_chars:
            self._paste_text(text)
        else:
            escaped_text = _escape_text_for_sendkeys(text)
            effective_interval = 0.04 if interval is None else max(0.0, float(interval))
            uia.SendKeys(escaped_text, interval=effective_interval, waitTime=0.05)
        if press_enter is True or (isinstance(press_enter, str) and press_enter.lower() == "true"):
            uia.SendKeys("{Enter}", waitTime=0.05)
        return protected

    def focused_control_is_protected(self) -> bool:
        """True when the control holding keyboard focus is a password field.

        Used by the Type tool to withhold content facts (length, character
        classes) from the tool result. Any probe failure returns False — the
        caller then applies the weaker "no echo, count only" default — while
        a real password field never leaks either fact. Read BEFORE the keys
        are injected so the classification cannot race the typing.
        """
        try:
            focused = uia.GetFocusedControl()
        except Exception:
            return False
        if focused is None:
            return False
        try:
            return bool(focused.IsPassword)
        except Exception:
            return False

    def _paste_text(self, text: str):
        """Stash text on the clipboard, Ctrl+V, restore prior clipboard.
        Plain-text only — control chars (newlines, tabs, braces) need to
        route through SendKeys instead so escape sequences are honored.
        """
        prior = None
        try:
            prior = uia.GetClipboardText()
        except Exception:
            pass
        uia.SetClipboardText(text)
        # Tiny pause so the OS clipboard write settles before Ctrl+V reads.
        sleep(0.05)
        uia.SendKeys("{Ctrl}v", waitTime=0.05)
        # Restore prior clipboard so we don't surprise other tools.
        if prior is not None:
            sleep(0.05)
            try:
                uia.SetClipboardText(prior)
            except Exception:
                pass

    def scroll(
        self,
        loc: tuple[int, int] = None,
        type: Literal["horizontal", "vertical"] = "vertical",
        direction: Literal["up", "down", "left", "right"] = "down",
        wheel_times: int = 1,
        wheel_delta: int = 120,
    ) -> str | None:
        """Scroll with wheel granularity control.

        *wheel_delta* is the raw wheel amount per notch (WHEEL_DELTA=120 by
        default). Apps that accumulate partial deltas — CAD zoom, map
        canvases — accept values below 120, which enables zoom steps finer
        than one physical notch.
        """
        if loc:
            self.move(loc)
        delta = max(1, int(wheel_delta))
        match type:
            case "vertical":
                match direction:
                    case "up":
                        uia.WheelUp(wheel_times, delta=delta)
                    case "down":
                        uia.WheelDown(wheel_times, delta=delta)
                    case _:
                        return 'Invalid direction. Use "up" or "down".'
            case "horizontal":
                match direction:
                    case "left":
                        uia.PressKey(uia.Keys.VK_SHIFT, waitTime=0.05)
                        uia.WheelUp(wheel_times, delta=delta)
                        sleep(0.05)
                        uia.ReleaseKey(uia.Keys.VK_SHIFT, waitTime=0.05)
                    case "right":
                        uia.PressKey(uia.Keys.VK_SHIFT, waitTime=0.05)
                        uia.WheelDown(wheel_times, delta=delta)
                        sleep(0.05)
                        uia.ReleaseKey(uia.Keys.VK_SHIFT, waitTime=0.05)
                    case _:
                        return 'Invalid direction. Use "left" or "right".'
            case _:
                return 'Invalid type. Use "horizontal" or "vertical".'
        return None

    def _normalize_drag_duration(self, duration: float | int | str | None) -> float | None:
        if duration is None:
            return None
        if isinstance(duration, bool):
            raise ValueError("duration must be a finite number of seconds")
        try:
            effective_duration = float(duration)
        except (TypeError, ValueError) as exc:
            raise ValueError("duration must be a finite number of seconds") from exc
        if not math.isfinite(effective_duration):
            raise ValueError("duration must be a finite number of seconds")
        if effective_duration < 0 or effective_duration > 10:
            raise ValueError("duration must be between 0 and 10 seconds")
        return effective_duration

    @staticmethod
    def _normalize_drag_point(value: object, name: str) -> tuple[int, int]:
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise ValueError(f"{name} must be a list or tuple of exactly 2 integers [x, y]")
        x, y = value
        if any(isinstance(item, bool) or not isinstance(item, int) for item in (x, y)):
            raise ValueError(f"{name} must contain exactly 2 integers")
        return x, y

    def drag(
        self,
        loc: tuple[int, int] | list[int],
        from_loc: tuple[int, int] | list[int] | None = None,
        duration: float | int | str | None = None,
        button: str = "left",
    ) -> dict[str, object]:
        x, y = self._normalize_drag_point(loc, "loc")
        normalized_from_loc = (
            None if from_loc is None else self._normalize_drag_point(from_loc, "from_loc")
        )
        effective_duration = self._normalize_drag_duration(duration)
        if button not in ("left", "right", "middle"):
            raise ValueError('button must be "left", "right", or "middle"')
        sleep(0.5)
        if normalized_from_loc is None:
            cx, cy = uia.GetCursorPos()
        else:
            cx, cy = normalized_from_loc
        drag_press = {
            "left": uia.PressMouse,
            "right": uia.RightPressMouse,
            "middle": uia.MiddlePressMouse,
        }[button]
        drag_release = {
            "left": uia.ReleaseMouse,
            "right": uia.RightReleaseMouse,
            "middle": uia.MiddleReleaseMouse,
        }[button]
        try:
            drag_press(cx, cy, 0.05)
            if effective_duration is None:
                uia.MoveTo(x, y, 1, 0.05)
            else:
                uia.MoveToDuration(x, y, effective_duration, 0.05)
        except BaseException as move_error:
            try:
                drag_release(0.05)
            except BaseException as release_error:
                raise release_error from move_error
            raise
        drag_release(0.5)
        return {
            "start": [cx, cy],
            "end": [x, y],
            "duration": effective_duration,
            "button": button,
        }

    def move(self, loc: tuple[int, int]):
        x, y = loc
        uia.MoveTo(x, y, moveSpeed=10)

    @control_overlay.operation()
    def shortcut(self, shortcut: str):
        keys = shortcut.split("+")
        sendkeys_str = ""
        for key in keys:
            key = key.strip()
            if len(key) == 1:
                sendkeys_str += key
            else:
                name = _KEY_ALIASES.get(key.lower(), key)
                sendkeys_str += "{" + name + "}"
        uia.SendKeys(sendkeys_str, interval=0.01)

    def multi_select(self, press_ctrl: bool | str = False, locs: list[tuple[int, int]] = []):
        press_ctrl = press_ctrl is True or (
            isinstance(press_ctrl, str) and press_ctrl.lower() == "true"
        )
        if press_ctrl:
            uia.PressKey(uia.Keys.VK_CONTROL, waitTime=0.05)
            getattr(self, "_held_modifier_keys", set()).add(uia.Keys.VK_CONTROL)
        try:
            for loc in locs:
                x, y = loc
                uia.Click(x, y, waitTime=0.2)
                sleep(0.5)
        finally:
            if press_ctrl:
                uia.ReleaseKey(uia.Keys.VK_CONTROL, waitTime=0.05)
                getattr(self, "_held_modifier_keys", set()).discard(
                    uia.Keys.VK_CONTROL
                )

    def multi_edit(self, locs: list[tuple[int, int, str]]):
        for loc in locs:
            x, y, text = loc
            self.type((x, y), text=text, clear=True)

    def scrape(self, url: str) -> str:
        current_url = url
        try:
            for _ in range(5):
                validate_url(current_url)
                response = requests.get(current_url, timeout=10, allow_redirects=False)
                if not response.is_redirect:
                    break
                location = response.headers.get("Location")
                if not location:
                    raise ValueError(f"Redirect from {current_url} has no Location header")
                current_url = urljoin(current_url, location)
            else:
                raise ValueError("Too many redirects while fetching URL")
            response.raise_for_status()
        except requests.exceptions.HTTPError as e:
            raise ValueError(f"HTTP error for {current_url}: {e}") from e
        except requests.exceptions.ConnectionError as e:
            raise ConnectionError(f"Failed to connect to {current_url}: {e}") from e
        except requests.exceptions.Timeout as e:
            raise TimeoutError(f"Request timed out for {current_url}: {e}") from e
        html = response.text
        content = markdownify(html=html)
        return content

    def is_overlay_window(self, element: uia.Control) -> bool:
        """Return True if the window is a decorative overlay rather than a real app window.

        "No children" alone is deliberately not enough. When UIA child
        enumeration degrades — as it does on Windows ARM64 under x86-emulated
        Python — every window looks childless, and treating that as an overlay
        filters out the entire desktop and leaves the caller blind. A real app
        window always has a title, so require both signals.
        """
        name = element.Name.strip()
        if "Overlay" in name:
            return True
        return not name and len(element.GetChildren()) == 0

    def get_controls_handles(self, optimized: bool = False):
        handles = set()

        # For even more faster results (still under development)
        def callback(hwnd, _):
            try:
                # Validate handle before checking properties
                if (
                    win32gui.IsWindow(hwnd)
                    and win32gui.IsWindowVisible(hwnd)
                    and is_window_on_current_desktop(hwnd)
                ):
                    handles.add(hwnd)
            except Exception:
                # Skip invalid handles without logging (common during window enumeration)
                pass

        win32gui.EnumWindows(callback, None)

        if desktop_hwnd := win32gui.FindWindow("Progman", None):
            handles.add(desktop_hwnd)
        if taskbar_hwnd := win32gui.FindWindow("Shell_TrayWnd", None):
            handles.add(taskbar_hwnd)
        if secondary_taskbar_hwnd := win32gui.FindWindow("Shell_SecondaryTrayWnd", None):
            handles.add(secondary_taskbar_hwnd)
        return handles

    # Tuned retry envelope for transient UIA empty results. The OS
    # briefly returns NULL from GetForegroundWindow during focus
    # transitions, app launches, and notification overlays — three
    # attempts at 100 ms each covers the typical race without
    # noticeably slowing the snapshot path when state is steady.
    _UIA_RETRIES = 3
    _UIA_RETRY_SLEEP_MS = 100

    def get_active_window(self, windows: list[Window] | None = None) -> Window | None:
        """Return the foreground app window, retrying briefly on transient
        empty results.

        GetForegroundWindow can return NULL during focus transitions, app
        launches, and notification-overlay flicker — even when there is a
        visible focused window on screen. Without a retry, Snapshot
        reports "No active window found" and the caller is left blind.
        """
        last_error = None
        for attempt in range(self._UIA_RETRIES):
            try:
                if windows is None:
                    windows, _ = self.get_windows()
                active_window = self.get_foreground_window()
                if active_window is None:
                    # NULL foreground — retry, this often clears on the
                    # next pass once whatever was transitioning settles.
                    sleep(self._UIA_RETRY_SLEEP_MS / 1000.0)
                    continue
                if active_window.ClassName == "Progman":
                    return None
                active_window_handle = active_window.NativeWindowHandle
                for window in windows:
                    if window.handle != active_window_handle:
                        continue
                    return window
                # In case active window is not present in the windows list
                return Window(
                    **{
                        "name": active_window.Name,
                        "is_browser": self.is_window_browser(active_window),
                        "depth": 0,
                        "bounding_box": BoundingBox(
                            left=active_window.BoundingRectangle.left,
                            top=active_window.BoundingRectangle.top,
                            right=active_window.BoundingRectangle.right,
                            bottom=active_window.BoundingRectangle.bottom,
                            width=active_window.BoundingRectangle.width(),
                            height=active_window.BoundingRectangle.height(),
                        ),
                        "status": self.get_window_status(active_window),
                        "handle": active_window_handle,
                        "process_id": active_window.ProcessId,
                    }
                )
            except Exception as ex:
                last_error = ex
                # Same retry policy for transient exceptions —
                # ControlFromHandle(NULL) raises during focus transitions
                # and the next attempt usually succeeds.
                sleep(self._UIA_RETRY_SLEEP_MS / 1000.0)
                continue
        if last_error is not None:
            logger.error(
                f"Error in get_active_window after {self._UIA_RETRIES} retries: {last_error}"
            )
        return None

    def get_foreground_window(self) -> uia.Control | None:
        handle = uia.GetForegroundWindow()
        # NULL handle means no window has foreground focus right now —
        # don't pass that into ControlFromHandle, which would raise.
        if not handle:
            return None
        return self.get_window_from_element_handle(handle)

    def get_window_from_element_handle(self, element_handle: int) -> uia.Control:
        current = uia.ControlFromHandle(element_handle)
        root_handle = uia.GetRootControl().NativeWindowHandle

        while True:
            parent = current.GetParentControl()
            if parent is None or parent.NativeWindowHandle == root_handle:
                return current
            current = parent

    def get_windows(
        self, controls_handles: set[int] | None = None
    ) -> tuple[list[Window], set[int]]:
        try:
            windows = []
            window_handles = set()
            controls_handles = controls_handles or self.get_controls_handles()
            for depth, hwnd in enumerate(controls_handles):
                try:
                    child = uia.ControlFromHandle(hwnd)
                except Exception:
                    continue

                # Filter out Overlays (e.g. NVIDIA, Steam)
                if self.is_overlay_window(child):
                    continue

                if isinstance(child, (uia.WindowControl, uia.PaneControl)):
                    window_pattern = child.GetPattern(uia.PatternId.WindowPattern)
                    if window_pattern is None:
                        continue

                    if window_pattern.CanMinimize and window_pattern.CanMaximize:
                        status = self.get_window_status(child)

                        bounding_rect = child.BoundingRectangle
                        if bounding_rect.isempty() and status != Status.MINIMIZED:
                            continue

                        windows.append(
                            Window(
                                **{
                                    "name": child.Name,
                                    "depth": depth,
                                    "status": status,
                                    "bounding_box": BoundingBox(
                                        left=bounding_rect.left,
                                        top=bounding_rect.top,
                                        right=bounding_rect.right,
                                        bottom=bounding_rect.bottom,
                                        width=bounding_rect.width(),
                                        height=bounding_rect.height(),
                                    ),
                                    "handle": child.NativeWindowHandle,
                                    "process_id": child.ProcessId,
                                    "is_browser": self.is_window_browser(child),
                                }
                            )
                        )
                        window_handles.add(child.NativeWindowHandle)
        except Exception as ex:
            logger.error(f"Error in get_windows: {ex}")
            windows = []
        return windows, window_handles

    def get_screen_size(self) -> Size:
        width, height = uia.GetVirtualScreenSize()
        return Size(width=width, height=height)

    def get_screen_box(self) -> BoundingBox:
        left, top, width, height = uia.GetVirtualScreenRect()
        return BoundingBox(
            left=left,
            top=top,
            right=left + width,
            bottom=top + height,
            width=width,
            height=height,
        )

    @staticmethod
    def parse_display_selection(
        display: int | list[int] | tuple[int, ...] | None,
    ) -> list[int] | None:
        if display is None or display == "":
            return None

        if isinstance(display, bool):
            raise ValueError(
                "display must be a JSON array of zero-based active display indices, for example [0] or [0,1]"
            )

        if isinstance(display, int):
            values = [display]
        elif isinstance(display, (list, tuple)):
            values = list(display)
        else:
            raise ValueError(
                "display must be a JSON array of zero-based active display indices, for example [0] or [0,1]"
            )

        unique_values: list[int] = []
        for value in values:
            if not isinstance(value, int) or value < 0:
                raise ValueError("display must contain only zero-based active display indices")
            if value not in unique_values:
                unique_values.append(value)
        return unique_values or None

    def parse_region_selection(self, region: list[int] | tuple[int, ...] | None) -> uia.Rect | None:
        if region is None or region == "":
            return None

        if not isinstance(region, (list, tuple)) or len(region) != 4:
            raise ValueError("region must be a JSON array of 4 integers [left, top, right, bottom]")

        values = []
        for item in region:
            if isinstance(item, bool) or not isinstance(item, int):
                raise ValueError("region must contain only integers [left, top, right, bottom]")
            values.append(item)

        left, top, right, bottom = values
        if right <= left or bottom <= top:
            raise ValueError("region must satisfy right > left and bottom > top")

        candidate = uia.Rect(left, top, right, bottom)
        screen_box = self.get_screen_box()
        screen_rect = uia.Rect(screen_box.left, screen_box.top, screen_box.right, screen_box.bottom)
        overlap = candidate.intersect(screen_rect)
        if overlap.width() <= 0 or overlap.height() <= 0:
            display_lines = []
            try:
                for display in self.get_displays():
                    display_lines.append(
                        f"  display {display.index} ({display.device_name}): "
                        f"left={display.rect.left}, top={display.rect.top}, "
                        f"right={display.rect.right}, bottom={display.rect.bottom}"
                    )
            except Exception:
                pass
            bounds_detail = f"virtual screen {screen_box.xyxy_to_string()}"
            if display_lines:
                bounds_detail += ";\nvisible displays:\n" + "\n".join(display_lines)
            raise ValueError(
                f"region {region} does not overlap any visible display. "
                f"Screen bounds: {bounds_detail}"
            )

        if overlap != candidate:
            # Partially out of bounds — clip to the screen so capture succeeds;
            # the effective region is reported back in the Snapshot/Screenshot
            # metadata, so the caller always sees what was actually captured.
            logger.warning(
                f"Region {region} extends beyond the screen; clipping to {overlap}"
            )
            candidate = overlap

        return candidate

    @staticmethod
    def get_displays() -> list[uia.DisplayInfo]:
        return uia.GetDisplays()

    @staticmethod
    def _display_to_view(display: uia.DisplayInfo) -> Display:
        return Display(
            index=display.index,
            device_name=display.device_name,
            bounding_box=Desktop._rect_to_bounding_box(display.rect),
            primary=display.primary,
            effective_dpi=getattr(display, "effective_dpi", None),
            scale=getattr(display, "scale", None),
        )

    def get_display_union_rect(
        self,
        display_indices: list[int],
        displays: list[uia.DisplayInfo] | None = None,
    ) -> uia.Rect:
        displays = displays if displays is not None else self.get_displays()
        if not displays:
            logger.warning(
                "Monitor enumeration returned no monitors while display filter was requested"
            )
            raise ValueError("No displays detected")

        display_by_index = {display.index: display for display in displays}
        invalid_indices = [index for index in display_indices if index not in display_by_index]
        if invalid_indices:
            available_indices = ",".join(str(display.index) for display in displays)
            logger.warning(
                "Invalid display selection %s. Available displays: %s",
                invalid_indices,
                available_indices,
            )
            raise ValueError(
                f"Invalid display index {invalid_indices[0]}. Available displays: {available_indices}"
            )

        selected_rects = [display_by_index[index].rect for index in display_indices]
        return uia.Rect(
            left=min(rect.left for rect in selected_rects),
            top=min(rect.top for rect in selected_rects),
            right=max(rect.right for rect in selected_rects),
            bottom=max(rect.bottom for rect in selected_rects),
        )

    def get_screenshot(self, capture_rect: uia.Rect | None = None) -> Image.Image:
        flash_overlay.cancel_active_flash()
        with control_overlay.hidden_for_capture():
            image, used_backend = screenshot_capture.capture(capture_rect)
        self._last_screenshot_backend = used_backend
        if not control_overlay.is_active():
            flash_overlay.show_capture_flash(None)
        return image

    def get_annotated_screenshot(
        self,
        nodes: list[TreeElementNode],
        cursor_pos: tuple[int, int] | None = None,
        grid_lines: tuple[int, int] | None = None,
        capture_rect: uia.Rect | None = None,
    ) -> Image.Image:
        screenshot = self.get_screenshot(capture_rect=capture_rect)
        annotated_screenshot = screenshot.copy()
        draw = ImageDraw.Draw(annotated_screenshot)
        image_width, image_height = annotated_screenshot.size
        font_size = 12
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except IOError:
            font = ImageFont.load_default()

        def get_random_color():
            return "#{:06x}".format(random.randint(0, 0xFFFFFF))

        def clamp(value: float, minimum: float, maximum: float) -> float:
            return max(minimum, min(value, maximum))

        def get_label_size(text: str) -> tuple[int, int]:
            text_box = draw.textbbox((0, 0), text, font=font)
            return text_box[2] - text_box[0] + 4, text_box[3] - text_box[1] + 4

        def draw_label(text: str, x: float, y: float, color: str) -> None:
            label_width, label_height = get_label_size(text)
            label_x = int(clamp(x, 0, max(0, image_width - label_width)))
            label_y = int(clamp(y, 0, max(0, image_height - label_height)))
            draw.rectangle(
                [(label_x, label_y), (label_x + label_width, label_y + label_height)],
                fill=color,
            )
            draw.text((label_x + 2, label_y + 2), text, fill=(255, 255, 255), font=font)

        if capture_rect:
            left_offset, top_offset = capture_rect.left, capture_rect.top
        else:
            left_offset, top_offset, _, _ = uia.GetVirtualScreenRect()

        # Draw grid lines if requested, with ruler labels showing the TRUE
        # screen pixel coordinate of each line. Labels are drawn before any
        # downscale, so the value they display is the coordinate the caller
        # should pass to Click/Move — no math needed (stress-test finding: the
        # agent used to fit DPI by hand; now it can read it off the image).
        if grid_lines:
            w_count, h_count = grid_lines
            try:
                ruler_font = ImageFont.truetype("arial.ttf", 9)
            except IOError:
                ruler_font = ImageFont.load_default()
            for i in range(1, w_count):
                x = image_width * i // w_count
                draw.line([(x, 0), (x, image_height)], fill=(200, 200, 200, 128), width=1)
                draw.text((x + 2, 2), str(left_offset + x), fill=(120, 120, 120), font=ruler_font)
            for i in range(1, h_count):
                y = image_height * i // h_count
                draw.line([(0, y), (image_width, y)], fill=(200, 200, 200, 128), width=1)
                draw.text((2, y + 2), str(top_offset + y), fill=(120, 120, 120), font=ruler_font)

        def draw_annotation(label, node: TreeElementNode):
            box = node.bounding_box
            color = get_random_color()

            adjusted_left = int(box.left - left_offset)
            adjusted_top = int(box.top - top_offset)
            adjusted_right = int(box.right - left_offset)
            adjusted_bottom = int(box.bottom - top_offset)
            clipped_box = (
                int(clamp(adjusted_left, 0, image_width - 1)),
                int(clamp(adjusted_top, 0, image_height - 1)),
                int(clamp(adjusted_right, 0, image_width - 1)),
                int(clamp(adjusted_bottom, 0, image_height - 1)),
            )
            left, top, right, bottom = clipped_box
            if right <= left or bottom <= top:
                return

            draw.rectangle(clipped_box, outline=color, width=2)

            label_text = str(label)
            label_width, label_height = get_label_size(label_text)
            label_x = right - label_width
            label_y = top - label_height - 2
            if label_y < 0:
                label_y = bottom + 2
            draw_label(label_text, label_x, label_y, color)

        # Draw annotations sequentially: PIL ImageDraw is not thread-safe and
        # drawing is GIL-bound, so parallel execution adds risk without speed.
        for i, node in enumerate(nodes):
            draw_annotation(i, node)

        # Draw cursor highlight if pos provided
        if cursor_pos:
            cx, cy = cursor_pos
            acx = int(cx - left_offset)
            acy = int(cy - top_offset)

            # Draw a distinctive marker (e.g., a circle or crosshair with a box)
            r = 15
            draw.ellipse([acx - r, acy - r, acx + r, acy + r], outline="red", width=3)
            draw.line([acx - r, acy, acx + r, acy], fill="red", width=2)
            draw.line([acx, acy - r, acx, acy + r], fill="red", width=2)

            # Draw "Cursor" label
            c_label = "CURSOR"
            draw_label(c_label, acx + r, acy - r, "red")

        return annotated_screenshot

    @staticmethod
    def _rect_to_bounding_box(rect: uia.Rect | None) -> BoundingBox | None:
        if rect is None:
            return None
        return BoundingBox(
            left=rect.left,
            top=rect.top,
            right=rect.right,
            bottom=rect.bottom,
            width=rect.width(),
            height=rect.height(),
        )

    @staticmethod
    def _point_in_region(point: tuple[int, int], region: BoundingBox) -> bool:
        x, y = point
        return region.left <= x < region.right and region.top <= y < region.bottom

    @staticmethod
    def _clip_bounding_box_to_region(
        box: BoundingBox | None, region: BoundingBox
    ) -> BoundingBox | None:
        if box is None:
            return None
        left = max(box.left, region.left)
        top = max(box.top, region.top)
        right = min(box.right, region.right)
        bottom = min(box.bottom, region.bottom)
        if right <= left or bottom <= top:
            return None
        return BoundingBox(
            left=left,
            top=top,
            right=right,
            bottom=bottom,
            width=right - left,
            height=bottom - top,
        )

    def _filter_window_to_region(self, window: Window | None, region: BoundingBox) -> Window | None:
        if window is None:
            return None
        clipped_box = self._clip_bounding_box_to_region(window.bounding_box, region)
        if clipped_box is None:
            return None
        # Region selection only decides *whether* a window is listed; keep the
        # window's real bounding box so the "Opened Windows" table reports the
        # actual window dimensions instead of shrinking every overlapping window
        # to the region rectangle (e.g. a maximized app must not read "1200x600"
        # just because a 1200x600 region was captured). Element coordinates for
        # interactions come from the tree nodes, which are clipped separately.
        return Window(
            name=window.name,
            is_browser=window.is_browser,
            depth=window.depth,
            status=window.status,
            bounding_box=window.bounding_box,
            handle=window.handle,
            process_id=window.process_id,
        )

    def _filter_windows_to_region(self, windows: list[Window], region: BoundingBox) -> list[Window]:
        filtered_windows: list[Window] = []
        for window in windows:
            filtered_window = self._filter_window_to_region(window, region)
            if filtered_window is not None:
                filtered_windows.append(filtered_window)
        return filtered_windows

    def _filter_tree_node_to_region(
        self, node: TreeElementNode, region: BoundingBox
    ) -> TreeElementNode | None:
        clipped_box = self._clip_bounding_box_to_region(node.bounding_box, region)
        if clipped_box is None:
            return None
        return TreeElementNode(
            name=node.name,
            control_type=node.control_type,
            window_name=node.window_name,
            bounding_box=clipped_box,
            center=clipped_box.get_center(),
            metadata=node.metadata,
        )

    def _filter_scroll_node_to_region(self, node, region: BoundingBox):
        clipped_box = self._clip_bounding_box_to_region(node.bounding_box, region)
        if clipped_box is None:
            return None
        return node.__class__(
            name=node.name,
            control_type=node.control_type,
            window_name=node.window_name,
            bounding_box=clipped_box,
            center=clipped_box.get_center(),
            metadata=node.metadata,
        )

    def _filter_semantic_node_to_region(
        self,
        node: SemanticNode | None,
        region: BoundingBox,
    ) -> SemanticNode | None:
        if node is None:
            return None

        clipped_box = None
        if node.bounding_box is not None:
            clipped_box = self._clip_bounding_box_to_region(node.bounding_box, region)
            if clipped_box is None:
                return None

        filtered_children = []
        for child in node.children:
            filtered_child = self._filter_semantic_node_to_region(child, region)
            if filtered_child is not None:
                filtered_children.append(filtered_child)

        if node.element_type != "desktop" and clipped_box is None and not filtered_children:
            return None

        filtered_node = SemanticNode(
            control_type=node.control_type,
            element_type=node.element_type,
            name=node.name,
            window_name=node.window_name,
            center=clipped_box.get_center() if clipped_box is not None else node.center,
            bounding_box=clipped_box,
            metadata=dict(node.metadata),
        )
        filtered_node.children = filtered_children
        return filtered_node

    def _filter_tree_state_to_region(self, tree_state, region: BoundingBox):
        filtered_interactive_nodes = []
        for node in tree_state.interactive_nodes:
            filtered_node = self._filter_tree_node_to_region(node, region)
            if filtered_node is not None:
                filtered_interactive_nodes.append(filtered_node)

        filtered_scrollable_nodes = []
        for node in tree_state.scrollable_nodes:
            filtered_node = self._filter_scroll_node_to_region(node, region)
            if filtered_node is not None:
                filtered_scrollable_nodes.append(filtered_node)

        filtered_dom_node = None
        if tree_state.dom_node is not None:
            filtered_dom_node = self._filter_scroll_node_to_region(tree_state.dom_node, region)

        filtered_semantic_root = self._filter_semantic_node_to_region(
            tree_state.semantic_tree_root,
            region,
        )
        if filtered_semantic_root is not None:
            filtered_semantic_root.bounding_box = region
            filtered_semantic_root.center = region.get_center()

        return tree_state.__class__(
            status=tree_state.status,
            root_node=TreeElementNode(
                name="Desktop",
                control_type="PaneControl",
                bounding_box=region,
                center=region.get_center(),
                window_name="Desktop",
                metadata={},
            ),
            dom_node=filtered_dom_node,
            interactive_nodes=filtered_interactive_nodes,
            scrollable_nodes=filtered_scrollable_nodes,
            dom_informative_nodes=tree_state.dom_informative_nodes if filtered_dom_node else [],
            capture_sec=tree_state.capture_sec,
            semantic_tree_root=filtered_semantic_root,
            truncated=tree_state.truncated,
            element_limit=tree_state.element_limit,
        )
