import threading

import pytest

from windows_mcp.runtime.commands import ActorClosedError, ActorDeadlineExceeded
from windows_mcp.runtime.desktop_actor import DesktopActor


class BlockingService:
    def __init__(self, release: threading.Event) -> None:
        self.release = release

    def block(self) -> None:
        self.release.wait(2)

    def ping(self) -> str:
        return "pong"


class LifecycleService:
    def __init__(self, events: list[tuple[str, int]]) -> None:
        self.events = events
        self.events.append(("created", threading.get_ident()))

    def safe_release_input(self) -> None:
        self.events.append(("released", threading.get_ident()))

    def close(self) -> None:
        self.events.append(("closed", threading.get_ident()))


def test_queued_command_expiring_before_dispatch_is_never_run() -> None:
    release = threading.Event()
    actor = DesktopActor(lambda: BlockingService(release))
    blocker = actor.submit("block")
    expired = actor.submit("ping", deadline_monotonic=0.0)
    release.set()
    blocker.result(timeout=3)

    with pytest.raises(ActorDeadlineExceeded, match="before dispatch"):
        expired.result(timeout=3)
    actor.shutdown()


def test_shutdown_rejects_new_commands() -> None:
    actor = DesktopActor(lambda: BlockingService(threading.Event()))
    actor.shutdown()

    with pytest.raises(ActorClosedError):
        actor.call("ping")


def test_shutdown_runs_safe_release_and_close_on_owner_thread() -> None:
    events: list[tuple[str, int]] = []
    actor = DesktopActor(lambda: LifecycleService(events))
    owner = actor.owner_thread_id

    actor.shutdown()

    assert [name for name, _ in events] == ["created", "released", "closed"]
    assert {thread_id for _, thread_id in events} == {owner}


def test_cancelled_queued_command_is_never_dispatched() -> None:
    release = threading.Event()
    actor = DesktopActor(lambda: BlockingService(release))
    blocker = actor.submit("block")
    cancelled = actor.submit("ping")

    assert cancelled.cancel() is True
    release.set()
    blocker.result(timeout=3)

    assert cancelled.cancelled()
    actor.shutdown()
