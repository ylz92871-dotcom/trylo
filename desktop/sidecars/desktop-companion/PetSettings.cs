using System.Text.Json;
using System.IO;

namespace TryloDesktopPet;

internal sealed class PetSettings
{
    private const int CurrentSchemaVersion = 2;

    public int SchemaVersion { get; set; } = CurrentSchemaVersion;
    public double Left { get; set; } = double.NaN;
    public double Top { get; set; } = double.NaN;
    public bool Topmost { get; set; } = true;
    public bool ShowStatus { get; set; } = true;
    public bool ShowOnlyWhenMinimized { get; set; } = false;

    private static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TryloCode",
        "desktop-pet.json");

    public static PetSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new PetSettings();
            var settings = JsonSerializer.Deserialize<PetSettings>(File.ReadAllText(SettingsPath)) ?? new PetSettings();
            if (settings.SchemaVersion < CurrentSchemaVersion)
            {
                // v1 was coupled to VS Code and hid the pet while the editor was visible.
                // Desktop owns the pet now, so migrate that legacy default exactly once.
                settings.SchemaVersion = CurrentSchemaVersion;
                settings.ShowOnlyWhenMinimized = false;
                settings.Save();
            }
            return settings;
        }
        catch
        {
            return new PetSettings();
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }
}
