"""Injectable monotonic clocks for expiry and deterministic tests."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol


class Clock(Protocol):
    def monotonic(self) -> float: ...

    def qpc_ns(self) -> int: ...


class SystemClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def qpc_ns(self) -> int:
        return time.perf_counter_ns()


@dataclass(slots=True)
class FakeClock:
    now: float = 0.0

    def monotonic(self) -> float:
        return self.now

    def qpc_ns(self) -> int:
        return int(self.now * 1_000_000_000)

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("clock cannot move backwards")
        self.now += seconds
