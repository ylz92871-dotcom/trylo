"""Bounds how many UI elements a single tree capture may collect — and how
long the capture may take.

Some applications expose enormous flat lists/grids through UI Automation
(e.g. an unfiltered inventory grid with thousands of rows). Walking and
serializing every row can stall the target application for minutes and can
produce a response too large for the calling client to handle. TreeElementBudget
gives Tree.get_state a cheap, dependency-free way to stop early once a
configurable element count is reached, while still returning a partial —
clearly marked as truncated — result instead of hanging or failing outright.

Live matrix batch 1 (s2/s5) added the time dimension: a Chromium renderer
with accessibility forced on can make every cross-process UIA/COM call so
slow that even a few hundred elements exceed the observation deadline. The
element count alone cannot bound wall-clock time, so the budget also carries
a time limit that callers poll between recursion levels. Like the count, the
time limit only ever degrades to an honestly-marked partial capture."""

from __future__ import annotations

import logging
import os
import time
from typing import Callable

logger = logging.getLogger(__name__)

DEFAULT_MAX_TREE_ELEMENTS = 500

#: Wall-clock ceiling for one tree capture, in seconds. Healthy captures on
#: the live matrix finish in ~2.5s; the ceiling exists so a pathologically
#: slow UIA provider (Chromium AX crawl, batch-1 s5 finding) degrades to a
#: truncated capture instead of wedging the single desktop-actor lane past
#: every caller's deadline. 20s (not more) because one tool call can stack
#: resolve + dispatch + verify, each of which may build an observation —
#: three 20s captures still fit the 120s actor call budget.
DEFAULT_MAX_CAPTURE_SECONDS = 20.0


def resolve_max_capture_seconds(env: "os._Environ[str] | dict[str, str] | None" = None) -> float:
    """Read the tree-capture wall-clock limit from the environment.

    Non-positive, blank, or unparseable values fall back to the default —
    the time bound is a resilience floor, not a tuning knob callers should
    be able to switch off by accident.
    """
    source = os.environ if env is None else env
    raw = source.get("WINDOWS_MCP_MAX_CAPTURE_SECONDS", "")
    if not raw.strip():
        return DEFAULT_MAX_CAPTURE_SECONDS
    try:
        parsed = float(raw.strip())
    except ValueError:
        logger.warning(
            "Invalid WINDOWS_MCP_MAX_CAPTURE_SECONDS value %r, using default %s",
            raw,
            DEFAULT_MAX_CAPTURE_SECONDS,
        )
        return DEFAULT_MAX_CAPTURE_SECONDS
    if parsed <= 0:
        logger.warning(
            "WINDOWS_MCP_MAX_CAPTURE_SECONDS %r must be > 0, using default %s",
            parsed,
            DEFAULT_MAX_CAPTURE_SECONDS,
        )
        return DEFAULT_MAX_CAPTURE_SECONDS
    return parsed


def resolve_max_tree_elements(env: "os._Environ[str] | dict[str, str] | None" = None) -> int:
    """Read the tree-capture element limit from the environment.

    Args:
        env: Mapping to read from. Defaults to ``os.environ``.

    Returns:
        The configured limit, or ``DEFAULT_MAX_TREE_ELEMENTS`` if the
        variable is unset, blank, non-numeric, or not a positive integer.
    """
    source = os.environ if env is None else env
    raw = source.get("WINDOWS_MCP_MAX_TREE_ELEMENTS", "")
    if not raw.strip():
        return DEFAULT_MAX_TREE_ELEMENTS
    try:
        parsed = int(raw.strip())
    except ValueError:
        logger.warning(
            "Invalid WINDOWS_MCP_MAX_TREE_ELEMENTS value %r, using default %d",
            raw,
            DEFAULT_MAX_TREE_ELEMENTS,
        )
        return DEFAULT_MAX_TREE_ELEMENTS
    if parsed < 1:
        logger.warning(
            "WINDOWS_MCP_MAX_TREE_ELEMENTS %r must be >= 1, using default %d",
            parsed,
            DEFAULT_MAX_TREE_ELEMENTS,
        )
        return DEFAULT_MAX_TREE_ELEMENTS
    return parsed


#: A window whose fair-share slice falls below this floor gets abandoned
#: before the crawl starts — a meaningful UIA walk cannot complete in less,
#: so starting one would only burn the shared clock (Known-2, night batch).
MIN_WINDOW_SLICE_SECONDS = 2.0


def resolve_max_window_seconds(env: "os._Environ[str] | dict[str, str] | None" = None) -> float | None:
    """Read the optional per-window slice ceiling from the environment.

    The default isolation is a fair share (remaining global budget divided by
    the windows still to crawl). ``WINDOWS_MCP_MAX_WINDOW_SECONDS`` caps that
    share from above for operators who want a harder bound on any single
    window. Unset or blank means "no cap beyond the fair share"; invalid or
    non-positive values warn and fall back to no cap — the cap is a tuning
    knob, not a resilience floor (the fair share already bounds the damage).
    """
    source = os.environ if env is None else env
    raw = source.get("WINDOWS_MCP_MAX_WINDOW_SECONDS", "")
    if not raw.strip():
        return None
    try:
        parsed = float(raw.strip())
    except ValueError:
        logger.warning(
            "Invalid WINDOWS_MCP_MAX_WINDOW_SECONDS value %r, ignoring the cap", raw
        )
        return None
    if parsed <= 0:
        logger.warning(
            "WINDOWS_MCP_MAX_WINDOW_SECONDS %r must be > 0, ignoring the cap", parsed
        )
        return None
    return parsed


def window_slice_seconds(
    budget: "TreeElementBudget",
    windows_remaining: int,
    env: "os._Environ[str] | dict[str, str] | None" = None,
) -> float | None:
    """Compute the time slice for one window's crawl (Known-2 isolation).

    Fair share of the remaining global budget — ``remaining / windows_left`` —
    optionally capped by ``WINDOWS_MCP_MAX_WINDOW_SECONDS``. With no global
    deadline and no cap configured there is no slice (``None``): the caller
    then behaves exactly as before this escape hatch existed.
    """
    remaining = budget.time_remaining_seconds
    cap = resolve_max_window_seconds(env)
    if remaining is None:
        return cap
    share = remaining / max(1, windows_remaining)
    return min(share, cap) if cap is not None else share


class TreeElementBudget:
    """Tracks how many output-affecting elements a tree traversal has captured,
    and enforces the capture's wall-clock ceiling.

    ``exhausted`` is the single stop predicate callers poll between recursion
    levels: it is true when the element limit is reached OR the time budget
    ran out. The two truncation reasons are recorded separately
    (``truncated`` for the element limit, ``time_truncated`` for the clock)
    so the honest-degradation note can say which one fired.
    """

    def __init__(
        self,
        limit: int = DEFAULT_MAX_TREE_ELEMENTS,
        *,
        time_budget_seconds: float = DEFAULT_MAX_CAPTURE_SECONDS,
        clock: "Callable[[], float] | None" = None,
        start_monotonic: float | None = None,
    ) -> None:
        self.limit = max(1, limit)
        self.count = 0
        self.truncated = False
        self.time_truncated = False
        self._time_budget_seconds = time_budget_seconds
        self._clock = clock if clock is not None else time.monotonic
        self._window_deadline: float | None = None
        started = start_monotonic if start_monotonic is not None else self._clock()
        self._deadline: float | None = (
            started + time_budget_seconds if time_budget_seconds > 0 else None
        )

    @property
    def time_remaining_seconds(self) -> float | None:
        if self._deadline is None:
            return None
        return max(0.0, self._deadline - self._clock())

    @property
    def time_exhausted(self) -> bool:
        if self.time_truncated:
            return True
        if self._deadline is None:
            return False
        if self._clock() >= self._deadline:
            self.time_truncated = True
            logger.warning(
                "[Tree] Capture exceeded the %.1fs wall-clock budget — "
                "truncating honestly (raise WINDOWS_MCP_MAX_CAPTURE_SECONDS "
                "or narrow the view).",
                self._time_budget_seconds,
            )
            return True
        return False

    def begin_window(self, slice_seconds: float | None) -> None:
        """Start a per-window time slice (Known-2 escape hatch).

        While a slice is active, `exhausted` also fires when the slice's
        deadline passes — the tree traversal's existing poll points then stop
        descending into that window without touching the global truncation
        flags. `end_window` clears the slice. `slice_seconds=None` (no global
        budget and no cap configured) means no window deadline.
        """
        self._window_deadline = (
            self._clock() + slice_seconds
            if slice_seconds is not None and slice_seconds > 0
            else None
        )

    def end_window(self) -> None:
        self._window_deadline = None

    @property
    def window_exhausted(self) -> bool:
        """True once the current window's slice has run out. Unlike the
        global clock this records no permanent flag — the caller decides to
        abandon the window and logs it with the handle context."""
        return (
            self._window_deadline is not None
            and self._clock() >= self._window_deadline
        )

    @property
    def exhausted(self) -> bool:
        return (
            self.count >= self.limit
            or self.window_exhausted
            or self.time_exhausted
        )

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.count)

    def try_consume(self, amount: int = 1) -> bool:
        """Register `amount` newly captured elements.

        Returns False (and marks the budget truncated) once the limit is
        reached; the caller should then stop appending/recursing further.
        `count` is hard-capped at `limit` — a single over-large `amount`
        cannot push it past the configured budget.
        """
        if amount <= 0:
            return not self.exhausted
        if self.exhausted:
            if self.time_exhausted:
                self.time_truncated = True
            elif not self.window_exhausted:
                self.truncated = True
            # A window-slice expiry records no global flag: the caller logs
            # the abandonment and moves on to the next window.
            return False
        if amount > self.remaining:
            self.count = self.limit
            self.truncated = True
            return False
        self.count += amount
        if self.count >= self.limit:
            self.truncated = True
        return True
