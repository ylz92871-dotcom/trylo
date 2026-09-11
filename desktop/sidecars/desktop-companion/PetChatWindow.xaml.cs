using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MediaColor = System.Windows.Media.Color;

namespace TryloDesktopPet;

public partial class PetChatWindow : Window
{
    private readonly CompanionServer? _server;
    private PetMessage? _activeClient;
    private string _activeRequestId = "";
    private string _streamedText = "";
    private TextBlock? _streamingTextBlock;
    private FrameworkElement? _streamingContainer;
    private readonly object _pendingDeltaGate = new();
    private readonly StringBuilder _pendingDelta = new();
    private string _pendingDeltaClientId = "";
    private string _pendingDeltaRequestId = "";
    private readonly DispatcherTimer _streamUiTimer = new() { Interval = TimeSpan.FromMilliseconds(50) };
    private int _activityFrame;
    private bool _scrollPending;
    private bool _busy;

    internal PetChatWindow(CompanionServer server, PetMessage? activeClient)
    {
        InitializeComponent();
        InitializeUiBehavior();
        _server = server;
        _activeClient = activeClient;
        _server.ActiveClientChanged += OnActiveClientChanged;
        _server.ChatEventReceived += OnChatEventReceived;
        _server.ChatConnectionChanged += OnChatConnectionChanged;
        Loaded += OnLoaded;
        Closed += OnClosed;
        UpdateConnectionUi(false);
    }

    internal PetChatWindow()
    {
        InitializeComponent();
        InitializeUiBehavior();
        Loaded += (_, _) =>
        {
            UpdateConnectionUi(true, "答辩冲刺工作区");
            RenderHistory(new List<PetChatHistoryItem>
            {
                new() { Role = "assistant", Text = "晚上好，我是 Trylo。桌面聊天只做轻量交流，不会改动你的项目文件。", At = DateTimeOffset.Now.AddMinutes(-4).ToUnixTimeMilliseconds() },
                new() { Role = "user", Text = "帮我把明天答辩的项目亮点整理成三句话。", At = DateTimeOffset.Now.AddMinutes(-3).ToUnixTimeMilliseconds() },
                new() { Role = "assistant", Text = "可以。我们先抓住创新点、工程完成度和实际效果，再把每句话控制在 20 秒内能讲清楚。", At = DateTimeOffset.Now.AddMinutes(-2).ToUnixTimeMilliseconds() },
            });
        };
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        UpdateConnectionUi(_activeClient is not null);
        ChatInput.Focus();
        await RequestHistoryAsync();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _streamUiTimer.Stop();
        if (_server is null) return;
        _server.ActiveClientChanged -= OnActiveClientChanged;
        _server.ChatEventReceived -= OnChatEventReceived;
        _server.ChatConnectionChanged -= OnChatConnectionChanged;
    }

    private void OnActiveClientChanged(PetMessage? client, int workingPeers = 0) =>
        Dispatcher.InvokeAsync(async () =>
        {
            var changed = !string.Equals(_activeClient?.ClientId, client?.ClientId, StringComparison.Ordinal);
            _activeClient = client;
            UpdateConnectionUi(client is not null);
            if (changed)
            {
                SetBusy(false);
                MessagesHost.Children.Clear();
                EmptyState.Visibility = Visibility.Visible;
                _streamedText = "";
                _streamingTextBlock = null;
                _streamingContainer = null;
                await RequestHistoryAsync();
            }
        });

    private void OnChatConnectionChanged(string clientId, bool connected)
    {
        Dispatcher.InvokeAsync(async () =>
        {
            if (!string.Equals(_activeClient?.ClientId, clientId, StringComparison.Ordinal)) return;
            UpdateConnectionUi(connected);
            if (connected) await RequestHistoryAsync();
        });
    }

    private void InitializeUiBehavior() => _streamUiTimer.Tick += OnStreamUiTick;

    private void OnChatEventReceived(PetChatEnvelope message)
    {
        if (message.Type == "chat_delta")
        {
            lock (_pendingDeltaGate)
            {
                _pendingDeltaClientId = message.ClientId;
                _pendingDeltaRequestId = message.RequestId;
                _pendingDelta.Append(message.Delta);
            }
            return;
        }

        Dispatcher.InvokeAsync(() =>
        {
            FlushPendingStreamDelta();
            ApplyChatEvent(message);
        });
    }

    private void ApplyChatEvent(PetChatEnvelope message)
    {
        if (!string.Equals(message.ClientId, _activeClient?.ClientId, StringComparison.Ordinal)) return;
        switch (message.Type)
        {
            case "chat_history":
                RenderHistory(message.Messages);
                UpdateConnectionUi(true);
                break;
            case "chat_started":
                if (!string.IsNullOrWhiteSpace(message.RequestId)) _activeRequestId = message.RequestId;
                EnsureStreamingBubble();
                SetBusy(true);
                break;
            case "chat_delta":
                ApplyStreamDelta(message.ClientId, message.RequestId, message.Delta);
                break;
            case "chat_complete":
                if (!MatchesActiveRequest(message.RequestId)) return;
                EnsureStreamingBubble();
                if (string.IsNullOrWhiteSpace(_streamedText) && !string.IsNullOrWhiteSpace(message.Text))
                {
                    _streamedText = message.Text;
                    if (_streamingTextBlock is not null) _streamingTextBlock.Text = _streamedText;
                }
                CompleteStreamingBubble();
                _activeRequestId = "";
                SetBusy(false);
                break;
            case "chat_error":
                if (!string.IsNullOrWhiteSpace(message.RequestId) && !MatchesActiveRequest(message.RequestId)) return;
                RemoveEmptyStreamingBubble();
                AddSystemMessage(string.IsNullOrWhiteSpace(message.Error) ? "桌面 Chat 请求失败，请稍后重试。" : message.Error);
                _activeRequestId = "";
                SetBusy(false);
                break;
            case "chat_cleared":
                MessagesHost.Children.Clear();
                EmptyState.Visibility = Visibility.Visible;
                _activeRequestId = "";
                _streamedText = "";
                _streamingTextBlock = null;
                _streamingContainer = null;
                ClearPendingStreamDelta();
                SetBusy(false);
                break;
        }
    }

    private void OnStreamUiTick(object? sender, EventArgs e)
    {
        FlushPendingStreamDelta();
        if (!_busy)
        {
            _streamUiTimer.Stop();
            return;
        }

        _activityFrame++;
        ActivityDot.Opacity = 0.48 + 0.52 * (0.5 + 0.5 * Math.Sin(_activityFrame * 0.62));
        var dots = new string('·', 1 + (_activityFrame / 5) % 3);
        if (string.IsNullOrWhiteSpace(_streamedText))
        {
            BusyText.Text = $"Trylo 正在思考 {dots}";
            if (_streamingTextBlock is not null) _streamingTextBlock.Text = $"正在思考 {dots}";
        }
        else
        {
            BusyText.Text = $"Trylo 正在回复 {dots}";
        }
    }

    private void FlushPendingStreamDelta()
    {
        string clientId;
        string requestId;
        string delta;
        lock (_pendingDeltaGate)
        {
            if (_pendingDelta.Length == 0) return;
            clientId = _pendingDeltaClientId;
            requestId = _pendingDeltaRequestId;
            delta = _pendingDelta.ToString();
            _pendingDelta.Clear();
        }
        ApplyStreamDelta(clientId, requestId, delta);
    }

    private void ApplyStreamDelta(string clientId, string requestId, string delta)
    {
        if (!string.Equals(clientId, _activeClient?.ClientId, StringComparison.Ordinal) ||
            !MatchesActiveRequest(requestId) || string.IsNullOrEmpty(delta)) return;
        EnsureStreamingBubble();
        _streamedText += delta;
        if (_streamingTextBlock is not null)
        {
            _streamingTextBlock.Text = _streamedText;
            _streamingTextBlock.FontStyle = FontStyles.Normal;
            _streamingTextBlock.Foreground = new SolidColorBrush(MediaColor.FromRgb(232, 237, 243));
        }
        BusyText.Text = "Trylo 正在回复";
        ScrollToBottom();
    }

    private void ClearPendingStreamDelta()
    {
        lock (_pendingDeltaGate)
        {
            _pendingDelta.Clear();
            _pendingDeltaClientId = "";
            _pendingDeltaRequestId = "";
        }
    }

    private bool MatchesActiveRequest(string requestId) =>
        string.IsNullOrWhiteSpace(requestId) || string.Equals(requestId, _activeRequestId, StringComparison.Ordinal);

    private async Task RequestHistoryAsync()
    {
        if (_server is null || string.IsNullOrWhiteSpace(_activeClient?.ClientId))
        {
            UpdateConnectionUi(false);
            return;
        }
        var sent = await _server.RequestChatHistoryAsync(_activeClient.ClientId);
        UpdateConnectionUi(sent);
    }

    private async void OnSendClick(object sender, RoutedEventArgs e) => await SendCurrentMessageAsync();

    private async Task SendCurrentMessageAsync()
    {
        if (_busy) return;
        var text = ChatInput.Text.Trim();
        if (string.IsNullOrWhiteSpace(text)) return;
        if (_server is null || string.IsNullOrWhiteSpace(_activeClient?.ClientId))
        {
            AddSystemMessage("Trylo 主窗口尚未连接，打开主窗口后再试。 ");
            UpdateConnectionUi(false);
            return;
        }

        _activeRequestId = Guid.NewGuid().ToString("N");
        _streamedText = "";
        _streamingTextBlock = null;
        _streamingContainer = null;
        AddMessageBubble("user", text, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        ChatInput.Clear();
        EnsureStreamingBubble();
        SetBusy(true);
        var sent = await _server.SendChatMessageAsync(_activeClient.ClientId, _activeRequestId, text);
        if (!sent)
        {
            RemoveEmptyStreamingBubble();
            AddSystemMessage("没有连上 Trylo，请确认 Trylo 主窗口仍然打开。 ");
            SetBusy(false);
            UpdateConnectionUi(false);
        }
    }

    private async void OnStopClick(object sender, RoutedEventArgs e)
    {
        if (_server is null || string.IsNullOrWhiteSpace(_activeClient?.ClientId) || string.IsNullOrWhiteSpace(_activeRequestId)) return;
        await _server.CancelChatAsync(_activeClient.ClientId, _activeRequestId);
    }

    private async void OnClearClick(object sender, RoutedEventArgs e)
    {
        if (_server is null || string.IsNullOrWhiteSpace(_activeClient?.ClientId))
        {
            MessagesHost.Children.Clear();
            EmptyState.Visibility = Visibility.Visible;
            return;
        }
        await _server.ClearChatAsync(_activeClient.ClientId);
    }

    private async void OnChatInputPreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != Key.Enter || Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) return;
        e.Handled = true;
        await SendCurrentMessageAsync();
    }

    private void RenderHistory(IEnumerable<PetChatHistoryItem> messages)
    {
        MessagesHost.Children.Clear();
        foreach (var message in messages)
        {
            if (string.IsNullOrWhiteSpace(message.Text)) continue;
            AddMessageBubble(message.Role, message.Text, message.At, scroll: false);
        }
        EmptyState.Visibility = MessagesHost.Children.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        ScrollToBottom();
    }

    private MessageBubbleView AddMessageBubble(string role, string text, long at, bool scroll = true)
    {
        EmptyState.Visibility = Visibility.Collapsed;
        var isUser = role.Equals("user", StringComparison.OrdinalIgnoreCase);
        var wrapper = new Grid
        {
            HorizontalAlignment = isUser ? System.Windows.HorizontalAlignment.Right : System.Windows.HorizontalAlignment.Left,
            MaxWidth = 380,
            Margin = new Thickness(isUser ? 54 : 0, 4, isUser ? 0 : 42, 12),
        };
        if (!isUser)
        {
            wrapper.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            wrapper.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        }
        var meta = new TextBlock
        {
            Text = $"{(isUser ? "你" : "TRYLO")}   {FormatTime(at)}",
            Foreground = new SolidColorBrush(MediaColor.FromRgb(116, 127, 143)),
            FontSize = 9,
            FontWeight = isUser ? FontWeights.Normal : FontWeights.SemiBold,
            Margin = new Thickness(7, 0, 7, 5),
            HorizontalAlignment = isUser ? System.Windows.HorizontalAlignment.Right : System.Windows.HorizontalAlignment.Left,
        };
        var body = new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            Foreground = new SolidColorBrush(isUser ? MediaColor.FromRgb(237, 255, 248) : MediaColor.FromRgb(232, 237, 243)),
            FontSize = 12.8,
            LineHeight = 20,
        };
        var bubble = new Border
        {
            CornerRadius = new CornerRadius(isUser ? 18 : 6, 18, isUser ? 6 : 18, 18),
            Padding = new Thickness(14, 11, 14, 11),
            Background = new SolidColorBrush(isUser ? MediaColor.FromArgb(72, 63, 183, 136) : MediaColor.FromArgb(31, 255, 255, 255)),
            BorderBrush = new SolidColorBrush(isUser ? MediaColor.FromArgb(104, 114, 229, 181) : MediaColor.FromArgb(38, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            Child = body,
        };
        var content = new StackPanel();
        content.Children.Add(meta);
        content.Children.Add(bubble);
        if (isUser)
        {
            wrapper.Children.Add(content);
        }
        else
        {
            var avatar = new Border
            {
                Width = 30,
                Height = 30,
                Margin = new Thickness(0, 13, 9, 0),
                VerticalAlignment = VerticalAlignment.Top,
                CornerRadius = new CornerRadius(10),
                Background = new SolidColorBrush(MediaColor.FromArgb(39, 114, 229, 181)),
                BorderBrush = new SolidColorBrush(MediaColor.FromArgb(75, 114, 229, 181)),
                BorderThickness = new Thickness(1),
                Child = new TextBlock
                {
                    Text = "✦",
                    Foreground = new SolidColorBrush(MediaColor.FromRgb(114, 229, 181)),
                    FontSize = 13,
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                },
            };
            Grid.SetColumn(content, 1);
            wrapper.Children.Add(avatar);
            wrapper.Children.Add(content);
        }
        MessagesHost.Children.Add(wrapper);
        if (scroll) ScrollToBottom();
        return new MessageBubbleView(body, wrapper);
    }

    private void AddSystemMessage(string text)
    {
        var border = new Border
        {
            Margin = new Thickness(24, 5, 24, 10),
            Padding = new Thickness(11, 8, 11, 8),
            CornerRadius = new CornerRadius(11),
            Background = new SolidColorBrush(MediaColor.FromArgb(24, 255, 116, 128)),
            BorderBrush = new SolidColorBrush(MediaColor.FromArgb(58, 255, 116, 128)),
            BorderThickness = new Thickness(1),
            Child = new TextBlock
            {
                Text = text,
                Foreground = new SolidColorBrush(MediaColor.FromRgb(255, 174, 183)),
                FontSize = 10.5,
                TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center,
            },
        };
        MessagesHost.Children.Add(border);
        EmptyState.Visibility = Visibility.Collapsed;
        ScrollToBottom();
    }

    private void EnsureStreamingBubble()
    {
        if (_streamingTextBlock is not null) return;
        var view = AddMessageBubble("assistant", "正在思考 ·", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _streamingTextBlock = view.Body;
        _streamingContainer = view.Container;
        _streamingTextBlock.FontStyle = FontStyles.Italic;
        _streamingTextBlock.Foreground = new SolidColorBrush(MediaColor.FromRgb(148, 223, 193));
    }

    private void CompleteStreamingBubble()
    {
        if (_streamingTextBlock is not null && string.IsNullOrWhiteSpace(_streamedText))
        {
            _streamingTextBlock.Text = "回复完成。";
        }
        _streamingTextBlock = null;
        _streamingContainer = null;
        _streamedText = "";
        _activeRequestId = "";
    }

    private void RemoveEmptyStreamingBubble()
    {
        if (_streamingTextBlock is null) return;
        if (_streamingContainer is not null) MessagesHost.Children.Remove(_streamingContainer);
        _streamingTextBlock = null;
        _streamingContainer = null;
        _streamedText = "";
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        ChatInput.IsReadOnly = busy;
        SendButton.Visibility = busy ? Visibility.Collapsed : Visibility.Visible;
        StopButton.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        ActivityBar.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        ComposerHint.Text = busy ? "生成期间仍可拖动、缩放窗口" : "Chat 模式 · 记录与主页面分开保存";
        if (busy)
        {
            _activityFrame = 0;
            BusyText.Text = "Trylo 正在思考";
            ActivityDot.Opacity = 1;
            _streamUiTimer.Start();
        }
        else
        {
            _streamUiTimer.Stop();
            ClearPendingStreamDelta();
            ChatInput.Focus();
        }
        UpdateInputPlaceholder();
    }

    private void UpdateConnectionUi(bool connected, string? workspaceName = null)
    {
        ConnectionDot.Fill = new SolidColorBrush(connected ? MediaColor.FromRgb(114, 229, 181) : MediaColor.FromRgb(106, 116, 131));
        WorkspaceText.Text = connected
            ? workspaceName ?? _activeClient?.WorkspaceName ?? "Trylo"
            : "等待 Trylo 连接";
        SendButton.IsEnabled = connected;
    }

    private void ScrollToBottom()
    {
        if (_scrollPending) return;
        _scrollPending = true;
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(() =>
        {
            MessagesScroll.ScrollToEnd();
            _scrollPending = false;
        }));
    }

    private static string FormatTime(long at)
    {
        try
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(at > 0 ? at : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                .ToLocalTime()
                .ToString("HH:mm");
        }
        catch
        {
            return DateTime.Now.ToString("HH:mm");
        }
    }

    private void OnTitleBarMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed ||
            FindVisualParent<System.Windows.Controls.Button>(e.OriginalSource as DependencyObject) is not null) return;
        if (e.ClickCount == 2)
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
            e.Handled = true;
            return;
        }
        e.Handled = true;
        try { DragMove(); } catch { }
    }

    private void OnChatInputTextChanged(object sender, TextChangedEventArgs e) => UpdateInputPlaceholder();

    private void UpdateInputPlaceholder()
    {
        InputPlaceholder.Visibility = string.IsNullOrEmpty(ChatInput.Text) && !_busy
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private static T? FindVisualParent<T>(DependencyObject? child) where T : DependencyObject
    {
        while (child is not null)
        {
            if (child is T match) return match;
            child = VisualTreeHelper.GetParent(child);
        }
        return null;
    }

    private void OnMinimizeClick(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void OnCloseClick(object sender, RoutedEventArgs e) => Close();

    internal void PrepareQaRender(string outputPath, bool showThinking = false)
    {
        if (showThinking)
        {
            Loaded += (_, _) =>
            {
                _activeRequestId = "qa-thinking";
                _streamedText = "";
                _streamingTextBlock = null;
                _streamingContainer = null;
                EnsureStreamingBubble();
                SetBusy(true);
            };
        }
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

    private sealed record MessageBubbleView(TextBlock Body, FrameworkElement Container);
}
