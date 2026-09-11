using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace TryloDesktopPet;

internal static class WindowActivator
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    public static WorkspaceWindowState GetWorkspaceWindowState(string workspaceName)
    {
        var windows = FindTryloWindows();
        var target = windows.FirstOrDefault();
        if (target.Handle == IntPtr.Zero) return WorkspaceWindowState.Missing;
        return IsIconic(target.Handle) ? WorkspaceWindowState.Minimized : WorkspaceWindowState.Visible;
    }

    public static void RestoreOrOpen(string workspacePath, string workspaceName)
    {
        var target = FindTryloWindows().FirstOrDefault();

        if (target.Handle != IntPtr.Zero)
        {
            ShowWindow(target.Handle, 9);
            SetForegroundWindow(target.Handle);
            return;
        }

    }

    private static List<(IntPtr Handle, string Title)> FindTryloWindows()
    {
        var windows = new List<(IntPtr, string)>();
        EnumWindows((handle, _) =>
        {
            if (!IsWindowVisible(handle)) return true;
            GetWindowThreadProcessId(handle, out var processId);
            try
            {
                using var process = Process.GetProcessById((int)processId);
                if (!process.ProcessName.Equals("trylo-desktop", StringComparison.OrdinalIgnoreCase) &&
                    !process.ProcessName.Equals("Trylo", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch
            {
                return true;
            }

            var title = new StringBuilder(512);
            GetWindowText(handle, title, title.Capacity);
            if (title.Length > 0) windows.Add((handle, title.ToString()));
            return true;
        }, IntPtr.Zero);
        return windows;
    }

}

internal enum WorkspaceWindowState
{
    Missing,
    Visible,
    Minimized,
}
