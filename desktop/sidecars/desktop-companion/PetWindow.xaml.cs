using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.IO;
using Drawing = System.Drawing;
using Forms = System.Windows.Forms;

namespace TryloDesktopPet;

public partial class PetWindow : Window
{
    private enum WorkClip
    {
        Primary,
        Analyzing,
        Coding,
        Terminal,
        Review,
        LookAround,
        Pace,
        Wave,
    }

    private readonly record struct WorkSegment(WorkClip Clip, int DurationMilliseconds);

    private static readonly WorkSegment[] WorkPlaylist =
    {
        new(WorkClip.Primary, 6500),
        new(WorkClip.Analyzing, 3600),
        new(WorkClip.Coding, 4600),
        new(WorkClip.Terminal, 3600),
        new(WorkClip.Review, 3800),
        new(WorkClip.LookAround, 2800),
        new(WorkClip.Pace, 3200),
        new(WorkClip.Wave, 2200),
    };

    private static readonly int[] IdleDurations = { 280, 110, 110, 140, 140, 320 };
    private static readonly int[] RunDurations = { 115, 115, 115, 115, 115, 115, 115, 150 };
    private static readonly int[] WaveDurations = { 170, 170, 170, 260 };
    private static readonly int[] JumpDurations = { 150, 130, 180, 130, 220 };
    private static readonly int[] FailedDurations = { 140, 140, 140, 140, 140, 140, 140, 240 };
    private static readonly int[] WaitingDurations = { 150, 150, 150, 150, 150, 260 };
    private static readonly int[] CodingDurations = { 130, 130, 160, 170, 130, 240 };
    private static readonly int[] ReviewDurations = { 150, 150, 150, 150, 150, 280 };
    private static readonly int[] AnalyzingDurations = { 180, 180, 220, 180, 180, 320 };
    private static readonly int[] TerminalDurations = { 150, 150, 180, 180, 150, 280 };
    private static readonly int[] DrivingDurations = { 130, 130, 130, 130, 130, 180 };
    private static readonly (int Row, int Column)[] LookAroundFrames =
    {
        (10, 7), (9, 0), (9, 1), (9, 2), (9, 3), (9, 4),
        (9, 3), (9, 2), (9, 1), (9, 0), (10, 7), (10, 6),
    };

    private readonly CompanionServer? _server;
    private readonly PetSettings _settings;
    private readonly DispatcherTimer _animationTimer;
    private readonly DispatcherTimer _clientTimer;
    private readonly Forms.NotifyIcon _trayIcon;
    private readonly BitmapSource _atlas;
    private readonly IReadOnlyDictionary<string, BitmapSource[]> _actionFrames;
    private PetMessage? _activeClient;
    private System.Windows.Point _mouseDown;
    private bool _dragging;
    private DateTime _lastClientUtc = DateTime.UtcNow;
    private DateTime _frameDeadlineUtc = DateTime.MinValue;
    private string _animationState = "";
    private int _animationFrame;
    private int _displayedRow = -1;
    private int _displayedColumn = -1;
    private string _displayedAction = "";
    private bool _qaRender;
    private DateTime? _doneSinceUtc;
    private DateTime _workSessionStartedUtc = DateTime.UtcNow;
    private DateTime _workStateChangedUtc = DateTime.UtcNow;
    private PetPermissionRequest? _activePermission;
    private bool _pointerInside;
    private DateTime _pointerEnteredUtc = DateTime.UtcNow;
    private bool _hasSmoothedPointerDirection;
    private double _smoothedPointerX;
    private double _smoothedPointerY;
    private int _hoverDirectionIndex = -1;
    private System.Windows.Vector? _qaPointerOffset;
    private bool _permissionDecisionSending;
    private DateTime _lastBalloonUtc = DateTime.MinValue;

    // ── Mood system ────────────────────────────────────────────────────
    private double _glowOpacity;
    private double _glowOpacityTarget;
    private double _glowPulsePhase;
    private System.Windows.Media.Color _glowColor = System.Windows.Media.Colors.Transparent;
    private System.Windows.Media.Color _glowColorTarget = System.Windows.Media.Colors.Transparent;
    private bool _moodBubbleVisible;
    private DateTime _moodBubbleShownUtc = DateTime.MinValue;
    // Transient bubbles ("all done!", "something went wrong…") auto-hide after
    // this deadline so the pet never keeps a status window up with no task
    // running. Null while the bubble is persistent (permission / working).
    private DateTime? _moodBubbleTransientUntilUtc;

    public PetWindow(bool startServer = true)
    {
        InitializeComponent();
        _atlas = LoadAtlas();
        _actionFrames = LoadActionFrames();
        _settings = PetSettings.Load();
        Topmost = _settings.Topmost;
        RestorePosition();

        if (startServer)
        {
            _server = new CompanionServer();
            _server.ActiveClientChanged += (client, workingPeers) =>
                Dispatcher.Invoke(() => ApplyClient(client, workingPeers));
        }

        _animationTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        _animationTimer.Tick += (_, _) => AnimatePet();
        _animationTimer.Start();

        _clientTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        _clientTimer.Tick += (_, _) => CheckClientLifetime();
        _clientTimer.Start();

        _trayIcon = BuildTrayIcon();
        LocationChanged += (_, _) => SavePosition();
        Closed += OnClosed;
        ApplyClient(null);
    }

    internal void PrepareQaRender(
        string outputPath,
        int workElapsedMilliseconds = 0,
        bool showPermission = false,
        string hoverDirection = "")
    {
        _qaRender = true;
        ApplyClient(new PetMessage
        {
            WorkspaceName = "Trylo",
            WorkspacePath = Environment.CurrentDirectory,
            State = "writing_files",
            Detail = "Building desktop companion integration",
            Level = "info",
            Progress = 58,
            At = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Permission = showPermission
                ? new PetPermissionRequest
                {
                    RequestId = "qa-permission",
                    Title = "Run build command",
                    Detail = "npm run build",
                    Category = "command",
                    ApprovalState = "pending",
                }
                : null,
        });
        var now = DateTime.UtcNow;
        _workSessionStartedUtc = now.AddMilliseconds(-workElapsedMilliseconds);
        _workStateChangedUtc = now.AddMilliseconds(-2000);
        if (!string.IsNullOrWhiteSpace(hoverDirection))
        {
            _pointerInside = true;
            _pointerEnteredUtc = now.AddMilliseconds(-1700);
            _qaPointerOffset = hoverDirection.ToLowerInvariant() switch
            {
                "up" => new System.Windows.Vector(0, -90),
                "down" => new System.Windows.Vector(0, 90),
                "left" => new System.Windows.Vector(-90, 0),
                "right" => new System.Windows.Vector(90, 0),
                _ => new System.Windows.Vector(0, 0),
            };
        }
        AnimatePet();
        ContentRendered += (_, _) =>
        {
            var bounds = VisualTreeHelper.GetDescendantBounds(this);
            var bitmap = new RenderTargetBitmap(
                Math.Max(1, (int)Math.Ceiling(bounds.Width)),
                Math.Max(1, (int)Math.Ceiling(bounds.Height)),
                96,
                96,
                PixelFormats.Pbgra32);
            bitmap.Render(this);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
            using (var stream = File.Create(outputPath)) encoder.Save(stream);
            Close();
        };
    }

    private Forms.NotifyIcon BuildTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Trylo", null, (_, _) => RestoreTrylo());
        menu.Items.Add(new Forms.ToolStripSeparator());
        var topmostItem = new Forms.ToolStripMenuItem("Always on top") { Checked = Topmost, CheckOnClick = true };
        topmostItem.CheckedChanged += (_, _) =>
        {
            Topmost = topmostItem.Checked;
            _settings.Topmost = Topmost;
            _settings.Save();
        };
        menu.Items.Add(topmostItem);
        var minimizedItem = new Forms.ToolStripMenuItem("Show only when Trylo is minimized")
        {
            Checked = _settings.ShowOnlyWhenMinimized,
            CheckOnClick = true,
        };
        minimizedItem.CheckedChanged += (_, _) =>
        {
            _settings.ShowOnlyWhenMinimized = minimizedItem.Checked;
            _settings.Save();
            UpdateWindowVisibility();
        };
        menu.Items.Add(minimizedItem);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit pet", null, (_, _) =>
        {
            Close();
        });

        var icon = new Forms.NotifyIcon
        {
            Icon = Drawing.SystemIcons.Application,
            Text = "Trylo Desktop Pet",
            Visible = true,
            ContextMenuStrip = menu,
        };
        icon.DoubleClick += (_, _) => Dispatcher.Invoke(RestoreTrylo);
        return icon;
    }

    private void ApplyClient(PetMessage? client, int workingPeers = 0)
    {
        var previousState = _activeClient?.State ?? "idle";
        var previousPermissionId = _activePermission?.RequestId ?? "";
        var wasWorking = IsWorkingState(previousState);
        _activeClient = client;
        _activePermission = IsPendingPermission(client?.Permission) ? client!.Permission : null;
        if (!string.Equals(previousPermissionId, _activePermission?.RequestId ?? "", StringComparison.Ordinal))
        {
            _permissionDecisionSending = false;
        }
        if (client is not null) _lastClientUtc = DateTime.UtcNow;

        var state = client?.State ?? "idle";
        var stateColor = StateColor(state);

        // ── Body glow: always tinted by state ──
        _glowColorTarget = stateColor;
        _glowOpacityTarget = IsWorkingState(state) ? 0.55
            : state is "done" or "failed" or "stalled" or "waiting_output" ? 0.45
            : 0.18;

        // ── Mood bubble ──
        // The bubble is a TASK window: it exists only while there is something
        // to show. Running tasks show what the pet is doing right now (file
        // name / command, or a light verb); with several tasks in flight a
        // very dim "+N" hint names how many others are running. Terminal
        // moments (done/failed) appear briefly and auto-hide; idle shows
        // nothing at all.
        if (_activePermission is not null)
        {
            var permissionColor = System.Windows.Media.Color.FromRgb(255, 196, 92);
            _glowColorTarget = permissionColor;
            _glowOpacityTarget = 0.5;
            _moodBubbleTransientUntilUtc = null;
            ShowMoodBubble(
                _permissionDecisionSending
                    ? "sending..."
                    : PermissionSummary(_activePermission),
                permissionColor, 0);
            if (!string.Equals(previousPermissionId, _activePermission.RequestId, StringComparison.Ordinal))
            {
                // Throttle balloon spam: at most one per 30s, and never when the same
                // permission was already shown recently (agent retry loops).
                var now = DateTime.UtcNow;
                if (now - _lastBalloonUtc > TimeSpan.FromSeconds(30))
                {
                    _trayIcon?.ShowBalloonTip(
                        5000,
                        "Trylo needs permission",
                        PermissionSummary(_activePermission),
                        Forms.ToolTipIcon.Warning);
                    _lastBalloonUtc = now;
                }
            }
        }
        else if (IsWorkingState(state) || state == "waiting_output")
        {
            // Running task: the desktop sends the current file name / command
            // as `detail` (optionally with a trailing "  +N" sibling-task
            // suffix for runs inside the same desktop). Fall back to a light
            // verb while the model is thinking between tool calls.
            var detail = client?.Detail ?? "";
            var siblingTasks = ExtractPeerSuffix(ref detail);
            var text = string.IsNullOrWhiteSpace(detail)
                ? $"{StateLabel(state)}…"
                : detail.Trim();
            _moodBubbleTransientUntilUtc = null;
            ShowMoodBubble(text, stateColor, workingPeers + siblingTasks);
        }
        else if (state == "done")
        {
            _moodBubbleTransientUntilUtc = DateTime.UtcNow.AddSeconds(5);
            ShowMoodBubble("all done! ✨", stateColor, 0);
        }
        else if (state == "failed")
        {
            _moodBubbleTransientUntilUtc = DateTime.UtcNow.AddSeconds(8);
            ShowMoodBubble("something went wrong...", stateColor, 0);
        }
        else if (state == "stalled")
        {
            // Waiting on the user (no actionable permission payload) — stays
            // until the next state transition.
            _moodBubbleTransientUntilUtc = null;
            ShowMoodBubble("need attention!", stateColor, 0);
        }
        else
        {
            _moodBubbleTransientUntilUtc = null;
            HideMoodBubble();
        }

        if (!string.Equals(previousState, state, StringComparison.Ordinal))
        {
            var now = DateTime.UtcNow;
            _animationState = "";
            _doneSinceUtc = state == "done" ? now : null;
            if (IsWorkingState(state))
            {
                if (!wasWorking) _workSessionStartedUtc = now;
                _workStateChangedUtc = now;
            }
            if (state is "done" or "failed")
            {
                _trayIcon?.ShowBalloonTip(
                    3500,
                    state == "done" ? "Trylo task complete" : "Trylo task needs attention",
                    client?.Detail ?? "",
                    state == "done" ? Forms.ToolTipIcon.Info : Forms.ToolTipIcon.Warning);
            }
        }
        UpdateWindowVisibility();
    }

    /// <summary>Strip the desktop's trailing "  +N" sibling-task suffix from a
    /// detail string and return N (0 when absent). The suffix travels inside
    /// `detail` because the pet protocol has no count field; an older pet that
    /// doesn't parse it simply renders the text as-is.</summary>
    private static int ExtractPeerSuffix(ref string detail)
    {
        if (string.IsNullOrEmpty(detail)) return 0;
        var match = System.Text.RegularExpressions.Regex.Match(
            detail, @"\s+\+(\d+)\s*$");
        if (!match.Success) return 0;
        detail = detail.Substring(0, match.Index);
        return int.Parse(match.Groups[1].Value);
    }

    private void ShowMoodBubble(string text, System.Windows.Media.Color accent, int peerTaskCount = 0)
    {
        MoodText.Text = text;
        if (peerTaskCount > 0)
        {
            MoodMeta.Text = $"+{peerTaskCount}";
            MoodMeta.Visibility = Visibility.Visible;
            MoodMeta.ToolTip = $"{peerTaskCount + 1} tasks running";
        }
        else
        {
            MoodMeta.Text = "";
            MoodMeta.Visibility = Visibility.Collapsed;
            MoodMeta.ToolTip = null;
        }
        var bg = System.Windows.Media.Color.FromArgb(0xE8, 0x1C, 0x24, 0x33);
        MoodBubbleBg.Color = bg;
        MoodTailFill.Color = bg;

        PermissionActions.Visibility = _activePermission is not null
            ? Visibility.Visible
            : Visibility.Collapsed;
        AllowPermissionButton.IsEnabled = !_permissionDecisionSending;
        DenyPermissionButton.IsEnabled = !_permissionDecisionSending;

        if (!_moodBubbleVisible)
        {
            _moodBubbleVisible = true;
            _moodBubbleShownUtc = DateTime.UtcNow;
            MoodBubble.Visibility = Visibility.Visible;
            MoodTail.Visibility = Visibility.Visible;
            MoodBubble.Opacity = 0;
            MoodTail.Opacity = 0;
            FadeElement(MoodBubble, 0, 1, 220);
            FadeElement(MoodTail, 0, 1, 220);
        }
    }

    private void HideMoodBubble()
    {
        _moodBubbleTransientUntilUtc = null;
        if (!_moodBubbleVisible) return;
        _moodBubbleVisible = false;
        FadeElement(MoodBubble, 1, 0, 280, () => MoodBubble.Visibility = Visibility.Collapsed);
        FadeElement(MoodTail, 1, 0, 280, () => MoodTail.Visibility = Visibility.Collapsed);
    }

    /// <summary>Auto-hide transient bubbles (done / failed) once their deadline
    /// passes and the pet is still in that terminal state. A new task or a
    /// permission clears the deadline, so the bubble never hides early.</summary>
    private void ExpireTransientBubble()
    {
        if (!_moodBubbleTransientUntilUtc.HasValue || !_moodBubbleVisible) return;
        if (DateTime.UtcNow < _moodBubbleTransientUntilUtc.Value) return;
        var state = _activeClient?.State ?? "idle";
        if (state is "done" or "failed" && _activePermission is null)
        {
            HideMoodBubble();
        }
        else
        {
            _moodBubbleTransientUntilUtc = null;
        }
    }

    private static void FadeElement(UIElement element, double from, double to,
        int durationMs, Action? onCompleted = null)
    {
        var anim = new System.Windows.Media.Animation.DoubleAnimation(from, to,
            TimeSpan.FromMilliseconds(durationMs))
        {
            EasingFunction = new System.Windows.Media.Animation.SineEase
            {
                EasingMode = to > from
                    ? System.Windows.Media.Animation.EasingMode.EaseOut
                    : System.Windows.Media.Animation.EasingMode.EaseIn,
            },
        };
        if (onCompleted is not null)
            anim.Completed += (_, _) => onCompleted();
        element.BeginAnimation(UIElement.OpacityProperty, anim);
    }

    private static bool IsPendingPermission(PetPermissionRequest? permission) =>
        permission is not null &&
        !string.IsNullOrWhiteSpace(permission.RequestId) &&
        (string.IsNullOrWhiteSpace(permission.ApprovalState) ||
         permission.ApprovalState.Equals("pending", StringComparison.OrdinalIgnoreCase));

    private static string FirstNonEmpty(params string[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private static string PermissionSummary(PetPermissionRequest permission)
    {
        var title = FirstNonEmpty(permission.Title, "Permission required");
        return string.IsNullOrWhiteSpace(permission.Detail) || permission.Detail.Equals(title, StringComparison.Ordinal)
            ? title
            : $"{title}: {permission.Detail}";
    }

    private void OnPetMouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (!_pointerInside)
        {
            _pointerEnteredUtc = DateTime.UtcNow;
            _animationState = "";
            ResetHoverDirection();
        }
        _pointerInside = true;
    }

    private void OnPetMouseLeave(object sender, System.Windows.Input.MouseEventArgs e)
    {
        _pointerInside = false;
        _animationState = "";
        ResetHoverDirection();
    }

    private async void OnPermissionAllowClick(object sender, RoutedEventArgs e) =>
        await SubmitPermissionDecisionAsync("allow");

    private async void OnPermissionDenyClick(object sender, RoutedEventArgs e) =>
        await SubmitPermissionDecisionAsync("deny");

    private async Task SubmitPermissionDecisionAsync(string decision)
    {
        if (_permissionDecisionSending || _activePermission is null || _activeClient is null || _server is null) return;
        _permissionDecisionSending = true;
        AllowPermissionButton.IsEnabled = false;
        DenyPermissionButton.IsEnabled = false;
        MoodText.Text = "sending...";
        var sent = await _server.SendPermissionDecisionAsync(
            _activeClient.ClientId,
            _activePermission.RequestId,
            decision);
        if (sent)
        {
            var submittedRequestId = _activePermission.RequestId;
            await Task.Delay(3000);
            if (_activePermission?.RequestId != submittedRequestId || !_permissionDecisionSending) return;
        }

        _permissionDecisionSending = false;
        AllowPermissionButton.IsEnabled = true;
        DenyPermissionButton.IsEnabled = true;
        MoodText.Text = "couldn't reach, try again";
    }

    private void AnimatePet()
    {
        var now = DateTime.UtcNow;
        var dt = _lastTickUtc == DateTime.MinValue
            ? 0.016
            : Math.Clamp((now - _lastTickUtc).TotalSeconds, 0.001, 0.05);
        _lastTickUtc = now;
        UpdatePetMotion(dt);
        UpdateGlow(dt);
        var state = _activeClient?.State ?? "idle";

        if (_pointerInside && !_dragging)
        {
            RestPose();
            AnimateHoverReaction();
            return;
        }

        if (IsWorkingState(state))
        {
            RestPose();
            AnimateWorkingPlaylist(state);
            return;
        }

        if (state == "done")
        {
            AnimateDoneSequence();
            return;
        }

        RestPose();
        _targetBobY = Math.Sin(_breathPhase * 1.4) * 0.7;
        var (row, durations) = state switch
        {
            "failed" or "stalled" => (5, FailedDurations),
            "waiting_output" => (6, WaitingDurations),
            _ => (0, IdleDurations),
        };
        AdvanceAnimation($"state:{state}", row, durations);
    }

    // ── Glow: smooth colour + opacity lerp with gentle pulse ──────────
    private void UpdateGlow(double dt)
    {
        const double lerpSpeed = 4.0;
        _glowColor = LerpColor(_glowColor, _glowColorTarget, Math.Min(1, lerpSpeed * dt));
        _glowOpacity += (_glowOpacityTarget - _glowOpacity) * Math.Min(1, lerpSpeed * dt);

        _glowPulsePhase += dt;
        var pulse = Math.Sin(_glowPulsePhase * 2.4) * 0.08;
        var finalOpacity = Math.Clamp(_glowOpacity + pulse, 0, 0.7);

        BodyGlow.Fill = new SolidColorBrush(_glowColor);
        BodyGlow.Opacity = finalOpacity;
        ((System.Windows.Media.Effects.BlurEffect)BodyGlow.Effect).Radius = 38 + Math.Sin(_glowPulsePhase * 1.6) * 4;
    }

    private static System.Windows.Media.Color LerpColor(
        System.Windows.Media.Color a, System.Windows.Media.Color b, double t)
    {
        t = Math.Clamp(t, 0, 1);
        return System.Windows.Media.Color.FromRgb(
            (byte)(a.R + (b.R - a.R) * t),
            (byte)(a.G + (b.G - a.G) * t),
            (byte)(a.B + (b.B - a.B) * t));
    }

    private void AnimateHoverReaction()
    {
        var elapsedMilliseconds = Math.Max(0, (DateTime.UtcNow - _pointerEnteredUtc).TotalMilliseconds);
        if (TryResolveHoverDirectionPosition(out var directionPosition))
        {
            SetPointerLookFrame(directionPosition);
            return;
        }

        ResetHoverDirection();
        var cyclePosition = elapsedMilliseconds % 5200;
        if (cyclePosition < 2600)
        {
            AdvanceAnimation("hover:center-wave", 3, WaveDurations);
            return;
        }

        _targetBobY = Math.Sin(elapsedMilliseconds / 360) * 1.1;
        AdvanceAnimation("hover:center-idle", 0, IdleDurations);
    }

    private bool TryResolveHoverDirectionPosition(out double directionPosition)
    {
        double deltaX;
        double deltaY;
        if (_qaPointerOffset is { } qaOffset)
        {
            deltaX = qaOffset.X;
            deltaY = qaOffset.Y;
        }
        else
        {
            var faceCenter = PetSprite.TranslatePoint(
                new System.Windows.Point(PetSprite.ActualWidth * 0.5, PetSprite.ActualHeight * 0.34),
                this);
            var pointer = Mouse.GetPosition(this);
            deltaX = pointer.X - faceCenter.X;
            deltaY = pointer.Y - faceCenter.Y;
        }

        var distance = Math.Sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance < 22)
        {
            directionPosition = 0;
            return false;
        }

        var unitX = deltaX / distance;
        var unitY = deltaY / distance;
        if (!_hasSmoothedPointerDirection)
        {
            _smoothedPointerX = unitX;
            _smoothedPointerY = unitY;
            _hasSmoothedPointerDirection = true;
        }
        else
        {
            const double smoothing = 0.2;
            _smoothedPointerX += (unitX - _smoothedPointerX) * smoothing;
            _smoothedPointerY += (unitY - _smoothedPointerY) * smoothing;
            var smoothedLength = Math.Sqrt(
                _smoothedPointerX * _smoothedPointerX + _smoothedPointerY * _smoothedPointerY);
            if (smoothedLength > 0.0001)
            {
                _smoothedPointerX /= smoothedLength;
                _smoothedPointerY /= smoothedLength;
            }
        }

        var clockwiseDegrees = Math.Atan2(_smoothedPointerX, -_smoothedPointerY) * 180 / Math.PI;
        if (clockwiseDegrees < 0) clockwiseDegrees += 360;
        directionPosition = clockwiseDegrees / 22.5;
        return true;
    }

    private void SetPointerLookFrame(double directionPosition)
    {
        directionPosition %= 16;
        if (directionPosition < 0) directionPosition += 16;
        RequestBob(_smoothedPointerX * 2.2, _smoothedPointerY * 1.4);
        PetRotation.Angle = _smoothedPointerX * 1.2;
        var nearestIndex = (int)Math.Round(directionPosition, MidpointRounding.AwayFromZero) % 16;
        if (_hoverDirectionIndex < 0)
        {
            _hoverDirectionIndex = nearestIndex;
        }
        else
        {
            var distanceFromCurrent = directionPosition - _hoverDirectionIndex;
            if (distanceFromCurrent > 8) distanceFromCurrent -= 16;
            if (distanceFromCurrent < -8) distanceFromCurrent += 16;
            const double switchThreshold = 0.58;
            if (Math.Abs(distanceFromCurrent) >= switchThreshold)
            {
                _hoverDirectionIndex = nearestIndex;
            }
        }
        SetSpriteFrame(_hoverDirectionIndex < 8 ? 9 : 10, _hoverDirectionIndex % 8);
    }

    private void ResetHoverDirection()
    {
        _hasSmoothedPointerDirection = false;
        _smoothedPointerX = 0;
        _smoothedPointerY = 0;
        _hoverDirectionIndex = -1;
    }

    private void AnimateWorkingPlaylist(string state)
    {
        var now = DateTime.UtcNow;
        if (now - _workStateChangedUtc < TimeSpan.FromMilliseconds(1800))
        {
            PlayWorkClip(state, WorkClip.Primary, $"work:{state}:primary-transition", 0, 1800);
            return;
        }

        var cycleDuration = WorkPlaylist.Sum(segment => segment.DurationMilliseconds);
        var cyclePosition = (int)((now - _workSessionStartedUtc).TotalMilliseconds % cycleDuration);
        for (var index = 0; index < WorkPlaylist.Length; index++)
        {
            var segment = WorkPlaylist[index];
            if (cyclePosition < segment.DurationMilliseconds)
            {
                PlayWorkClip(
                    state,
                    segment.Clip,
                    $"work:{state}:{index}:{segment.Clip}",
                    cyclePosition,
                    segment.DurationMilliseconds);
                return;
            }
            cyclePosition -= segment.DurationMilliseconds;
        }
    }

    private void PlayWorkClip(string state, WorkClip clip, string animationKey, int elapsed, int duration)
    {
        if (clip == WorkClip.Primary)
        {
            clip = state switch
            {
                "thinking" or "planning" => WorkClip.Analyzing,
                "running_command" or "program_running" => WorkClip.Terminal,
                _ => WorkClip.Coding,
            };
        }

        switch (clip)
        {
            case WorkClip.Analyzing:
                AdvanceActionAnimation("analyzing", AnalyzingDurations, animationKey);
                break;
            case WorkClip.Coding:
                AdvanceAnimation(animationKey, 7, CodingDurations);
                break;
            case WorkClip.Terminal:
                AdvanceActionAnimation("terminal", TerminalDurations, animationKey);
                break;
            case WorkClip.Review:
                AdvanceAnimation(animationKey, 8, ReviewDurations);
                break;
            case WorkClip.LookAround:
                AdvanceLookAnimation(animationKey);
                break;
            case WorkClip.Pace:
                AnimatePace(animationKey, elapsed, duration);
                break;
            case WorkClip.Wave:
                AdvanceAnimation(animationKey, 3, WaveDurations);
                break;
        }
    }

    private void AnimatePace(string animationKey, int elapsed, int duration)
    {
        var movingRight = elapsed < duration / 2;
        var halfDuration = Math.Max(1, duration / 2);
        var halfElapsed = movingRight ? elapsed : elapsed - halfDuration;
        var progress = Math.Clamp((double)halfElapsed / halfDuration, 0, 1);
        var eased = movingRight ? EaseOutSine(progress) : 1 - EaseOutSine(progress);
        PetTranslation.X = -9 + 18 * eased;
        PetRotation.Angle = (movingRight ? -1 : 1) * 2.2 * Math.Sin(progress * Math.PI);
        RequestSquash(1.03, 0.97);
        AdvanceAnimation($"{animationKey}:{(movingRight ? "right" : "left")}", movingRight ? 1 : 2, RunDurations);
    }

    private void AdvanceLookAnimation(string animationKey)
    {
        var now = DateTime.UtcNow;
        if (!string.Equals(_animationState, animationKey, StringComparison.Ordinal))
        {
            _animationState = animationKey;
            _animationFrame = 0;
            _frameDeadlineUtc = now.AddMilliseconds(220);
        }
        else if (now >= _frameDeadlineUtc)
        {
            _animationFrame = (_animationFrame + 1) % LookAroundFrames.Length;
            _frameDeadlineUtc = now.AddMilliseconds(_animationFrame is 0 or 5 ? 360 : 220);
        }
        var frame = LookAroundFrames[_animationFrame];
        SetSpriteFrame(frame.Row, frame.Column);
    }

    private void AnimateDoneSequence()
    {
        var elapsed = DateTime.UtcNow - (_doneSinceUtc ?? DateTime.UtcNow);
        if (elapsed < TimeSpan.FromMilliseconds(2400))
        {
            var jump = (elapsed.TotalMilliseconds % 600) / 600;
            var arc = Math.Sin(jump * Math.PI);
            _targetBobY = -14 * arc;
            if (jump < 0.18) RequestSquash(0.88, 1.1);
            else if (jump > 0.82) RequestSquash(1.1, 0.9);
            else RestPose();
            AdvanceAnimation("done:jump", 4, JumpDurations);
        }
        else if (elapsed < TimeSpan.FromMilliseconds(5000))
        {
            RestPose();
            AdvanceAnimation("done:wave", 3, WaveDurations);
        }
        else if (elapsed < TimeSpan.FromMilliseconds(9000))
        {
            RestPose();
            AdvanceActionAnimation("driving", DrivingDurations, "done:driving");
        }
        else
        {
            RestPose();
            _targetBobY = Math.Sin(_breathPhase * 1.4) * 0.7;
            AdvanceAnimation("done:idle", 0, IdleDurations);
        }
    }

    private void AdvanceAnimation(string state, int row, int[] durations)
    {
        var now = DateTime.UtcNow;
        if (!string.Equals(_animationState, state, StringComparison.Ordinal))
        {
            _animationState = state;
            _animationFrame = 0;
            _frameDeadlineUtc = now.AddMilliseconds(durations[0]);
        }
        else if (now >= _frameDeadlineUtc)
        {
            _animationFrame = (_animationFrame + 1) % durations.Length;
            _frameDeadlineUtc = now.AddMilliseconds(durations[_animationFrame]);
        }
        SetSpriteFrame(row, _animationFrame);
    }

    private void AdvanceActionAnimation(string action, int[] durations, string? animationKey = null)
    {
        if (!_actionFrames.TryGetValue(action, out var frames) || frames.Length == 0) return;
        var now = DateTime.UtcNow;
        var stateKey = animationKey ?? $"action:{action}";
        if (!string.Equals(_animationState, stateKey, StringComparison.Ordinal))
        {
            _animationState = stateKey;
            _animationFrame = 0;
            _frameDeadlineUtc = now.AddMilliseconds(durations[0]);
        }
        else if (now >= _frameDeadlineUtc)
        {
            _animationFrame = (_animationFrame + 1) % frames.Length;
            _frameDeadlineUtc = now.AddMilliseconds(durations[_animationFrame % durations.Length]);
        }
        SetActionFrame(action, _animationFrame);
    }

    private void SetSpriteFrame(int row, int column)
    {
        if (_displayedAction.Length == 0 && _displayedRow == row && _displayedColumn == column) return;
        _displayedAction = "";
        _displayedRow = row;
        _displayedColumn = column;
        PetSprite.Source = new CroppedBitmap(_atlas, new Int32Rect(column * 192, row * 208, 192, 208));
    }

    private void SetActionFrame(string action, int frame)
    {
        if (!_actionFrames.TryGetValue(action, out var frames) || frames.Length == 0) return;
        frame %= frames.Length;
        if (_displayedAction == action && _displayedColumn == frame) return;
        _displayedAction = action;
        _displayedRow = -1;
        _displayedColumn = frame;
        PetSprite.Source = frames[frame];
    }

    private static BitmapSource LoadAtlas()
    {
        var atlasPath = Path.Combine(AppContext.BaseDirectory, "assets", "trylo-miu.png");
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.UriSource = new Uri(atlasPath, UriKind.Absolute);
        image.EndInit();
        image.Freeze();
        return image;
    }

    private static IReadOnlyDictionary<string, BitmapSource[]> LoadActionFrames()
    {
        var result = new Dictionary<string, BitmapSource[]>(StringComparer.Ordinal);
        var root = Path.Combine(AppContext.BaseDirectory, "assets", "actions");
        foreach (var action in new[] { "analyzing", "terminal", "driving" })
        {
            var actionDir = Path.Combine(root, action);
            if (!Directory.Exists(actionDir)) continue;
            result[action] = Directory.GetFiles(actionDir, "*.png")
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .Select(LoadBitmap)
                .ToArray();
        }
        return result;
    }

    private static BitmapSource LoadBitmap(string path)
    {
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.UriSource = new Uri(path, UriKind.Absolute);
        image.EndInit();
        image.Freeze();
        return image;
    }

    private void CheckClientLifetime()
    {
        ExpireTransientBubble();
        var current = _server?.GetActiveClient();
        if (current is not null)
        {
            _lastClientUtc = DateTime.UtcNow;
            UpdateWindowVisibility();
            return;
        }
        ApplyClient(null);
        if (DateTime.UtcNow - _lastClientUtc > TimeSpan.FromSeconds(16))
        {
            Close();
        }
    }

    private void UpdateWindowVisibility()
    {
        if (_qaRender) return;
        if (_activeClient is null)
        {
            if (_settings.ShowOnlyWhenMinimized) Hide();
            return;
        }

        var windowState = WindowActivator.GetWorkspaceWindowState(_activeClient.WorkspaceName);
        var shouldShow = _activePermission is not null ||
            !_settings.ShowOnlyWhenMinimized ||
            windowState != WorkspaceWindowState.Visible;
        if (shouldShow && !IsVisible) Show();
        else if (!shouldShow && IsVisible) Hide();
    }

    private void OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _mouseDown = e.GetPosition(this);
        _dragging = false;
        CaptureMouse();
    }

    private void OnMouseMove(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed || !IsMouseCaptured) return;
        var point = e.GetPosition(this);
        if (!_dragging && (Math.Abs(point.X - _mouseDown.X) > 5 || Math.Abs(point.Y - _mouseDown.Y) > 5))
        {
            _dragging = true;
            ReleaseMouseCapture();
            try { DragMove(); } catch { }
        }
    }

    private void OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (IsMouseCaptured) ReleaseMouseCapture();
        if (!_dragging) RestoreTrylo();
        _dragging = false;
    }

    private void OnMouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        _trayIcon.ContextMenuStrip?.Show(Forms.Cursor.Position);
    }

    private void RestoreTrylo()
    {
        WindowActivator.RestoreOrOpen(_activeClient?.WorkspacePath ?? "", _activeClient?.WorkspaceName ?? "");
    }

    private void RestorePosition()
    {
        if (!double.IsNaN(_settings.Left) && !double.IsNaN(_settings.Top))
        {
            var virtualScreen = Forms.SystemInformation.VirtualScreen;
            Left = Math.Clamp(_settings.Left, virtualScreen.Left, virtualScreen.Right - Width);
            Top = Math.Clamp(_settings.Top, virtualScreen.Top, virtualScreen.Bottom - Height);
            return;
        }
        var area = SystemParameters.WorkArea;
        Left = area.Right - Width - 24;
        Top = area.Bottom - Height - 28;
    }

    private void SavePosition()
    {
        if (WindowState != WindowState.Normal) return;
        _settings.Left = Left;
        _settings.Top = Top;
        _settings.Save();
    }

    /// <summary>
    /// Pull the pet back onto a visible screen (audit §4.2 PET-P0-5).
    /// </summary>
    internal void ClampIntoScreen()
    {
        try
        {
            var virtualScreen = Forms.SystemInformation.VirtualScreen;
            var maxLeft = Math.Max(virtualScreen.Left, virtualScreen.Right - Math.Min(Width, 96));
            var maxTop = Math.Max(virtualScreen.Top, virtualScreen.Bottom - Math.Min(Height, 96));
            var isOffScreen =
                Left < virtualScreen.Left - 1 ||
                Top < virtualScreen.Top - 1 ||
                Left > virtualScreen.Right - 8 ||
                Top > virtualScreen.Bottom - 8;
            if (!isOffScreen) return;
            Left = Math.Clamp(Left, virtualScreen.Left, maxLeft);
            Top = Math.Clamp(Top, virtualScreen.Top, maxTop);
            SavePosition();
        }
        catch
        {
            // A geometry failure must never break the wake-up path.
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _animationTimer.Stop();
        _clientTimer.Stop();
        _server?.Dispose();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
    }

    private static string StateLabel(string state) => state switch
    {
        "thinking" => "Analyzing",
        "planning" => "Planning",
        "writing_files" => "Coding",
        "running_command" => "Terminal",
        "program_running" => "Terminal",
        "waiting_output" => "Waiting",
        "stalled" => "Attention",
        "done" => "Complete",
        "failed" => "Failed",
        _ => "Ready",
    };

    private static bool IsWorkingState(string state) => state is
        "thinking" or "planning" or "writing_files" or "running_command" or "program_running";

    private static System.Windows.Media.Color StateColor(string state) => state switch
    {
        "done" => System.Windows.Media.Color.FromRgb(86, 214, 160),
        "failed" => System.Windows.Media.Color.FromRgb(255, 111, 120),
        "stalled" or "waiting_output" => System.Windows.Media.Color.FromRgb(255, 196, 92),
        "running_command" or "program_running" => System.Windows.Media.Color.FromRgb(88, 178, 255),
        "writing_files" => System.Windows.Media.Color.FromRgb(117, 226, 187),
        _ => System.Windows.Media.Color.FromRgb(140, 212, 255),
    };

    // ── Motion smoothing ────────────────────────────────────────────────

    private double _squashX = 1;
    private double _squashY = 1;
    private double _squashVX;
    private double _squashVY;
    private double _bobX;
    private double _bobVX;
    private double _bobY;
    private double _bobVY;
    private double _targetSquashX = 1;
    private double _targetSquashY = 1;
    private double _targetBobX;
    private double _targetBobY;
    private DateTime _lastTickUtc = DateTime.MinValue;
    private double _breathPhase;

    private static double Spring(ref double value, ref double velocity, double target,
        double stiffness, double damping, double dt)
    {
        var acceleration = (target - value) * stiffness - velocity * damping;
        velocity += acceleration * dt;
        value += velocity * dt;
        return value;
    }

    private static double EaseOutSine(double t) => Math.Sin(t * Math.PI / 2);

    private void UpdatePetMotion(double dt)
    {
        const double stiffness = 170;
        const double damping = 18;
        Spring(ref _squashX, ref _squashVX, _targetSquashX, stiffness, damping, dt);
        Spring(ref _squashY, ref _squashVY, _targetSquashY, stiffness, damping, dt);
        Spring(ref _bobX, ref _bobVX, _targetBobX, stiffness * 0.7, damping * 0.9, dt);
        Spring(ref _bobY, ref _bobVY, _targetBobY, stiffness * 0.7, damping * 0.9, dt);

        _breathPhase += dt;
        var breath = Math.Sin(_breathPhase * 2.1) * 0.012;
        var scaleX = _squashX * (1 + breath);
        var scaleY = _squashY * (1 - breath);
        scaleY = Math.Max(0.4, scaleY);
        scaleX = Math.Max(0.4, Math.Min(scaleX, 2 - scaleY + 1));

        PetScale.ScaleX = scaleX;
        PetScale.ScaleY = scaleY;
        PetTranslation.X = _bobX;
        PetTranslation.Y = _bobY;
    }

    private void RequestSquash(double scaleX, double scaleY)
    {
        _targetSquashX = scaleX;
        _targetSquashY = scaleY;
    }

    private void RequestBob(double x, double y)
    {
        _targetBobX = x;
        _targetBobY = y;
    }

    private void RestPose()
    {
        _targetSquashX = 1;
        _targetSquashY = 1;
        _targetBobX = 0;
        _targetBobY = 0;
    }
}
