"""Commands exchanged with the single-threaded desktop actor."""

from __future__ import annotations

from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ActorCommand:
    method: str
    args: tuple[Any, ...]
    kwargs: dict[str, Any]
    deadline_monotonic: float | None
    read_attribute: bool = False
    future: Future[Any] = field(default_factory=Future)


class ActorClosedError(RuntimeError):
    pass


class ActorDeadlineExceeded(TimeoutError):
    pass
