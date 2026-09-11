using System.Threading;
using System.Windows;

namespace TryloDesktopPet;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var renderHover = args.Length >= 2 &&
            args[0].StartsWith("--render-hover", StringComparison.OrdinalIgnoreCase);
        var renderHoverDirection = renderHover
            ? args[0].Split('-', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "center"
            : "";
        var isQaRender = args.Length >= 2 &&
            (args[0].Equals("--render", StringComparison.OrdinalIgnoreCase) ||
             args[0].Equals("--render-permission", StringComparison.OrdinalIgnoreCase) ||
             renderHover);
        var renderPermission = isQaRender &&
            args[0].Equals("--render-permission", StringComparison.OrdinalIgnoreCase);
        if (isQaRender)
        {
            var qaMutexName = $"Local\\TryloCodeDesktopPetQa-{Environment.ProcessId}";
            using var qaSingleton = new Mutex(true, qaMutexName, out var isQaFirst);
            if (!isQaFirst) return;
            RunQaRender(args, renderPermission, renderHoverDirection);
            return;
        }

        // Real launch (audit §4.2 PET-P0-5): take single-instance ownership.
        // A second launch makes the RUNNING pet show itself instead of
        // silently exiting — hidden/off-screen pets used to look identical to
        // "the pet never started".
        using var singleton = SingleInstance.Acquire();
        if (!singleton.IsFirstInstance) return;

        var window = new PetWindow(startServer: true);
        singleton.ListenForWake(() => window.Dispatcher.Invoke(() =>
        {
            window.Show();
            window.WindowState = WindowState.Normal;
            window.Activate();
            window.ClampIntoScreen();
        }));
        var app = new System.Windows.Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose
        };
        app.Run(window);
    }

    private static void RunQaRender(
        string[] args,
        bool renderPermission,
        string renderHoverDirection)
    {
        var app = new System.Windows.Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose
        };
        var window = new PetWindow(startServer: false);
        var elapsedMilliseconds = args.Length >= 3 && int.TryParse(args[2], out var parsedElapsed)
            ? Math.Max(0, parsedElapsed)
            : 0;
        window.PrepareQaRender(args[1], elapsedMilliseconds, renderPermission, renderHoverDirection);
        app.Run(window);
    }
}
