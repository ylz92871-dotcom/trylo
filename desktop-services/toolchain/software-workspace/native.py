"""Physical-pixel window observation on the calling thread's desktop.

No desktop switching, global input, screen capture sessions or focus activation.
"""
import base64
import ctypes
from ctypes import wintypes
import io
import time
from contextlib import contextmanager

from PIL import Image
import win32api
import win32con
import win32gui
import win32process
import pywintypes

USER = ctypes.WinDLL("user32", use_last_error=True)
GDI = ctypes.WinDLL("gdi32", use_last_error=True)
USER.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
USER.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
USER.GetWindowDpiAwarenessContext.argtypes = [wintypes.HWND]
USER.GetWindowDpiAwarenessContext.restype = ctypes.c_void_p
USER.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
USER.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
for name, args, result in [
    ("CreateDesktopW", [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p], wintypes.HANDLE),
    ("CloseDesktop", [wintypes.HANDLE], wintypes.BOOL),
    ("GetWindowDC", [wintypes.HWND], wintypes.HDC),
    ("ReleaseDC", [wintypes.HWND, wintypes.HDC], ctypes.c_int),
    ("PrintWindow", [wintypes.HWND, wintypes.HDC, wintypes.UINT], wintypes.BOOL),
]:
    function = getattr(USER, name)
    function.argtypes, function.restype = args, result
for name, args, result in [
    ("CreateCompatibleDC", [wintypes.HDC], wintypes.HDC),
    ("CreateCompatibleBitmap", [wintypes.HDC, ctypes.c_int, ctypes.c_int], wintypes.HANDLE),
    ("SelectObject", [wintypes.HDC, wintypes.HANDLE], wintypes.HANDLE),
    ("DeleteObject", [wintypes.HANDLE], wintypes.BOOL),
    ("DeleteDC", [wintypes.HDC], wintypes.BOOL),
    ("GetDIBits", [wintypes.HDC, wintypes.HANDLE, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT], ctypes.c_int),
]:
    function = getattr(GDI, name)
    function.argtypes, function.restype = args, result


class BitmapHeader(ctypes.Structure):
    _fields_ = [(name, kind) for name, kind in [
        ("size", wintypes.DWORD), ("width", wintypes.LONG), ("height", wintypes.LONG),
        ("planes", wintypes.WORD), ("bits", wintypes.WORD), ("compression", wintypes.DWORD),
        ("imageSize", wintypes.DWORD), ("xppm", wintypes.LONG), ("yppm", wintypes.LONG),
        ("colorsUsed", wintypes.DWORD), ("colorsImportant", wintypes.DWORD)]]


@contextmanager
def window_coordinates(hwnd):
    # Match legacy applications' logical-pixel paint and message coordinates.
    previous = USER.SetThreadDpiAwarenessContext(USER.GetWindowDpiAwarenessContext(hwnd))
    try:
        yield
    finally:
        USER.SetThreadDpiAwarenessContext(previous)


def windows(pids):
    result = []

    def collect(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] in pids and win32gui.IsWindowVisible(hwnd):
            with window_coordinates(hwnd):
                rect = win32gui.GetWindowRect(hwnd)
            if rect[2] > rect[0] and rect[3] > rect[1]:
                controls = []
                if win32gui.GetClassName(hwnd) == "#32770":
                    with window_coordinates(hwnd):
                        win32gui.EnumChildWindows(hwnd, lambda child, _: controls.append({"id": str(child), "text": win32gui.GetWindowText(child), "className": win32gui.GetClassName(child), "rect": win32gui.GetWindowRect(child)}) or True, None)
                result.append({"id": str(hwnd), "title": win32gui.GetWindowText(hwnd), "controls": controls,
                               "className": win32gui.GetClassName(hwnd), "rect": rect,
                               "dialog": win32gui.GetClassName(hwnd) == "#32770"})
        return True

    # Empty desktops return FALSE without setting an error. pywin32 otherwise
    # surfaces an unrelated stale thread error left by process enumeration.
    win32api.SetLastError(0)
    try:
        win32gui.EnumWindows(collect, None)
    except pywintypes.error as error:
        if error.winerror:
            raise
    return result


def capture(hwnd):
    with window_coordinates(hwnd):
        return capture_window(hwnd)


def capture_window(hwnd):
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise RuntimeError("软件窗口尚未准备好")
    dc = USER.GetWindowDC(hwnd)
    memory = GDI.CreateCompatibleDC(dc)
    bitmap = GDI.CreateCompatibleBitmap(dc, width, height)
    original = GDI.SelectObject(memory, bitmap)
    try:
        if not USER.PrintWindow(hwnd, memory, 2):
            raise RuntimeError("该软件没有提供窗口画面，请使用软件原生视图")
        GDI.SelectObject(memory, original)
        header = BitmapHeader(ctypes.sizeof(BitmapHeader), width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0)
        pixels = ctypes.create_string_buffer(width * height * 4)
        if GDI.GetDIBits(dc, bitmap, 0, height, pixels, ctypes.byref(header), 0) != height:
            raise RuntimeError("软件窗口画面读取不完整")
        return Image.frombuffer("RGB", (width, height), pixels, "raw", "BGRX", 0, 1).copy()
    finally:
        GDI.SelectObject(memory, original)
        GDI.DeleteObject(bitmap)
        GDI.DeleteDC(memory)
        USER.ReleaseDC(hwnd, dc)


def frame(image, **metadata):
    timestamp = int(time.time() * 1000)
    # The Service Host has a 2 MiB wire-frame limit. Preserve physical geometry.
    for quality in (92, 85, 75, 60, 40):
        output = io.BytesIO()
        image.convert("RGB").save(output, "JPEG", quality=quality, subsampling=0)
        if output.tell() <= 1200000:
            return {"data": base64.b64encode(output.getvalue()).decode("ascii"),
                    "mimeType": "image/jpeg", "width": image.width, "height": image.height,
                    "timestamp": timestamp, **metadata}
    raise RuntimeError("窗口画面超过传输容量，请缩小软件窗口后重试")


def target_at(hwnd, x, y):
    """Resolve children on this hidden desktop; never use WindowFromPoint."""
    left, top, _, _ = win32gui.GetWindowRect(hwnd)
    screen = (left + x, top + y)
    target = hwnd
    while True:
        point = win32gui.ScreenToClient(target, screen)
        child = win32gui.ChildWindowFromPointEx(target, point, 0x0001 | 0x0002 | 0x0004)
        if not child or child == target:
            return target, point
        target = child


def pointer(hwnd, action):
    with window_coordinates(hwnd):
        return post_pointer(hwnd, action)


def post_pointer(hwnd, action):
    x, y = int(action["x"]), int(action["y"])
    target, point = target_at(hwnd, x, y)
    packed = win32api.MAKELONG(*point)
    if action["kind"] == "wheel":
        left, top, _, _ = win32gui.GetWindowRect(hwnd)
        win32gui.PostMessage(target, win32con.WM_MOUSEWHEEL,
                             win32api.MAKELONG(0, int(action["delta"])), win32api.MAKELONG(left + x, top + y))
    else:
        right = action.get("button") == "right"
        down, up = (win32con.WM_RBUTTONDOWN, win32con.WM_RBUTTONUP) if right else (win32con.WM_LBUTTONDOWN, win32con.WM_LBUTTONUP)
        flags = win32con.MK_RBUTTON if right else win32con.MK_LBUTTON
        win32gui.PostMessage(target, down, flags, packed)
        for move in action.get("path", []):
            left, top, _, _ = win32gui.GetWindowRect(hwnd)
            local = win32gui.ScreenToClient(target, (left + int(move[0]), top + int(move[1])))
            win32gui.PostMessage(target, win32con.WM_MOUSEMOVE, flags, win32api.MAKELONG(*local))
            packed = win32api.MAKELONG(*local)
        win32gui.PostMessage(target, up, 0, packed)
    return target


def keyboard(hwnd, action):
    # Messages stay bound to the last clicked child. Some GPU applications do
    # not accept posted keys; their native API remains the supported path.
    if action["kind"] == "text":
        encoded = action["text"].encode("utf-16-le")
        for index in range(0, len(encoded), 2):
            win32gui.PostMessage(hwnd, win32con.WM_CHAR, int.from_bytes(encoded[index:index + 2], "little"), 1)
    else:
        keys = {"Enter": 13, "Escape": 27, "Tab": 9, "Backspace": 8, "Delete": 46,
                "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40, "Space": 32}
        key = keys[action["key"]]
        win32gui.PostMessage(hwnd, win32con.WM_KEYDOWN, key, 1)
        win32gui.PostMessage(hwnd, win32con.WM_KEYUP, key, 0xC0000001)
