using System.Windows;
using Point = System.Windows.Point;
using Size = System.Windows.Size;

namespace TryloDesktopPet;

/// <summary>Placement uses WPF DIPs, including the screen origin on multiple displays.</summary>
internal static class PetWindowPlacement
{
    // WinForms virtual-screen metrics are pixels in a DPI-aware process.
    public static Rect DesktopBounds => new(
        SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
        SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);

    public static Point Clamp(Point position, Size window, Rect screen) => new(
        Math.Clamp(position.X, screen.Left, Math.Max(screen.Left, screen.Right - window.Width)),
        Math.Clamp(position.Y, screen.Top, Math.Max(screen.Top, screen.Bottom - window.Height)));
}
