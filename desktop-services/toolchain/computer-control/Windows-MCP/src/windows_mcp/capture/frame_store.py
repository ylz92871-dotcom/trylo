"""Bounded in-memory frame store (spec §6.4): PNG bytes live here, never
inside the ObservationReceipt; refs address frames by opaque id."""

from __future__ import annotations

from collections import OrderedDict


class FrameStore:
    def __init__(self, *, max_frames: int = 16, max_bytes: int = 64 * 1024 * 1024) -> None:
        self._max_frames = max_frames
        self._max_bytes = max_bytes
        self._bytes = 0
        self._frames: OrderedDict[str, tuple[object, bytes]] = OrderedDict()

    def put(self, ref: object, png_bytes: bytes) -> None:
        """Insert (or refresh) one frame; evicts oldest-first on either bound."""
        frame_id = getattr(ref, "frame_id", None)
        if frame_id is None:
            raise ValueError("ref must carry a frame_id")
        if frame_id in self._frames:
            old_ref, old_bytes = self._frames.pop(frame_id)
            self._bytes -= len(old_bytes)
        self._frames[frame_id] = (ref, png_bytes)
        self._bytes += len(png_bytes)
        while len(self._frames) > self._max_frames or (
            self._bytes > self._max_bytes and len(self._frames) > 1
        ):
            _, (_, evicted) = self._frames.popitem(last=False)
            self._bytes -= len(evicted)

    def get(self, frame_id: str) -> tuple[object, bytes] | None:
        entry = self._frames.get(frame_id)
        if entry is None:
            return None
        # Refresh recency on read.
        self._frames.move_to_end(frame_id)
        return entry

    def __len__(self) -> int:
        return len(self._frames)
