from windows_mcp.tree.budget import (
    DEFAULT_MAX_TREE_ELEMENTS,
    TreeElementBudget,
    resolve_max_tree_elements,
)


class TestTreeElementBudget:
    def test_starts_unexhausted(self):
        budget = TreeElementBudget(limit=3)
        assert budget.exhausted is False
        assert budget.truncated is False
        assert budget.remaining == 3

    def test_try_consume_under_limit(self):
        budget = TreeElementBudget(limit=3)
        assert budget.try_consume() is True
        assert budget.count == 1
        assert budget.truncated is False

    def test_try_consume_reaching_limit_marks_truncated(self):
        budget = TreeElementBudget(limit=2)
        assert budget.try_consume() is True
        assert budget.try_consume() is True
        assert budget.exhausted is True
        assert budget.truncated is True

    def test_try_consume_beyond_limit_returns_false(self):
        budget = TreeElementBudget(limit=1)
        assert budget.try_consume() is True
        assert budget.try_consume() is False
        assert budget.count == 1
        assert budget.truncated is True

    def test_try_consume_batch_exceeding_remaining(self):
        budget = TreeElementBudget(limit=5)
        assert budget.try_consume(3) is True
        assert budget.try_consume(10) is False
        assert budget.count == 5
        assert budget.truncated is True

    def test_try_consume_zero_amount_does_not_change_count(self):
        budget = TreeElementBudget(limit=5)
        assert budget.try_consume(0) is True
        assert budget.count == 0

    def test_limit_is_clamped_to_at_least_one(self):
        budget = TreeElementBudget(limit=0)
        assert budget.limit == 1

    def test_remaining_never_negative(self):
        budget = TreeElementBudget(limit=2)
        budget.try_consume(10)
        assert budget.remaining == 0
        assert budget.count == 2


class TestResolveMaxTreeElements:
    def test_default_when_unset(self):
        assert resolve_max_tree_elements({}) == DEFAULT_MAX_TREE_ELEMENTS

    def test_default_when_blank(self):
        assert (
            resolve_max_tree_elements({"WINDOWS_MCP_MAX_TREE_ELEMENTS": "  "})
            == DEFAULT_MAX_TREE_ELEMENTS
        )

    def test_valid_override(self):
        assert resolve_max_tree_elements({"WINDOWS_MCP_MAX_TREE_ELEMENTS": "150"}) == 150

    def test_invalid_value_falls_back_to_default(self):
        assert (
            resolve_max_tree_elements({"WINDOWS_MCP_MAX_TREE_ELEMENTS": "not-a-number"})
            == DEFAULT_MAX_TREE_ELEMENTS
        )

    def test_zero_falls_back_to_default(self):
        assert resolve_max_tree_elements({"WINDOWS_MCP_MAX_TREE_ELEMENTS": "0"}) == DEFAULT_MAX_TREE_ELEMENTS

    def test_negative_falls_back_to_default(self):
        assert resolve_max_tree_elements({"WINDOWS_MCP_MAX_TREE_ELEMENTS": "-5"}) == DEFAULT_MAX_TREE_ELEMENTS


class TestWindowSlice:
    """Known-2 escape hatch: per-window time slices inside one capture."""

    @staticmethod
    def _budget_with_clock():
        state = {"now": 0.0}

        def clock():
            return state["now"]

        return state, TreeElementBudget(limit=500, time_budget_seconds=30.0, clock=clock)

    def test_window_slice_fires_exhausted_without_global_flags(self):
        state, budget = self._budget_with_clock()
        budget.begin_window(10.0)
        assert budget.window_exhausted is False
        state["now"] = 11.0
        assert budget.window_exhausted is True
        # The window slice must trip the shared stop predicate so the
        # traversal's existing poll points honor it...
        assert budget.exhausted is True
        # ...but it is not a global truncation: other windows still crawl.
        assert budget.time_truncated is False
        assert budget.truncated is False

    def test_end_window_clears_slice(self):
        state, budget = self._budget_with_clock()
        budget.begin_window(10.0)
        state["now"] = 11.0
        budget.end_window()
        assert budget.window_exhausted is False
        assert budget.exhausted is False

    def test_begin_window_none_means_no_deadline(self):
        state, budget = self._budget_with_clock()
        budget.begin_window(None)
        state["now"] = 1000.0
        assert budget.window_exhausted is False

    def test_try_consume_during_window_expiry_records_no_global_flag(self):
        state, budget = self._budget_with_clock()
        budget.begin_window(10.0)
        state["now"] = 11.0
        assert budget.try_consume() is False
        assert budget.truncated is False
        assert budget.time_truncated is False

    def test_global_time_budget_still_flags_when_its_own_deadline_passes(self):
        state, budget = self._budget_with_clock()
        budget.begin_window(5.0)
        budget.end_window()
        state["now"] = 31.0
        assert budget.exhausted is True
        assert budget.time_truncated is True


class TestResolveMaxWindowSeconds:
    def test_unset_means_no_cap(self):
        from windows_mcp.tree.budget import resolve_max_window_seconds

        assert resolve_max_window_seconds({}) is None

    def test_valid_value_is_cap(self):
        from windows_mcp.tree.budget import resolve_max_window_seconds

        assert resolve_max_window_seconds({"WINDOWS_MCP_MAX_WINDOW_SECONDS": "8"}) == 8.0
        assert resolve_max_window_seconds({"WINDOWS_MCP_MAX_WINDOW_SECONDS": " 5 "}) == 5.0

    def test_invalid_values_fall_back_to_no_cap(self):
        from windows_mcp.tree.budget import resolve_max_window_seconds

        for raw in ("", "   ", "abc", "0", "-3"):
            assert resolve_max_window_seconds({"WINDOWS_MCP_MAX_WINDOW_SECONDS": raw}) is None


class TestWindowSliceSeconds:
    def _budget(self, time_budget_seconds=30.0, now=0.0):
        state = {"now": now}
        budget = TreeElementBudget(
            limit=500, time_budget_seconds=time_budget_seconds, clock=lambda: state["now"]
        )
        return state, budget

    def test_fair_share_of_remaining_budget(self):
        from windows_mcp.tree.budget import window_slice_seconds

        _, budget = self._budget()
        assert window_slice_seconds(budget, 5, env={}) == 6.0

    def test_single_window_gets_full_remaining(self):
        from windows_mcp.tree.budget import window_slice_seconds

        _, budget = self._budget()
        assert window_slice_seconds(budget, 1, env={}) == 30.0

    def test_env_cap_limits_the_share(self):
        from windows_mcp.tree.budget import window_slice_seconds

        _, budget = self._budget()
        assert (
            window_slice_seconds(budget, 1, env={"WINDOWS_MCP_MAX_WINDOW_SECONDS": "3"})
            == 3.0
        )

    def test_no_global_deadline_and_no_cap_means_no_slice(self):
        from windows_mcp.tree.budget import TreeElementBudget as B
        from windows_mcp.tree.budget import window_slice_seconds

        budget = B(limit=500, time_budget_seconds=0, clock=lambda: 0.0)
        assert window_slice_seconds(budget, 3, env={}) is None

    def test_no_global_deadline_with_cap_returns_cap(self):
        from windows_mcp.tree.budget import TreeElementBudget as B
        from windows_mcp.tree.budget import window_slice_seconds

        budget = B(limit=500, time_budget_seconds=0, clock=lambda: 0.0)
        assert (
            window_slice_seconds(budget, 3, env={"WINDOWS_MCP_MAX_WINDOW_SECONDS": "4"})
            == 4.0
        )

    def test_elapsed_time_shrinks_the_share(self):
        from windows_mcp.tree.budget import window_slice_seconds

        state, budget = self._budget()
        state["now"] = 20.0  # 10s of the 30s budget already burned
        assert window_slice_seconds(budget, 2, env={}) == 5.0
