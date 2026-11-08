using System.Windows;
using TryloDesktopPet;

// Independent DIP-space oracles: the complete 264x272 pet stays reachable.
var size = new Size(264, 272);
var cases = new (string Name, Point Position, Rect Screen, Point Expected)[]
{
    ("inside", new(100, 100), new(0, 0, 1706, 1000), new(100, 100)),
    ("partially past right edge", new(1556, 305), new(0, 0, 1706, 1000), new(1442, 305)),
    ("partially past bottom", new(100, 950), new(0, 0, 1706, 1000), new(100, 728)),
    ("unplugged monitor", new(5000, 2000), new(0, 0, 1706, 1000), new(1442, 728)),
    ("negative monitor origin", new(-1800, 50), new(-1280, 0, 3200, 1080), new(-1280, 50)),
    ("vertical monitor origin", new(200, -1500), new(0, -900, 1920, 1980), new(200, -900)),
    ("left and top outside", new(-30, -20), new(0, 0, 1706, 1000), new(0, 0)),
    ("display smaller than window", new(80, 100), new(0, 0, 200, 180), new(0, 0)),
};
foreach (var test in cases)
{
    var actual = PetWindowPlacement.Clamp(test.Position, size, test.Screen);
    if (actual != test.Expected)
        throw new InvalidOperationException($"{test.Name}: expected {test.Expected}, actual {actual}");
    Console.WriteLine($"PASS {test.Name}");
}
Console.WriteLine($"{cases.Length} placement checks passed");
