"""windows_mcp.capture — exact-window capture providers and FrameRef."""

from windows_mcp.capture.frame_store import FrameStore
from windows_mcp.capture.frames import Affine2D, FrameRef, frame_id
from windows_mcp.capture.providers.base import CapturedFrame, CaptureProvider
from windows_mcp.capture.providers.legacy import LegacyCaptureProvider
from windows_mcp.capture.providers.wgc import WgcProvider
from windows_mcp.capture.service import CaptureService, wgc_flag_enabled

__all__ = [
    "Affine2D",
    "CapturedFrame",
    "CaptureProvider",
    "CaptureService",
    "FrameRef",
    "FrameStore",
    "LegacyCaptureProvider",
    "WgcProvider",
    "frame_id",
    "wgc_flag_enabled",
]
