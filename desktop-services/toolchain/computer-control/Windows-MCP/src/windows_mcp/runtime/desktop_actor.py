"""A single, owner-thread execution lane for Desktop/UIA/COM operations."""

from __future__ import annotations

import asyncio
import queue
import threading
import time
import logging
from collections.abc import Callable
from concurrent.futures import Future, TimeoutError as FutureTimeout
from typing import Any, Generic, TypeVar

from windows_mcp.runtime.commands import (
    ActorClosedError,
    ActorCommand,
    ActorDeadlineExceeded,
)

T = TypeVar("T")
_STOP = object()
logger = logging.getLogger(__name__)


class DesktopActor(Generic[T]):
    """Construct and use a desktop service exclusively on one STA-ready thread.

    The service factory runs inside the actor.  Callers may originate on any
    asyncio worker thread, but all service attribute reads and method calls are
    serialized through this lane.
    """

    def __init__(
        self,
        service_factory: Callable[[], T],
        *,
        startup_timeout: float = 10.0,
        thread_name: str = "windows-mcp-desktop-actor",
    ) -> None:
        self._factory = service_factory
        self._queue: queue.Queue[ActorCommand | object] = queue.Queue()
        self._ready: Future[None] = Future()
        self._state_lock = threading.Lock()
        self._accepting = True
        self._service: T | None = None
        self._owner_thread_id: int | None = None
        self._thread = threading.Thread(
            target=self._run,
            name=thread_name,
            daemon=True,
        )
        self._thread.start()
        try:
            self._ready.result(timeout=startup_timeout)
        except FutureTimeout as exc:
            self.shutdown(timeout=1.0)
            raise TimeoutError("desktop actor startup timed out") from exc

    @property
    def owner_thread_id(self) -> int:
        if self._owner_thread_id is None:
            raise ActorClosedError("desktop actor did not initialize")
        return self._owner_thread_id

    def _run(self) -> None:
        self._owner_thread_id = threading.get_ident()
        apartment_initialized = False
        try:
            try:
                import comtypes

                comtypes.CoInitializeEx()
                apartment_initialized = True
            except ImportError:
                # Pure unit-test/non-Windows services do not require COM.
                pass
            self._service = self._factory()
        except BaseException as exc:
            self._ready.set_exception(exc)
            with self._state_lock:
                self._accepting = False
            if apartment_initialized:
                comtypes.CoUninitialize()
            return
        self._ready.set_result(None)

        try:
            while True:
                item = self._queue.get()
                if item is _STOP:
                    break
                command = item
                assert isinstance(command, ActorCommand)
                if not command.future.set_running_or_notify_cancel():
                    continue
                if (
                    command.deadline_monotonic is not None
                    and time.monotonic() >= command.deadline_monotonic
                ):
                    command.future.set_exception(
                        ActorDeadlineExceeded(
                            f"desktop command {command.method!r} exceeded its deadline before dispatch"
                        )
                    )
                    continue
                try:
                    assert self._service is not None
                    target = getattr(self._service, command.method)
                    if command.read_attribute:
                        result = target
                    else:
                        if not callable(target):
                            raise TypeError(
                                f"desktop attribute {command.method!r} is not callable"
                            )
                        result = target(*command.args, **command.kwargs)
                except BaseException as exc:
                    command.future.set_exception(exc)
                else:
                    command.future.set_result(result)
        finally:
            service = self._service
            if service is not None:
                for hook_name in ("safe_release_input", "close"):
                    try:
                        hook = getattr(service, hook_name, None)
                        if callable(hook):
                            hook()
                    except BaseException:
                        logger.exception("desktop actor %s hook failed", hook_name)
            self._service = None
            if apartment_initialized:
                comtypes.CoUninitialize()

    def submit(
        self,
        method: str,
        *args: Any,
        deadline_monotonic: float | None = None,
        **kwargs: Any,
    ) -> Future[Any]:
        command = ActorCommand(method, args, kwargs, deadline_monotonic)
        with self._state_lock:
            if not self._accepting:
                command.future.set_exception(ActorClosedError("desktop actor is closed"))
                return command.future
            self._queue.put(command)
        return command.future

    def read_attribute(self, name: str, timeout: float | None = None) -> Any:
        command = ActorCommand(name, (), {}, None, read_attribute=True)
        with self._state_lock:
            if not self._accepting:
                raise ActorClosedError("desktop actor is closed")
            self._queue.put(command)
        try:
            return command.future.result(timeout=timeout)
        except FutureTimeout as exc:
            command.future.cancel()
            raise ActorDeadlineExceeded(
                f"desktop attribute {name!r} timed out while waiting"
            ) from exc

    def call(
        self,
        method: str,
        *args: Any,
        timeout: float | None = None,
        deadline_monotonic: float | None = None,
        **kwargs: Any,
    ) -> Any:
        if threading.get_ident() == self._owner_thread_id:
            raise RuntimeError("actor calls cannot synchronously re-enter the owner thread")
        future = self.submit(
            method, *args, deadline_monotonic=deadline_monotonic, **kwargs
        )
        try:
            return future.result(timeout=timeout)
        except FutureTimeout as exc:
            future.cancel()
            raise ActorDeadlineExceeded(
                f"desktop command {method!r} timed out while waiting"
            ) from exc

    async def call_async(
        self,
        method: str,
        *args: Any,
        timeout: float | None = None,
        deadline_monotonic: float | None = None,
        **kwargs: Any,
    ) -> Any:
        future = self.submit(
            method, *args, deadline_monotonic=deadline_monotonic, **kwargs
        )
        wrapped = asyncio.wrap_future(future)
        try:
            return await asyncio.wait_for(wrapped, timeout) if timeout else await wrapped
        except asyncio.TimeoutError as exc:
            future.cancel()
            raise ActorDeadlineExceeded(
                f"desktop command {method!r} timed out while waiting"
            ) from exc

    def shutdown(self, timeout: float = 5.0) -> None:
        with self._state_lock:
            if not self._accepting:
                if self._thread.is_alive():
                    self._thread.join(timeout=timeout)
                return
            self._accepting = False
            while True:
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:
                    break
                if isinstance(item, ActorCommand):
                    item.future.cancel()
            self._queue.put(_STOP)
        if threading.get_ident() != self._owner_thread_id:
            self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            raise TimeoutError("desktop actor did not stop before shutdown deadline")

    def __enter__(self) -> "DesktopActor[T]":
        return self

    def __exit__(self, *_: object) -> None:
        self.shutdown()


class DesktopActorProxy:
    """Compatibility facade used by legacy synchronous tool functions."""

    _FORBIDDEN_ATTRIBUTES = frozenset(
        {"desktop_state", "encoding", "ocr_backend", "snapshot_store", "tree"}
    )

    def __init__(self, actor: DesktopActor[Any], call_timeout: float = 120.0) -> None:
        object.__setattr__(self, "_actor", actor)
        object.__setattr__(self, "_call_timeout", call_timeout)

    @property
    def actor(self) -> DesktopActor[Any]:
        return self._actor

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._FORBIDDEN_ATTRIBUTES:
            raise AttributeError(
                f"{name!r} is actor-owned state; use a Desktop command that returns a DTO"
            )

        def invoke(*args: Any, **kwargs: Any) -> Any:
            return self._actor.call(
                name,
                *args,
                timeout=self._call_timeout,
                **kwargs,
            )

        return invoke
