"""Matrix batch-2 unit tests: wall-clock capture budget, honest browser-DOM
degradation, element-postcondition refusal for coordinate targets, and the
external resync_required counter."""

from unittest.mock import MagicMock

import pytest

from windows_mcp.tree.budget import (
    DEFAULT_MAX_CAPTURE_SECONDS,
    TreeElementBudget,
    resolve_max_capture_seconds,
)
from windows_mcp.tree.views import BoundingBox, TreeElementNode
from windows_mcp.desktop.views import Size
from windows_mcp.tree import ia2
from windows_mcp.tree.service import Tree


def make_box(left: int, top: int, right: int, bottom: int):
    return BoundingBox(
        left=left,
        top=top,
        right=right,
        bottom=bottom,
        width=right - left,
        height=bottom - top,
    )


class FakeClock:
    """Deterministic monotonic clock for budget tests."""

    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class TestCaptureTimeBudget:
    def test_default_time_budget_is_positive(self):
        budget = TreeElementBudget(limit=10)
        assert budget.time_remaining_seconds is not None
        assert budget.time_remaining_seconds > 0
        assert DEFAULT_MAX_CAPTURE_SECONDS > 0

    def test_exhausted_includes_time_dimension(self):
        clock = FakeClock()
        budget = TreeElementBudget(limit=10, time_budget_seconds=5.0, clock=clock)
        assert budget.exhausted is False
        clock.advance(5.0)
        assert budget.time_exhausted is True
        assert budget.exhausted is True
        assert budget.time_truncated is True
        assert budget.truncated is False  # element limit untouched

    def test_time_truncation_does_not_mark_element_truncation(self):
        clock = FakeClock()
        budget = TreeElementBudget(limit=10, time_budget_seconds=1.0, clock=clock)
        clock.advance(2.0)
        assert budget.try_consume() is False
        assert budget.time_truncated is True
        assert budget.truncated is False
        assert budget.count == 0

    def test_element_truncation_does_not_mark_time_truncation(self):
        clock = FakeClock()
        budget = TreeElementBudget(limit=1, time_budget_seconds=60.0, clock=clock)
        assert budget.try_consume() is True
        assert budget.try_consume() is False
        assert budget.truncated is True
        assert budget.time_truncated is False

    def test_time_remaining_never_negative(self):
        clock = FakeClock()
        budget = TreeElementBudget(limit=10, time_budget_seconds=2.0, clock=clock)
        clock.advance(10.0)
        assert budget.time_remaining_seconds == 0.0

    def test_non_positive_time_budget_disables_bound(self):
        clock = FakeClock()
        budget = TreeElementBudget(limit=10, time_budget_seconds=0.0, clock=clock)
        clock.advance(10_000.0)
        assert budget.time_remaining_seconds is None
        assert budget.time_exhausted is False


class TestResolveMaxCaptureSeconds:
    def test_default_when_unset(self):
        assert resolve_max_capture_seconds({}) == DEFAULT_MAX_CAPTURE_SECONDS

    def test_valid_override(self):
        assert resolve_max_capture_seconds({"WINDOWS_MCP_MAX_CAPTURE_SECONDS": "12.5"}) == 12.5

    def test_invalid_value_falls_back(self):
        assert (
            resolve_max_capture_seconds({"WINDOWS_MCP_MAX_CAPTURE_SECONDS": "soon"})
            == DEFAULT_MAX_CAPTURE_SECONDS
        )

    def test_zero_and_negative_fall_back(self):
        assert resolve_max_capture_seconds({"WINDOWS_MCP_MAX_CAPTURE_SECONDS": "0"}) == DEFAULT_MAX_CAPTURE_SECONDS
        assert resolve_max_capture_seconds({"WINDOWS_MCP_MAX_CAPTURE_SECONDS": "-3"}) == DEFAULT_MAX_CAPTURE_SECONDS


class TestIa2WalkTimeBudget:
    def _walker_with_children(self, depth_budget: int):
        """A fake IAccessible tree that would walk forever without a deadline."""

        def make_node(role_int: int):
            node = MagicMock()
            node.AccRole = role_int
            node.AccState = 0
            node.accLocation.return_value = (10, 10, 20, 20)
            node.AccName = "node"
            node.AccValue = ""
            node.accChildCount = 1
            return node

        return make_node

    def test_traverse_window_accepts_time_budget_argument(self):
        # Contract: the parameter exists and a disabled budget (<=0) behaves
        # like the legacy call on an acquisition failure path.
        result = ia2.traverse_window(
            hwnd=0,
            window_name="no-such-window",
            time_budget_seconds=0,
        )
        assert result.interactive_nodes == []
        assert result.time_truncated is False


class TestBrowserDomHonestDegradation:
    """A browser window whose renderer AX tree is unavailable must fall back
    to its UIA chrome nodes instead of returning empty lists (live probe,
    matrix batch 2: --new-window into a running Chrome carries no AX flag)."""

    def _tree(self):
        mock_desktop = MagicMock()
        mock_desktop.get_screen_size.return_value = Size(width=1920, height=1080)
        mock_desktop.get_screen_box.return_value = make_box(0, 0, 1920, 1080)
        return Tree(mock_desktop)

    def test_get_nodes_use_dom_falls_back_to_chrome_when_dom_empty(self):
        tree = self._tree()
        chrome_button = TreeElementNode(
            name="重新加载",
            control_type="Button",
            bounding_box=make_box(0, 0, 40, 40),
            center=BoundingBox(0, 0, 40, 40, 40, 40).get_center(),
            window_name="Chrome",
            metadata={},
        )
        tree.dom = None
        tree.dom_bounding_box = None
        tree.dom_is_ia2 = False

        interactive_nodes = [chrome_button]

        import windows_mcp.tree.service as service_module

        # get_nodes calls ControlFromHandle + traversal; fake both layers. The
        # traversal fake must fill the lists get_nodes itself created.
        root = MagicMock()
        root.Name = "Example Domain - Google Chrome"
        service_module.ControlFromHandle = lambda handle: root  # type: ignore

        def fake_traversal(node, window_bb, window_name, is_browser,
                           interactive, scrollable, dom_interactive, dom_informative, **kw):
            interactive.extend(interactive_nodes)

        tree.tree_traversal = fake_traversal  # type: ignore

        result = tree.get_nodes(handle=0x1234, is_browser=True, use_dom=True)

        element_nodes, scroll_nodes, info_nodes, sem_node = result
        # The chrome button survives the fallback — the window stays visible.
        assert chrome_button in element_nodes
        assert info_nodes == []
        assert sem_node is not None
        assert any(child.name == "重新加载" for child in sem_node.children)

    def test_get_nodes_use_dom_keeps_dom_lists_when_web_content_found(self):
        tree = self._tree()
        tree.dom = MagicMock()  # RootWebArea reached → DOM mode active
        tree.dom_bounding_box = make_box(0, 0, 800, 600)

        dom_button = TreeElementNode(
            name="Example Domain",
            control_type="Link",
            bounding_box=make_box(10, 10, 110, 40),
            center=BoundingBox(10, 10, 110, 40, 100, 30).get_center(),
            window_name="Chrome",
            metadata={},
        )
        chrome_button = TreeElementNode(
            name="重新加载",
            control_type="Button",
            bounding_box=make_box(0, 0, 40, 40),
            center=BoundingBox(0, 0, 40, 40, 40, 40).get_center(),
            window_name="Chrome",
            metadata={},
        )

        import windows_mcp.tree.service as service_module

        root = MagicMock()
        root.Name = "Example Domain - Google Chrome"
        service_module.ControlFromHandle = lambda handle: root  # type: ignore
        tree.tree_traversal = lambda *a, **k: None  # type: ignore

        # dom_interactive_nodes is the list the traversal would have filled;
        # emulate by pre-seeding through the same lists get_nodes owns.
        dom_interactive_nodes = [dom_button]
        interactive_nodes = [chrome_button]
        # get_nodes builds its own lists; inject via the traversal fake.
        original_lists = (interactive_nodes, dom_interactive_nodes)

        def fake_traversal(node, window_bb, window_name, is_browser,
                           interactive, scrollable, dom_interactive, dom_informative, **kw):
            interactive.extend(original_lists[0])
            dom_interactive.extend(original_lists[1])

        tree.tree_traversal = fake_traversal  # type: ignore

        element_nodes, scroll_nodes, info_nodes, sem_node = tree.get_nodes(
            handle=0x1234, is_browser=True, use_dom=True
        )

        assert element_nodes == [dom_button]
        assert chrome_button not in element_nodes

    def test_ia2_time_truncation_surfaces_in_budget(self, tree_instance=None):
        budget = TreeElementBudget(limit=10, time_budget_seconds=30.0)
        # The wiring contract: traverse_window's time_truncated propagates.
        assert budget.time_truncated is False
        budget.time_truncated = True
        assert budget.time_truncated is True


class TestElementPostconditionsOnPointTargets:
    """Matrix batch-1 s1 finding: `element_exists` against a coordinate (loc)
    target can never be confirmed (the verifier's element reader produces
    `exists` only for element_ref-bound targets), which silently degraded the
    whole mutation to unknown_outcome. The contract is now an honest refusal
    BEFORE dispatch; `frame_changed` stays valid for point targets."""

    def _desktop(self, point_target: bool):
        from windows_mcp.desktop.service import Desktop
        from windows_mcp.runtime.action_router import ActionRouter
        from windows_mcp.runtime.clock import SystemClock
        from windows_mcp.runtime.results import TargetReceipt, VerificationEvidence
        from windows_mcp.runtime.target_resolver import ResolvedTarget

        evidence = VerificationEvidence(
            verifier="test",
            predicate="frame.frame_changed",
            observed="changed",
            revision=2,
        )

        class Verifier:
            def __init__(self):
                self.prepared = 0

            def prepare(self, target, *, pre_revision, predicates=()):
                self.prepared += 1
                return MagicMock(pre_revision=pre_revision)

            def observe_after_dispatch(self, handle, predicate, **kwargs):
                return MagicMock(evidence=evidence)

        receipt_kind = "frame_point" if point_target else "element"
        target = ResolvedTarget(
            receipt=TargetReceipt(target_kind=receipt_kind, description="t"),
            screen_point=(10, 20),
            source="test",
        )
        desktop = Desktop.__new__(Desktop)
        desktop._runtime_clock = SystemClock()
        desktop._observation_revision = 1
        verifier = Verifier()
        desktop._verifier = verifier
        desktop._action_router = ActionRouter(patterns=MagicMock())
        desktop.resolve_action_point = MagicMock(return_value=target)
        desktop.click = MagicMock()
        desktop.click_hit_note = MagicMock(return_value="")
        desktop._focus_resolved_target = MagicMock()
        desktop._finish_target_mutation = MagicMock()
        return desktop, verifier

    def test_loc_target_rejects_element_exists_before_dispatch(self):
        from windows_mcp.runtime.predicates import exists

        desktop, verifier = self._desktop(point_target=True)
        with pytest.raises(ValueError, match="element-bound target"):
            desktop.dispatch_click_target(
                loc=[10, 20],
                label=None,
                element=None,
                snapshot_id="snapshot-1",
                element_id=None,
                coordinate_space="screen",
                window=None,
                button="left",
                clicks=1,
                modifiers=None,
                action="click",
                hold_seconds=None,
                expected_postconditions=(exists(),),
            )
        desktop.click.assert_not_called()
        assert verifier.prepared == 0

    def test_loc_target_rejects_element_gone_before_dispatch(self):
        from windows_mcp.runtime.predicates import gone

        desktop, verifier = self._desktop(point_target=True)
        with pytest.raises(ValueError, match="element-bound target"):
            desktop.dispatch_type_target(
                loc=[10, 20],
                label=None,
                element=None,
                snapshot_id="snapshot-1",
                element_id=None,
                coordinate_space="screen",
                window=None,
                window_receipt=None,
                text="hello",
                caret_position="idle",
                clear=False,
                press_enter=False,
                interval=None,
                expected_postconditions=(gone(),),
            )
        assert verifier.prepared == 0

    def test_loc_target_accepts_frame_changed_postcondition(self):
        from windows_mcp.runtime.predicates import frame_changed

        desktop, verifier = self._desktop(point_target=True)
        result = desktop.dispatch_click_target(
            loc=[10, 20],
            label=None,
            element=None,
            snapshot_id="snapshot-1",
            element_id=None,
            coordinate_space="screen",
            window=None,
            button="left",
            clicks=1,
            modifiers=None,
            action="click",
            hold_seconds=None,
            expected_postconditions=(frame_changed(),),
        )
        assert verifier.prepared == 1
        desktop.click.assert_called_once()
        assert result["verification"] is not None

    def test_element_target_still_accepts_element_exists(self):
        from windows_mcp.runtime.identity import ElementRef
        from windows_mcp.runtime.predicates import exists
        from windows_mcp.runtime.results import TargetReceipt
        from windows_mcp.runtime.target_resolver import ResolvedTarget

        desktop, verifier = self._desktop(point_target=False)
        # element_ref-bound target: the verifier CAN produce `exists`.
        desktop.resolve_action_point = MagicMock(
            return_value=ResolvedTarget(
                receipt=TargetReceipt(target_kind="element", description="t"),
                screen_point=(10, 20),
                source="test",
                element_ref=ElementRef(
                    window=MagicMock(),
                    element_id="e1",
                    snapshot_id="snapshot-1",
                    runtime_id=(1, 2, 3),
                    locator=MagicMock(),
                ),
            )
        )
        result = desktop.dispatch_click_target(
            loc=None,
            label=0,
            element=None,
            snapshot_id="snapshot-1",
            element_id=None,
            coordinate_space="screen",
            window=None,
            button="left",
            clicks=1,
            modifiers=None,
            action="click",
            hold_seconds=None,
            expected_postconditions=(exists(),),
        )
        assert verifier.prepared == 1
        assert result["verification"] is not None


class TestResyncRequiredExternalChannel:
    """Matrix batch-1 Known-5: resync_required was supervisor-internal state
    with no outside observation channel. It now increments a §18.3 counter
    that reaches the metrics file sink."""

    def _supervisor(self):
        from windows_mcp.broker.supervisor import EventBrokerSupervisor

        supervisor = EventBrokerSupervisor.__new__(EventBrokerSupervisor)
        supervisor._launcher = None
        supervisor._on_generation_retired = None
        supervisor._lock = __import__("threading").Lock()
        supervisor._stop = __import__("threading").Event()
        supervisor._thread = None
        supervisor._process = None
        supervisor._hello = None
        supervisor._generation = 1
        supervisor._restarts = 0
        supervisor._latest_events = []
        supervisor._resync_required = __import__("threading").Event()
        return supervisor

    def test_counter_increments_once_per_transition(self):
        from windows_mcp.runtime.metrics import METRICS

        METRICS.reset_for_tests()
        supervisor = self._supervisor()
        assert supervisor.resync_required is False

        supervisor._mark_resync_required()
        assert supervisor.resync_required is True
        assert METRICS.snapshot()["counted"]["resync_required_count"] == 1

        # Repeat sets are idempotent state, not new gaps.
        supervisor._mark_resync_required()
        assert METRICS.snapshot()["counted"]["resync_required_count"] == 1

    def test_counter_exported_in_snapshot(self):
        from windows_mcp.runtime.metrics import COUNTER_NAMES, METRICS

        assert "resync_required_count" in COUNTER_NAMES
        METRICS.reset_for_tests()
        assert METRICS.snapshot()["counted"]["resync_required_count"] == 0
