"""A dispatch-local stop signal checked before each native input primitive."""

from contextlib import contextmanager
from contextvars import ContextVar
from threading import Event
from typing import Callable


class InputCancelled(RuntimeError):
    """The user stopped a possibly partially dispatched input sequence."""


class ControlCancellation:
    def __init__(self, escape_requested: Callable[[], bool] | None = None, *, escape_available=False):
        self._stopped = Event()
        self._escape_requested = escape_requested
        self.escape_available = escape_available
        self._held: dict[tuple, Callable[[], None]] = {}

    def cancel(self):
        self._stopped.set()

    def requested(self):
        return self._stopped.is_set() or bool(self._escape_requested and self._escape_requested())

    def record_input(self, identity, release, *, pressed):
        if pressed:
            self._held[identity] = release
        else:
            self._held.pop(identity, None)

    def release_all(self):
        """Called by the actor after the cancellation scope has been removed."""
        failure = None
        for identity, release in reversed(tuple(self._held.items())):
            try:
                release()
            except Exception as exc:
                failure = exc
            finally:
                self._held.pop(identity, None)
        if failure is not None:
            raise RuntimeError("failed to release all dispatched input") from failure


_current: ContextVar[ControlCancellation | None] = ContextVar("desktop_input_cancellation", default=None)


@contextmanager
def cancellable_input(cancellation: ControlCancellation):
    token = _current.set(cancellation)
    try:
        check_input_cancelled()
        yield
    finally:
        _current.reset(token)


def check_input_cancelled(*, releasing=False):
    cancellation = _current.get()
    if not releasing and cancellation is not None and cancellation.requested():
        raise InputCancelled("user stopped computer control; earlier input may already have been dispatched")


def record_dispatched_input(identity, release, *, pressed):
    cancellation = _current.get()
    if cancellation is not None:
        cancellation.record_input(identity, release, pressed=pressed)
