import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from windows_mcp.runtime.desktop_actor import DesktopActor, DesktopActorProxy


class ThreadBoundService:
    def __init__(self) -> None:
        self.created_on = threading.get_ident()
        self.calls: list[int] = []
        self.desktop_state = {"snapshot": 1}

    def record_thread(self, value: int = 0) -> tuple[int, int]:
        thread_id = threading.get_ident()
        self.calls.append(thread_id)
        return thread_id, value

    def explode(self) -> None:
        raise ValueError("one bad command")


def test_concurrent_callers_execute_on_one_owner_thread() -> None:
    with DesktopActor(ThreadBoundService) as actor:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda value: actor.call("record_thread", value), range(20)))

        thread_ids = {thread_id for thread_id, _ in results}
        assert thread_ids == {actor.owner_thread_id}
        assert [value for _, value in results] == list(range(20))


def test_command_exception_does_not_kill_actor() -> None:
    with DesktopActor(ThreadBoundService) as actor:
        with pytest.raises(ValueError, match="one bad command"):
            actor.call("explode")
        thread_id, value = actor.call("record_thread", 7)
        assert thread_id == actor.owner_thread_id
        assert value == 7


def test_async_callers_are_marshaled_to_actor_thread() -> None:
    async def exercise(actor: DesktopActor) -> list[tuple[int, int]]:
        return await asyncio.gather(
            *(actor.call_async("record_thread", value) for value in range(10))
        )

    with DesktopActor(ThreadBoundService) as actor:
        results = asyncio.run(exercise(actor))
        assert {thread_id for thread_id, _ in results} == {actor.owner_thread_id}


def test_legacy_proxy_marshals_methods_and_rejects_internal_state_access() -> None:
    with DesktopActor(ThreadBoundService) as actor:
        proxy = DesktopActorProxy(actor)

        thread_id, value = proxy.record_thread(9)

        assert thread_id == actor.owner_thread_id
        assert value == 9
        with pytest.raises(AttributeError, match="actor-owned state"):
            _ = proxy.desktop_state
