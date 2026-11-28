// Embedded source survives the single-file Service Host bundle: no Python asset
// lookup may accidentally depend on a source checkout in an installed app.
export const COMPUTER_PREVIEW_WORKER = String.raw`
import base64
import contextlib
import ctypes
import io
import json
import sys
import time


def write_frame(message, output):
    output.write(json.dumps(message, separators=(",", ":")) + "\n")
    output.flush()


def select_display(displays, index):
    for display in displays:
        if display.index == index:
            return display.rect
    raise RuntimeError("预览显示器不存在")


def stream(capture, rect, cursor, mask_rect, commands, output, fps=10):
    from PIL import ImageDraw

    seq = 0
    last_capture = 0.0
    while True:
        # The parent bounds pulls to one delivery plus one prefetched frame.
        # EOF ends capture even if the host exits without a stop command.
        command = commands.readline()
        if not command or command.strip() == "stop":
            break
        if command.strip() != "next":
            continue
        time.sleep(max(0, 1 / fps - (time.monotonic() - last_capture)))
        last_capture = time.monotonic()
        # Capture libraries may log diagnostics on stdout; protocol owns stdout.
        with contextlib.redirect_stdout(sys.stderr):
            image, backend = capture(rect)
        # Encoding can be slow; pointer and freshness must describe this image.
        captured_at = int(time.time() * 1000)
        x, y = cursor()
        if image.size != (rect.right - rect.left, rect.bottom - rect.top):
            raise RuntimeError("Capture geometry does not match the physical display")
        masked = mask_rect()
        if masked:
            left, top, right, bottom = masked
            left, top = max(0, left - rect.left), max(0, top - rect.top)
            right, bottom = min(image.width, right - rect.left), min(image.height, bottom - rect.top)
            if right > left and bottom > top:
                ImageDraw.Draw(image).rectangle((left, top, right - 1, bottom - 1), fill=(247, 239, 217))
        # No dimension reduction. 4:4:4 avoids blurred colored text; original
        # tool screenshots keep their separate lossless PNG path.
        rgb = image.convert("RGB")
        for quality in (94, 90, 85, 80, 75):
            buffer = io.BytesIO()
            rgb.save(buffer, format="JPEG", quality=quality, subsampling=0)
            if buffer.tell() <= 1350000:
                break
        else:
            raise RuntimeError("原分辨率画面超过实时传输上限；请使用工具截图查看原图")
        seq += 1
        write_frame({"type": "frame", "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                     "mimeType": "image/jpeg", "width": image.width, "height": image.height,
                     "originX": rect.left, "originY": rect.top, "cursorX": x, "cursorY": y,
                     "timestamp": captured_at, "seq": seq}, output)


def main():
    output = sys.stdout
    if sys.platform != "win32":
        raise RuntimeError("实时电脑预览仅支持 Windows")
    # Monitor geometry, cursor position and frames must all use physical pixels.
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except (AttributeError, OSError):
        ctypes.windll.user32.SetProcessDPIAware()
    with contextlib.redirect_stdout(sys.stderr):
        import win32api
        import win32gui
        from windows_mcp.desktop.screenshot import capture
        import windows_mcp.uia as uia
        displays = uia.GetDisplays()
    display = int(sys.argv[1])
    excluded = int(sys.argv[2])
    rect = select_display(displays, display)

    affinity = ctypes.c_ulong()
    native_exclusion = bool(excluded and ctypes.windll.user32.GetWindowDisplayAffinity(
        ctypes.c_void_p(excluded), ctypes.byref(affinity)) and affinity.value == 0x11)

    def mask_rect():
        if native_exclusion:
            return None
        if not excluded or not win32gui.IsWindow(excluded) or not win32gui.IsWindowVisible(excluded):
            return None
        return win32gui.GetWindowRect(excluded)

    detail = "实时预览 · 原始分辨率 · 最高 10 帧/秒"
    if excluded and not native_exclusion:
        # Display affinity may only be set by the HWND owner. Masking is an
        # honest fallback, not a claim to capture the obscured application.
        detail += "；悬浮窗区域已遮罩，无法还原其后方内容"
    write_frame({"type": "status", "state": "running", "detail": detail}, output)
    stream(capture, rect, win32api.GetCursorPos, mask_rect, sys.stdin, output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        write_frame({"type": "status", "state": "error", "detail": str(error)}, sys.stdout)
        sys.exit(1)
`;
