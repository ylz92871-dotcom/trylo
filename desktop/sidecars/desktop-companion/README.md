# Trylo Desktop Pet

Windows-only WPF companion for the Trylo Code VS Code extension.

Build the framework-dependent executable:

```powershell
dotnet publish .\desktop-companion\TryloDesktopPet.csproj -c Release --self-contained false -o .\desktop-companion\publish
```

The extension discovers `desktop-companion/publish/TryloDesktopPet.exe` automatically. Status and permission events use UDP loopback port `49371`. The standalone desktop chat uses a newline-delimited JSON stream over TCP loopback port `49372`; no traffic from either bridge leaves the machine.

The bundled Trylo Miu character uses distinct animations for analysis, coding, terminal commands, review, looking around, pacing, waiting, completion, and failures. Active work rotates through the available clips while preserving immediate state feedback. After a completed task, she celebrates, waves, briefly shows her Trylo roadster, and then remains on the desktop until the agent closes.

Hovering over the pet temporarily pauses the work-state clip and maps the pointer around Miu's face to the atlas's 16 clockwise look directions. Pointer movement is sampled at 60 Hz and vector-smoothed, with a subtle continuous lean and a small angular boundary margin that prevents direction flicker without adding a time delay; a face-centered deadzone triggers a wave and subtle idle. Moving the pointer away immediately resumes the current agent-state animation.

Click the visible **Chat** pill beside the character, choose **Desktop Chat** in the Trylo Code main sidebar, double-click the character or tray icon, or choose **Open desktop chat** from the tray menu to open the standalone chat window. The sidebar entry automatically starts the pet if it is disabled. This window is intentionally Chat-only: it has no Agent or Plan selector, cannot edit project files or invoke tools, and persists its conversation in a workspace-scoped `desktop-pet-chat.json` file separate from the main page sessions. Agent and Plan remain available only in the full VS Code page.

The desktop pet uses normal WPF hit testing: single-click the character to restore the matching VS Code workspace, drag to reposition it, and right-click for tray options.
