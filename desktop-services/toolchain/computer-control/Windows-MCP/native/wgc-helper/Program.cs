// Trylo WGC helper (WCC-P1-06) — crash-isolated exact-window capture.
//
// Protocol (stdio, 4-byte LE length prefix + JSON, mirroring the
// windows_mcp.broker conventions):
//   stdin : {"cmd":"hello"}
//           {"cmd":"capture","hwnd":N,"maxFrames":K,"intervalMs":M}
//   stdout: {"type":"hello",…} / {"type":"error","code":…} /
//           {"type":"frame",…,"pngBase64":…} / {"type":"done","frames":N}
//
// One capture session per helper lifetime: the parent spawns a fresh helper
// per capture burst, so a helper crash takes exactly one observation with it
// and never the MCP server. The helper reads nothing beyond the requested
// HWND's pixels and exits when stdin closes.

using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text.Json;
using Trylo.WgcHelper;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;

return WgcHelperMain.Run(args);

internal static class WgcHelperMain
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    public static int Run(string[] args)
    {
        // Physical-pixel rects per frame: the host builds the FrameRef affine
        // from these, so the helper must not be DPI-virtualized.
        SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        WinRT.ComWrappersSupport.InitializeComWrappers();

        if (args.Length > 0 && args[0] == "selftest")
        {
            Io.WriteJson(Console.OpenStandardOutput(), new Dictionary<string, object>
            {
                ["type"] = "hello",
                ["version"] = 1,
                ["ok"] = true,
                ["captureSupported"] = GraphicsCaptureSession.IsSupported(),
                ["os"] = Environment.OSVersion.VersionString,
            });
            return 0;
        }

        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        while (true)
        {
            var frame = Io.ReadFrame(stdin);
            if (frame == null)
            {
                return 0; // parent closed stdin
            }
            Dictionary<string, JsonElement> request;
            try
            {
                request = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(frame)
                          ?? throw new JsonException("null request");
            }
            catch (Exception)
            {
                Io.WriteJson(stdout, new Dictionary<string, object> { ["type"] = "error", ["code"] = "bad_request" });
                continue;
            }
            var cmd = request.TryGetValue("cmd", out var c) ? c.GetString() : null;
            switch (cmd)
            {
                case "hello":
                    Io.WriteJson(stdout, new Dictionary<string, object>
                    {
                        ["type"] = "hello",
                        ["version"] = 1,
                        ["ok"] = true,
                        ["captureSupported"] = GraphicsCaptureSession.IsSupported(),
                        ["os"] = Environment.OSVersion.VersionString,
                    });
                    break;
                case "capture":
                    CaptureLoop.Run(stdout, request);
                    return 0;
                default:
                    Io.WriteJson(stdout, new Dictionary<string, object> { ["type"] = "error", ["code"] = "unknown_cmd" });
                    break;
            }
        }
    }
}

internal static class Io
{
    public static byte[]? ReadFrame(Stream stream)
    {
        Span<byte> header = stackalloc byte[4];
        if (!ReadExactly(stream, header))
        {
            return null;
        }
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > 64 * 1024 * 1024)
        {
            return null;
        }
        var payload = new byte[length];
        return ReadExactly(stream, payload) ? payload : null;
    }

    public static bool ReadExactly(Stream stream, Span<byte> buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = stream.Read(buffer[offset..]);
            if (read <= 0)
            {
                return false;
            }
            offset += read;
        }
        return true;
    }

    public static void WriteJson(Stream stdout, Dictionary<string, object> payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload);
        Span<byte> header = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)json.Length);
        stdout.Write(header);
        stdout.Write(json);
        stdout.Flush();
    }
}

internal static class CaptureLoop
{
    public static void Run(Stream stdout, Dictionary<string, JsonElement> request)
    {
        var hwnd = (nint)request["hwnd"].GetInt64();
        var maxFrames = request.TryGetValue("maxFrames", out var mf) ? mf.GetInt32() : 1;
        var intervalMs = request.TryGetValue("intervalMs", out var im) ? Math.Max(16, im.GetInt32()) : 250;

        if (!GraphicsCaptureSession.IsSupported())
        {
            Io.WriteJson(stdout, new Dictionary<string, object> { ["type"] = "error", ["code"] = "capture_unsupported" });
            return;
        }

        GraphicsCaptureItem item;
        try
        {
            item = CaptureInterop.CreateItemForWindow(hwnd);
        }
        catch (Exception ex)
        {
            Io.WriteJson(stdout, new Dictionary<string, object> { ["type"] = "error", ["code"] = "window_unavailable", ["detail"] = $"{ex.GetType().Name}: {ex.Message}" });
            return;
        }

        using var device = Direct3D11Helper.CreateDevice();
        using var framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
        using var session = framePool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;

        using var arrived = new SemaphoreSlim(0);
        Direct3D11CaptureFrame? pending = null;
        object gate = new();
        framePool.FrameArrived += (pool, _) =>
        {
            var next = pool.TryGetNextFrame();
            lock (gate)
            {
                pending?.Dispose();
                pending = next;
            }
            if (next != null)
            {
                arrived.Release();
            }
        };
        var itemClosed = false;
        item.Closed += (_, _) => itemClosed = true;
        session.StartCapture();

        var deadlineTicks = Environment.TickCount64 + Math.Max(4000, intervalMs * maxFrames + 3000);
        var sent = 0;
        try
        {
            while (sent < maxFrames)
            {
                if (!arrived.Wait(Math.Min(intervalMs, 250)))
                {
                    if (itemClosed || Environment.TickCount64 > deadlineTicks)
                    {
                        break;
                    }
                    continue;
                }
                Direct3D11CaptureFrame? frame;
                lock (gate)
                {
                    frame = pending;
                    pending = null;
                }
                if (frame == null)
                {
                    continue;
                }
                using (frame)
                {
                    WriteFrame(stdout, hwnd, frame);
                    sent++;
                    if (sent < maxFrames)
                    {
                        Thread.Sleep(intervalMs);
                    }
                }
            }
        }
        finally
        {
            Io.WriteJson(stdout, new Dictionary<string, object> { ["type"] = "done", ["frames"] = sent });
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint hwnd, out RECT rect);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetClientRect(nint hwnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static void WriteFrame(Stream stdout, nint hwnd, Direct3D11CaptureFrame frame)
    {
        var content = frame.ContentSize;
        var png = Direct3D11Helper.EncodePng(frame.Surface);
        GetWindowRect(hwnd, out var windowRect);
        GetClientRect(hwnd, out var clientRect);
        Io.WriteJson(stdout, new Dictionary<string, object>
        {
            ["type"] = "frame",
            ["hwnd"] = (long)hwnd,
            ["status"] = "complete",
            ["contentWidth"] = content.Width,
            ["contentHeight"] = content.Height,
            ["windowRect"] = new[] { windowRect.Left, windowRect.Top, windowRect.Right, windowRect.Bottom },
            ["clientSize"] = new[] { clientRect.Right, clientRect.Bottom },
            ["systemRelativeTimeTicks"] = frame.SystemRelativeTime.Ticks,
            ["pngBase64"] = Convert.ToBase64String(png),
        });
    }
}
