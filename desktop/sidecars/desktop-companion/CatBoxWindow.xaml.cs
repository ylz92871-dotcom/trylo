using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Interop;
using System.Windows.Threading;
using System.IO;
using WpfButton = System.Windows.Controls.Button;
using MediaColor = System.Windows.Media.Color;

namespace TryloDesktopPet;

internal sealed record CatBoxCharacter(
    string Id,
    string Name,
    string Avatar,
    string Description,
    string SystemPrompt,
    string Opening = "",
    string AvatarImagePath = "",
    bool IsCustom = false);

internal sealed class CatBoxCharacterState
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Avatar { get; set; } = "";
    public string Description { get; set; } = "";
    public string SystemPrompt { get; set; } = "";
    public string Opening { get; set; } = "";
    public string AvatarImagePath { get; set; } = "";
}

internal sealed class CatBoxCharacterStore
{
    public List<CatBoxCharacterState> CustomCharacters { get; set; } = new();
    public List<CatBoxCharacterState> BuiltInOverrides { get; set; } = new();
    public string SelectedBackgroundId { get; set; } = "none";
    public string CustomBackgroundImagePath { get; set; } = "";
    public string BubbleStyleId { get; set; } = "classic";

    private static string StorePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TryloCode",
        "catbox-characters.json");

    public static CatBoxCharacterStore Load()
    {
        try
        {
            if (!File.Exists(StorePath)) return new CatBoxCharacterStore();
            return JsonSerializer.Deserialize<CatBoxCharacterStore>(File.ReadAllText(StorePath)) ?? new CatBoxCharacterStore();
        }
        catch
        {
            return new CatBoxCharacterStore();
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
            File.WriteAllText(StorePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }
}

internal sealed record CatBoxBackgroundOption(string Id, string Name, string AssetFileName, double Opacity, byte WashAlpha);

internal sealed record CatBoxBubbleStyle(
    string Id,
    string Name,
    MediaColor UserBackground,
    MediaColor UserBorder,
    MediaColor AssistantBackground,
    MediaColor AssistantBorder,
    MediaColor NameColor,
    MediaColor TextColor);

public partial class CatBoxWindow : Window
{
    private const int WmNchittest = 0x0084;
    private const int HtClient = 1;
    private const int HtLeft = 10;
    private const int HtRight = 11;
    private const int HtTop = 12;
    private const int HtTopLeft = 13;
    private const int HtTopRight = 14;
    private const int HtBottom = 15;
    private const int HtBottomLeft = 16;
    private const int HtBottomRight = 17;
    private const int ResizeBorderThickness = 9;

    private static readonly CatBoxCharacter[] BuiltInCharacters =
    {
        new(
            "gentle-sister",
            "温柔邻家姐姐",
            "👩‍🦰",
            "从小陪你长大的温柔姐姐，总是耐心听你说话",
            "你是一个温柔的邻家姐姐，比用户大几岁。从小看着用户长大，说话温柔体贴，喜欢关心用户的生活。会用弟弟、妹妹或昵称来称呼对方。耐心倾听，偶尔给一些人生建议，像一个温暖的大姐姐一样。"),
        new(
            "cool-classmate",
            "高冷学霸同桌",
            "📚",
            "嘴上嫌你笨，其实一直在偷偷帮你",
            "你是一个高冷但内心温柔的学霸，是用户的同桌。表面上对用户的需求爱答不理、嫌麻烦，但每次都会认真地帮忙解答。说话简短直接，偶尔会毒舌吐槽，但会用实际行动关心对方。不善于表达感情。"),
        new(
            "childhood-friend",
            "青梅竹马",
            "🌻",
            "从小打打闹闹，却最懂你的人",
            "你是用户从小一起长大的青梅竹马，两人打打闹闹度过了整个童年和青春期。说话随意自然，喜欢开玩笑和吐槽，偶尔会不经意间流露出对对方的在意。互相了解对方的习惯。"),
        new(
            "senior-mentor",
            "靠谱学长",
            "🎓",
            "温柔可靠的学长，什么都知道一点",
            "你是一个温柔可靠的学长，比用户大一两届。性格温和，知识渊博，对各种事情都有自己的见解。说话有条理，善于引导别人，总是耐心地解答问题。给人安心和信赖的感觉。"),
        new(
            "mysterious-stranger",
            "神秘陌生人",
            "🌙",
            "深夜在咖啡馆遇到的神秘人",
            "你是一个神秘的陌生人，用户是在深夜的一家二十四小时咖啡馆偶然遇到你的。你说话含蓄，偶尔说一些意味深长的话。有自己的故事但不轻易透露，气质优雅，谈吐有趣。"),
        new(
            "tsundere-cat",
            "傲娇猫娘",
            "🐱",
            "才不是特意等你呢...喵",
            "你是一个傲娇的猫娘角色。说话要带点傲娇和嫌弃，但偶尔会不经意间表现出关心。句尾经常带“喵”。不要用括号描述动作，只输出对话内容。"),
        new(
            "trylo-guide",
            "Trylo 向导",
            "✦",
            "了解 IDE 所有功能，帮你快速上手",
            "你是 Trylo IDE 的官方向导助手。你热情、专业、乐于助人，负责向用户介绍和解释 Trylo IDE 的功能。回答要清晰简洁，适当使用结构化说明，并鼓励用户探索 Chat、Sessions、Skills、Inspect、Fun、Settings 等功能。",
            "你好，我是 Trylo 向导。想先了解哪块功能？"),
    };

    private static readonly CatBoxBackgroundOption[] BackgroundOptions =
    {
        new("none", "暖色纯净", "", 0, 234),
        new("rain-cafe", "雨夜咖啡馆", "rain-cafe.png", 0.62, 128),
        new("night-library", "夜晚图书馆", "night-library.png", 0.58, 140),
        new("pink-room", "粉色房间", "pink-room.png", 0.58, 126),
        new("custom", "我的背景", "", 0.6, 132),
    };

    private static readonly CatBoxBubbleStyle[] BubbleStyles =
    {
        new("classic", "原版暖色",
            MediaColor.FromArgb(34, 201, 132, 106),
            MediaColor.FromArgb(42, 201, 132, 106),
            MediaColor.FromRgb(255, 255, 255),
            MediaColor.FromArgb(42, 201, 132, 106),
            MediaColor.FromRgb(201, 132, 106),
            MediaColor.FromRgb(42, 34, 25)),
        new("glass", "玻璃柔光",
            MediaColor.FromArgb(120, 255, 255, 255),
            MediaColor.FromArgb(96, 255, 255, 255),
            MediaColor.FromArgb(176, 255, 255, 255),
            MediaColor.FromArgb(84, 255, 255, 255),
            MediaColor.FromRgb(143, 105, 210),
            MediaColor.FromRgb(38, 34, 48)),
        new("blush", "粉桃软糖",
            MediaColor.FromArgb(92, 240, 140, 166),
            MediaColor.FromArgb(70, 240, 140, 166),
            MediaColor.FromRgb(255, 247, 250),
            MediaColor.FromArgb(62, 232, 160, 191),
            MediaColor.FromRgb(210, 105, 132),
            MediaColor.FromRgb(55, 37, 45)),
        new("mocha", "摩卡纸感",
            MediaColor.FromArgb(54, 132, 86, 52),
            MediaColor.FromArgb(56, 132, 86, 52),
            MediaColor.FromRgb(255, 250, 241),
            MediaColor.FromArgb(70, 180, 145, 112),
            MediaColor.FromRgb(166, 103, 70),
            MediaColor.FromRgb(48, 38, 30)),
    };

    private readonly CompanionServer? _server;
    private readonly List<CatBoxCharacter> _characters = new();
    private CatBoxCharacterStore _characterStore = new();
    private PetMessage? _activeClient;
    private CatBoxCharacter? _activeCharacter;
    private CatBoxCharacter? _editingCharacter;
    private readonly List<PetChatHistoryItem> _messages = new();
    private readonly DispatcherTimer _streamUiTimer = new() { Interval = TimeSpan.FromMilliseconds(50) };
    private readonly object _pendingDeltaGate = new();
    private readonly StringBuilder _pendingDelta = new();
    private string _pendingDeltaRequestId = "";
    private string _activeRequestId = "";
    private string _streamedText = "";
    private TextBlock? _streamingTextBlock;
    private FrameworkElement? _streamingContainer;
    private bool _busy;
    private bool _thinkMode;
    private bool _scrollPending;
    private bool _returnToChatAfterEditor;
    private bool _returnToChatAfterVisualSettings;
    private int _activityFrame;
    private string _pendingAvatarImagePath = "";

    internal CatBoxWindow(CompanionServer server, PetMessage? activeClient)
    {
        InitializeComponent();
        _server = server;
        _activeClient = activeClient;
        InitializeUi();
        _server.ActiveClientChanged += OnActiveClientChanged;
        _server.ChatEventReceived += OnChatEventReceived;
        _server.ChatConnectionChanged += OnChatConnectionChanged;
        Closed += OnClosed;
        UpdateConnectionUi(_activeClient is not null);
    }

    internal CatBoxWindow()
    {
        InitializeComponent();
        InitializeUi();
        UpdateConnectionUi(true);
    }

    private void InitializeUi()
    {
        SourceInitialized += OnSourceInitialized;
        SizeChanged += OnCatBoxWindowSizeChanged;
        _streamUiTimer.Tick += OnStreamUiTick;
        LoadCharacters();
        RenderCharacters();
        RenderVisualOptions();
        ApplyVisualPreferences();
        UpdateModeButtons();
        UpdateResponsiveLayout();
        FunInput.Focus();
    }

    private void OnCatBoxWindowSizeChanged(object sender, SizeChangedEventArgs e) => UpdateResponsiveLayout();

    private void UpdateResponsiveLayout()
    {
        var width = ActualWidth > 0 ? ActualWidth : Width;
        var cardColumns = width >= 1040 ? 4 : width >= 760 ? 3 : 2;
        CharacterGrid.Columns = cardColumns;

        var optionColumns = width >= 880 ? 3 : 2;
        BackgroundOptionsHost.Columns = optionColumns;
        BubbleOptionsHost.Columns = optionColumns;

        MessagesHost.Width = CalculateMessageLaneWidth();
        UpdateMessageBubbleWidths();
    }

    private void UpdateMessageBubbleWidths()
    {
        if (MessagesHost is null) return;
        var maxWidth = CalculateMessageBubbleMaxWidth();
        foreach (UIElement child in MessagesHost.Children)
        {
            if (child is FrameworkElement element)
            {
                element.MaxWidth = maxWidth;
            }
        }
    }

    private double CalculateMessageBubbleMaxWidth()
    {
        var hostWidth = CalculateMessageLaneWidth();

        return Math.Max(320, Math.Min(760, hostWidth * 0.76));
    }

    private double CalculateMessageLaneWidth()
    {
        var viewportWidth = MessagesScroll?.ViewportWidth ?? 0;
        var availableWidth = viewportWidth > 0 ? viewportWidth : MessagesScroll?.ActualWidth ?? 0;
        if (availableWidth <= 0)
        {
            availableWidth = Math.Max(0, ActualWidth - 120);
        }

        return Math.Max(320, Math.Min(1040, availableWidth));
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _streamUiTimer.Stop();
        if (_server is null) return;
        _server.ActiveClientChanged -= OnActiveClientChanged;
        _server.ChatEventReceived -= OnChatEventReceived;
        _server.ChatConnectionChanged -= OnChatConnectionChanged;
    }

    private void RenderCharacters()
    {
        CharacterGrid.Children.Clear();
        foreach (var character in _characters)
        {
            var card = new Border
            {
                Margin = new Thickness(0, 0, 14, 14),
                Padding = new Thickness(18, 16, 18, 16),
                CornerRadius = new CornerRadius(18),
                Background = new SolidColorBrush(MediaColor.FromArgb(214, 255, 255, 255)),
                BorderBrush = new SolidColorBrush(MediaColor.FromArgb(38, 180, 160, 140)),
                BorderThickness = new Thickness(1),
                Cursor = System.Windows.Input.Cursors.Hand,
                MinHeight = 142,
                Tag = character,
            };
            card.Effect = new System.Windows.Media.Effects.DropShadowEffect
            {
                Color = MediaColor.FromRgb(60, 40, 20),
                BlurRadius = 16,
                ShadowDepth = 4,
                Opacity = 0.08,
            };

            var stack = new StackPanel();
            var avatar = CreateAvatar(character.Avatar, 54, 18, 26, character.AvatarImagePath);
            avatar.Margin = new Thickness(0, 0, 0, 10);
            stack.Children.Add(avatar);
            stack.Children.Add(new TextBlock
            {
                Text = character.Name,
                Foreground = new SolidColorBrush(MediaColor.FromRgb(42, 34, 25)),
                FontWeight = FontWeights.Bold,
                FontSize = 14,
            });
            stack.Children.Add(new TextBlock
            {
                Text = character.Description,
                Foreground = new SolidColorBrush(MediaColor.FromRgb(168, 151, 133)),
                FontSize = 11.5,
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 17,
                Margin = new Thickness(0, 7, 0, 0),
            });
            card.Child = stack;
            card.MouseEnter += (_, _) =>
            {
                card.RenderTransform = new TranslateTransform(0, -4);
                card.BorderBrush = new SolidColorBrush(MediaColor.FromArgb(82, 201, 132, 106));
            };
            card.MouseLeave += (_, _) =>
            {
                card.RenderTransform = null;
                card.BorderBrush = new SolidColorBrush(MediaColor.FromArgb(38, 180, 160, 140));
            };
            card.MouseLeftButtonUp += (_, _) => OpenCharacter(character);
            CharacterGrid.Children.Add(card);
        }
    }

    private void RenderVisualOptions()
    {
        BackgroundOptionsHost.Children.Clear();
        foreach (var option in BackgroundOptions)
        {
            var card = CreateOptionCard(
                option.Name,
                option.Id == _characterStore.SelectedBackgroundId,
                () =>
                {
                    if (option.Id == "custom" && string.IsNullOrWhiteSpace(_characterStore.CustomBackgroundImagePath))
                    {
                        ChooseWindowBackground();
                        return;
                    }
                    _characterStore.SelectedBackgroundId = option.Id;
                    _characterStore.Save();
                    ApplyVisualPreferences();
                    RenderVisualOptions();
                });
            BackgroundOptionsHost.Children.Add(card);
        }

        BubbleOptionsHost.Children.Clear();
        foreach (var style in BubbleStyles)
        {
            var card = CreateOptionCard(
                style.Name,
                style.Id == _characterStore.BubbleStyleId,
                () =>
                {
                    _characterStore.BubbleStyleId = style.Id;
                    _characterStore.Save();
                    ApplyVisualPreferences();
                    RenderVisualOptions();
                    RenderCurrentMessages();
                });
            BubbleOptionsHost.Children.Add(card);
        }
    }

    private Border CreateOptionCard(string title, bool selected, Action onClick)
    {
        var card = new Border
        {
            Margin = new Thickness(0, 0, 10, 10),
            Padding = new Thickness(14, 12, 14, 12),
            CornerRadius = new CornerRadius(14),
            Background = new SolidColorBrush(selected
                ? MediaColor.FromArgb(120, 201, 132, 106)
                : MediaColor.FromArgb(150, 255, 255, 255)),
            BorderBrush = new SolidColorBrush(selected
                ? MediaColor.FromRgb(201, 132, 106)
                : MediaColor.FromArgb(44, 180, 160, 140)),
            BorderThickness = new Thickness(1),
            Cursor = System.Windows.Input.Cursors.Hand,
            MinHeight = 48,
            Child = new TextBlock
            {
                Text = title,
                Foreground = new SolidColorBrush(MediaColor.FromRgb(42, 34, 25)),
                FontSize = 13,
                FontWeight = selected ? FontWeights.Bold : FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        card.MouseLeftButtonUp += (_, _) => onClick();
        return card;
    }

    private void ApplyVisualPreferences()
    {
        var option = BackgroundOptions.FirstOrDefault(item => item.Id == _characterStore.SelectedBackgroundId) ??
            BackgroundOptions[0];
        var imagePath = option.Id == "custom"
            ? _characterStore.CustomBackgroundImagePath
            : string.IsNullOrWhiteSpace(option.AssetFileName)
                ? ""
                : Path.Combine(AppContext.BaseDirectory, "assets", "catbox-backgrounds", option.AssetFileName);

        if (!string.IsNullOrWhiteSpace(imagePath) && File.Exists(imagePath))
        {
            try
            {
                CatBoxBackgroundImage.Source = LoadAvatarBitmap(imagePath);
                CatBoxBackgroundImage.Opacity = option.Opacity;
            }
            catch
            {
                CatBoxBackgroundImage.Source = null;
                CatBoxBackgroundImage.Opacity = 0;
            }
        }
        else
        {
            CatBoxBackgroundImage.Source = null;
            CatBoxBackgroundImage.Opacity = 0;
        }

        CatBoxBackgroundWash.Background = new SolidColorBrush(MediaColor.FromArgb(
            option.WashAlpha,
            248,
            243,
            237));
    }

    private CatBoxBubbleStyle CurrentBubbleStyle() =>
        BubbleStyles.FirstOrDefault(style => style.Id == _characterStore.BubbleStyleId) ?? BubbleStyles[0];

    private void LoadCharacters()
    {
        _characterStore = CatBoxCharacterStore.Load();
        _characters.Clear();
        foreach (var builtIn in BuiltInCharacters)
        {
            var saved = _characterStore.BuiltInOverrides.FirstOrDefault(item => item.Id == builtIn.Id);
            _characters.Add(saved is null ? builtIn : ToCharacter(saved, isCustom: false, fallback: builtIn));
        }

        foreach (var saved in _characterStore.CustomCharacters)
        {
            var character = ToCharacter(saved, isCustom: true);
            if (!string.IsNullOrWhiteSpace(character.Id) &&
                !string.IsNullOrWhiteSpace(character.Name) &&
                !string.IsNullOrWhiteSpace(character.SystemPrompt))
            {
                _characters.Add(character);
            }
        }
    }

    private static CatBoxCharacter ToCharacter(
        CatBoxCharacterState state,
        bool isCustom,
        CatBoxCharacter? fallback = null)
    {
        return new CatBoxCharacter(
            FirstNonEmpty(state.Id, fallback?.Id ?? ""),
            FirstNonEmpty(state.Name, fallback?.Name ?? ""),
            FirstNonEmpty(state.Avatar, fallback?.Avatar ?? "🌸"),
            FirstNonEmpty(state.Description, fallback?.Description ?? ""),
            FirstNonEmpty(state.SystemPrompt, fallback?.SystemPrompt ?? ""),
            FirstNonEmpty(state.Opening, fallback?.Opening ?? ""),
            FirstNonEmpty(state.AvatarImagePath, fallback?.AvatarImagePath ?? ""),
            isCustom);
    }

    private static CatBoxCharacterState ToState(CatBoxCharacter character) => new()
    {
        Id = character.Id,
        Name = character.Name,
        Avatar = character.Avatar,
        Description = character.Description,
        SystemPrompt = character.SystemPrompt,
        Opening = character.Opening,
        AvatarImagePath = character.AvatarImagePath,
    };

    private static string FirstNonEmpty(params string[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private void OpenCharacter(CatBoxCharacter character)
    {
        _activeCharacter = character;
        _messages.Clear();
        _activeRequestId = "";
        _streamedText = "";
        _streamingTextBlock = null;
        _streamingContainer = null;
        MessagesHost.Children.Clear();
        CharacterSelectionView.Visibility = Visibility.Collapsed;
        ChatView.Visibility = Visibility.Visible;
        ChatCharacterText.Text = $"{character.Avatar} {character.Name}";
        if (!string.IsNullOrWhiteSpace(character.Opening))
        {
            AddStoredMessage("assistant", character.Opening, render: true);
        }
        EmptyChatText.Visibility = _messages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        FunInput.Focus();
    }

    private void OpenEditor(CatBoxCharacter? character)
    {
        if (_busy) return;
        _editingCharacter = character;
        _returnToChatAfterEditor = ChatView.Visibility == Visibility.Visible && character is not null;
        EditorErrorText.Text = "";
        EditorTitle.Text = character is null ? "创建角色" : "编辑角色";
        EditorEmojiInput.Text = character?.Avatar ?? "🌸";
        EditorNameInput.Text = character?.Name ?? "";
        EditorDescriptionInput.Text = character?.Description ?? "";
        EditorSystemInput.Text = character?.SystemPrompt ?? "";
        EditorOpeningInput.Text = character?.Opening ?? "";
        _pendingAvatarImagePath = character?.AvatarImagePath ?? "";
        UpdateEditorAvatarPreview();
        CharacterSelectionView.Visibility = Visibility.Collapsed;
        ChatView.Visibility = Visibility.Collapsed;
        EditorView.Visibility = Visibility.Visible;
        EditorNameInput.Focus();
    }

    private void CloseEditor()
    {
        EditorView.Visibility = Visibility.Collapsed;
        if (_returnToChatAfterEditor && _activeCharacter is not null)
        {
            ChatView.Visibility = Visibility.Visible;
            FunInput.Focus();
        }
        else
        {
            CharacterSelectionView.Visibility = Visibility.Visible;
        }
        _editingCharacter = null;
        _returnToChatAfterEditor = false;
        EditorErrorText.Text = "";
    }

    private void SaveEditor()
    {
        var name = EditorNameInput.Text.Trim();
        var systemPrompt = EditorSystemInput.Text.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            EditorErrorText.Text = "先给角色起个名字。";
            EditorNameInput.Focus();
            return;
        }
        if (string.IsNullOrWhiteSpace(systemPrompt))
        {
            EditorErrorText.Text = "角色设定不能为空。";
            EditorSystemInput.Focus();
            return;
        }

        var isCustom = _editingCharacter?.IsCustom ?? true;
        var id = _editingCharacter?.Id;
        if (string.IsNullOrWhiteSpace(id)) id = "custom-" + Guid.NewGuid().ToString("N");
        var character = new CatBoxCharacter(
            id,
            name,
            string.IsNullOrWhiteSpace(EditorEmojiInput.Text) ? "🌸" : EditorEmojiInput.Text.Trim(),
            EditorDescriptionInput.Text.Trim(),
            systemPrompt,
            EditorOpeningInput.Text.Trim(),
            _pendingAvatarImagePath,
            isCustom);

        if (isCustom)
        {
            UpsertState(_characterStore.CustomCharacters, ToState(character));
        }
        else
        {
            UpsertState(_characterStore.BuiltInOverrides, ToState(character));
        }
        _characterStore.Save();
        LoadCharacters();
        RenderCharacters();

        if (_activeCharacter is not null && _activeCharacter.Id == character.Id)
        {
            _activeCharacter = _characters.FirstOrDefault(item => item.Id == character.Id) ?? character;
            ChatCharacterText.Text = $"{_activeCharacter.Avatar} {_activeCharacter.Name}";
            RenderCurrentMessages();
        }

        CloseEditor();
    }

    private static void UpsertState(List<CatBoxCharacterState> list, CatBoxCharacterState state)
    {
        list.RemoveAll(item => item.Id == state.Id);
        list.Add(state);
    }

    private void RenderCurrentMessages()
    {
        MessagesHost.Children.Clear();
        foreach (var message in _messages)
        {
            AddMessageBubble(message.Role, message.Text);
        }
        EmptyChatText.Visibility = _messages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        UpdateMessageBubbleWidths();
    }

    private void UpdateEditorAvatarPreview()
    {
        var hasImage = !string.IsNullOrWhiteSpace(_pendingAvatarImagePath) && File.Exists(_pendingAvatarImagePath);
        if (hasImage)
        {
            try
            {
                EditorAvatarImage.Source = LoadAvatarBitmap(_pendingAvatarImagePath);
                EditorAvatarImage.Visibility = Visibility.Visible;
                EditorAvatarText.Visibility = Visibility.Collapsed;
                return;
            }
            catch
            {
                _pendingAvatarImagePath = "";
            }
        }
        EditorAvatarImage.Source = null;
        EditorAvatarImage.Visibility = Visibility.Collapsed;
        EditorAvatarText.Text = string.IsNullOrWhiteSpace(EditorEmojiInput.Text) ? "🌸" : EditorEmojiInput.Text.Trim();
        EditorAvatarText.Visibility = Visibility.Visible;
    }

    private void OnActiveClientChanged(PetMessage? client, int workingPeers = 0) =>
        Dispatcher.Invoke(() =>
        {
            _activeClient = client;
            UpdateConnectionUi(client is not null);
        });

    private void OnChatConnectionChanged(string clientId, bool connected)
    {
        Dispatcher.Invoke(() =>
        {
            if (!string.Equals(_activeClient?.ClientId, clientId, StringComparison.Ordinal)) return;
            UpdateConnectionUi(connected);
        });
    }

    private void OnChatEventReceived(PetChatEnvelope message)
    {
        if (!string.Equals(message.Mode, "fun", StringComparison.OrdinalIgnoreCase)) return;
        if (message.Type == "chat_delta")
        {
            lock (_pendingDeltaGate)
            {
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
        switch (message.Type)
        {
            case "chat_started":
                if (!string.IsNullOrWhiteSpace(message.RequestId)) _activeRequestId = message.RequestId;
                EnsureStreamingBubble();
                SetBusy(true);
                break;
            case "chat_complete":
                if (!MatchesActiveRequest(message.RequestId)) return;
                EnsureStreamingBubble();
                if (string.IsNullOrWhiteSpace(_streamedText) && !string.IsNullOrWhiteSpace(message.Text))
                {
                    ApplyStreamDelta(message.RequestId, message.Text);
                }
                CompleteStreamingBubble();
                break;
            case "chat_error":
                if (!string.IsNullOrWhiteSpace(message.RequestId) && !MatchesActiveRequest(message.RequestId)) return;
                RemoveEmptyStreamingBubble();
                AddSystemMessage(string.IsNullOrWhiteSpace(message.Error) ? "猫箱暂时没有回应。" : message.Error);
                SetBusy(false);
                _activeRequestId = "";
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
        if (_streamingTextBlock is not null && string.IsNullOrWhiteSpace(_streamedText))
        {
            var dots = new string('·', 1 + (_activityFrame / 5) % 3);
            _streamingTextBlock.Text = $"正在思考{dots}";
        }
    }

    private void FlushPendingStreamDelta()
    {
        string requestId;
        string delta;
        lock (_pendingDeltaGate)
        {
            if (_pendingDelta.Length == 0) return;
            requestId = _pendingDeltaRequestId;
            delta = _pendingDelta.ToString();
            _pendingDelta.Clear();
        }
        ApplyStreamDelta(requestId, delta);
    }

    private void ApplyStreamDelta(string requestId, string delta)
    {
        if (!MatchesActiveRequest(requestId) || string.IsNullOrEmpty(delta)) return;
        EnsureStreamingBubble();
        _streamedText += delta;
        if (_streamingTextBlock is not null)
        {
            _streamingTextBlock.Text = _streamedText;
            _streamingTextBlock.FontStyle = FontStyles.Normal;
        }
        StatusText.Text = $"{_activeCharacter?.Name ?? "猫箱"} 正在回复";
        ScrollToBottom();
    }

    private async Task SendCurrentMessageAsync()
    {
        if (_busy || _activeCharacter is null) return;
        var text = FunInput.Text.Trim();
        if (string.IsNullOrWhiteSpace(text)) return;
        if (_server is null || string.IsNullOrWhiteSpace(_activeClient?.ClientId))
        {
            AddSystemMessage("Trylo 主窗口尚未连接，打开主窗口后再试。");
            UpdateConnectionUi(false);
            return;
        }

        _activeRequestId = Guid.NewGuid().ToString("N");
        _streamedText = "";
        _streamingTextBlock = null;
        _streamingContainer = null;
        AddStoredMessage("user", text, render: true);
        FunInput.Clear();
        EnsureStreamingBubble();
        SetBusy(true);
        var sent = await _server.SendFunMessageAsync(
            _activeClient.ClientId,
            _activeRequestId,
            text,
            _activeCharacter,
            _messages,
            _thinkMode);
        if (!sent)
        {
            RemoveEmptyStreamingBubble();
            AddSystemMessage("没有连上 Trylo，请确认 Trylo 主窗口仍然打开。");
            SetBusy(false);
            UpdateConnectionUi(false);
        }
    }

    private void AddStoredMessage(string role, string text, bool render)
    {
        _messages.Add(new PetChatHistoryItem
        {
            Role = role,
            Text = text,
            At = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
        if (render) AddMessageBubble(role, text);
    }

    private void AddMessageBubble(string role, string text)
    {
        EmptyChatText.Visibility = Visibility.Collapsed;
        var isUser = role.Equals("user", StringComparison.OrdinalIgnoreCase);
        var style = CurrentBubbleStyle();
        var wrapper = new StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Horizontal,
            HorizontalAlignment = isUser ? System.Windows.HorizontalAlignment.Right : System.Windows.HorizontalAlignment.Left,
            Margin = new Thickness(0, 0, 0, 10),
            MaxWidth = CalculateMessageBubbleMaxWidth(),
        };

        if (!isUser)
        {
            var avatar = CreateAvatar(_activeCharacter?.Avatar ?? "🐱", 32, 16, 16, _activeCharacter?.AvatarImagePath ?? "");
            avatar.Margin = new Thickness(0, 0, 8, 0);
            wrapper.Children.Add(avatar);
        }

        var bubble = new Border
        {
            CornerRadius = isUser ? new CornerRadius(16, 16, 4, 16) : new CornerRadius(16, 16, 16, 4),
            Padding = new Thickness(13, 10, 13, 10),
            Background = isUser
                ? new SolidColorBrush(style.UserBackground)
                : new SolidColorBrush(style.AssistantBackground),
            BorderBrush = new SolidColorBrush(isUser ? style.UserBorder : style.AssistantBorder),
            BorderThickness = new Thickness(1),
        };
        var stack = new StackPanel();
        if (!isUser)
        {
            stack.Children.Add(new TextBlock
            {
                Text = _activeCharacter?.Name ?? "猫箱",
                Foreground = new SolidColorBrush(style.NameColor),
                FontWeight = FontWeights.SemiBold,
                FontSize = 11,
                Margin = new Thickness(0, 0, 0, 5),
            });
        }
        stack.Children.Add(new TextBlock
        {
            Text = text,
            Foreground = new SolidColorBrush(style.TextColor),
            FontSize = 13,
            LineHeight = 20,
            TextWrapping = TextWrapping.Wrap,
        });
        bubble.Child = stack;
        wrapper.Children.Add(bubble);
        MessagesHost.Children.Add(wrapper);
        ScrollToBottom();
    }

    private TextBlock AddStreamingBubble()
    {
        EmptyChatText.Visibility = Visibility.Collapsed;
        var style = CurrentBubbleStyle();
        var wrapper = new StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Horizontal,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
            Margin = new Thickness(0, 0, 0, 10),
            MaxWidth = CalculateMessageBubbleMaxWidth(),
        };
        var avatar = CreateAvatar(_activeCharacter?.Avatar ?? "🐱", 32, 16, 16, _activeCharacter?.AvatarImagePath ?? "");
        avatar.Margin = new Thickness(0, 0, 8, 0);
        wrapper.Children.Add(avatar);

        var body = new TextBlock
        {
            Text = "正在思考·",
            Foreground = new SolidColorBrush(style.TextColor),
            FontSize = 13,
            LineHeight = 20,
            TextWrapping = TextWrapping.Wrap,
            FontStyle = FontStyles.Italic,
        };
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = _activeCharacter?.Name ?? "猫箱",
            Foreground = new SolidColorBrush(style.NameColor),
            FontWeight = FontWeights.SemiBold,
            FontSize = 11,
            Margin = new Thickness(0, 0, 0, 5),
        });
        stack.Children.Add(body);
        var bubble = new Border
        {
            CornerRadius = new CornerRadius(16, 16, 16, 4),
            Padding = new Thickness(13, 10, 13, 10),
            Background = new SolidColorBrush(style.AssistantBackground),
            BorderBrush = new SolidColorBrush(style.AssistantBorder),
            BorderThickness = new Thickness(1),
            Child = stack,
        };
        wrapper.Children.Add(bubble);
        MessagesHost.Children.Add(wrapper);
        _streamingContainer = wrapper;
        ScrollToBottom();
        return body;
    }

    private void EnsureStreamingBubble()
    {
        if (_streamingTextBlock is not null) return;
        _streamingTextBlock = AddStreamingBubble();
    }

    private static Border CreateAvatar(string text, double size, double fontSize, double radius, string imagePath = "")
    {
        UIElement child;
        if (!string.IsNullOrWhiteSpace(imagePath) && File.Exists(imagePath))
        {
            child = new System.Windows.Controls.Image
            {
                Source = LoadAvatarBitmap(imagePath),
                Stretch = Stretch.UniformToFill,
            };
        }
        else
        {
            child = new TextBlock
            {
                Text = string.IsNullOrWhiteSpace(text) ? "🌸" : text,
                FontFamily = new System.Windows.Media.FontFamily("Segoe UI Emoji, Segoe UI Symbol, Microsoft YaHei UI"),
                FontSize = fontSize,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                TextAlignment = TextAlignment.Center,
                LineHeight = size,
            };
        }
        return new Border
        {
            Width = size,
            Height = size,
            CornerRadius = new CornerRadius(radius),
            Background = new LinearGradientBrush(
                MediaColor.FromRgb(255, 246, 239),
                MediaColor.FromRgb(240, 225, 212),
                45),
            BorderBrush = new SolidColorBrush(MediaColor.FromArgb(46, 201, 132, 106)),
            BorderThickness = new Thickness(1),
            ClipToBounds = true,
            Child = child,
        };
    }

    private static BitmapImage LoadAvatarBitmap(string path)
    {
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.UriSource = new Uri(path, UriKind.Absolute);
        image.EndInit();
        image.Freeze();
        return image;
    }

    private void CompleteStreamingBubble()
    {
        if (!string.IsNullOrWhiteSpace(_streamedText))
        {
            _messages.Add(new PetChatHistoryItem
            {
                Role = "assistant",
                Text = _streamedText,
                At = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });
        }
        else if (_streamingTextBlock is not null)
        {
            _streamingTextBlock.Text = "回复完成。";
        }
        _streamingTextBlock = null;
        _streamingContainer = null;
        _streamedText = "";
        _activeRequestId = "";
        SetBusy(false);
    }

    private void RemoveEmptyStreamingBubble()
    {
        if (_streamingContainer is not null) MessagesHost.Children.Remove(_streamingContainer);
        _streamingTextBlock = null;
        _streamingContainer = null;
        _streamedText = "";
    }

    private void AddSystemMessage(string text)
    {
        var border = new Border
        {
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 8, 12, 8),
            Margin = new Thickness(0, 0, 0, 10),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            MaxWidth = CalculateMessageBubbleMaxWidth(),
            Background = new SolidColorBrush(MediaColor.FromArgb(80, 255, 255, 255)),
            Child = new TextBlock
            {
                Text = text,
                Foreground = new SolidColorBrush(MediaColor.FromRgb(107, 93, 79)),
                FontSize = 12,
                TextWrapping = TextWrapping.Wrap,
            },
        };
        MessagesHost.Children.Add(border);
        EmptyChatText.Visibility = Visibility.Collapsed;
        ScrollToBottom();
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        FunInput.IsReadOnly = busy;
        SendButton.Visibility = busy ? Visibility.Collapsed : Visibility.Visible;
        StopButton.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        StatusText.Text = busy
            ? $"{_activeCharacter?.Name ?? "猫箱"} 正在思考"
            : (_thinkMode ? "思考模式 · 桌宠猫箱" : "灵动模式 · 桌宠猫箱");
        if (busy)
        {
            _activityFrame = 0;
            _streamUiTimer.Start();
        }
        else
        {
            _streamUiTimer.Stop();
            ClearPendingStreamDelta();
            FunInput.Focus();
        }
    }

    private void ClearPendingStreamDelta()
    {
        lock (_pendingDeltaGate)
        {
            _pendingDelta.Clear();
            _pendingDeltaRequestId = "";
        }
    }

    private bool MatchesActiveRequest(string requestId) =>
        string.IsNullOrWhiteSpace(requestId) || string.Equals(requestId, _activeRequestId, StringComparison.Ordinal);

    private void UpdateConnectionUi(bool connected)
    {
        ConnectionText.Text = connected ? "已连接" : "等待 Trylo";
        SendButton.IsEnabled = connected;
    }

    private void UpdateModeButtons()
    {
        NormalModeButton.Background = new SolidColorBrush(_thinkMode
            ? MediaColor.FromArgb(102, 255, 255, 255)
            : MediaColor.FromRgb(201, 132, 106));
        NormalModeButton.Foreground = new SolidColorBrush(_thinkMode
            ? MediaColor.FromRgb(107, 93, 79)
            : MediaColor.FromRgb(255, 255, 255));
        ThinkModeButton.Background = new SolidColorBrush(_thinkMode
            ? MediaColor.FromRgb(201, 132, 106)
            : MediaColor.FromArgb(102, 255, 255, 255));
        ThinkModeButton.Foreground = new SolidColorBrush(_thinkMode
            ? MediaColor.FromRgb(255, 255, 255)
            : MediaColor.FromRgb(107, 93, 79));
        StatusText.Text = _thinkMode ? "思考模式 · 桌宠猫箱" : "灵动模式 · 桌宠猫箱";
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

    private async void OnSendClick(object sender, RoutedEventArgs e) => await SendCurrentMessageAsync();

    private async void OnStopClick(object sender, RoutedEventArgs e)
    {
        if (_server is null || string.IsNullOrWhiteSpace(_activeClient?.ClientId) || string.IsNullOrWhiteSpace(_activeRequestId)) return;
        await _server.CancelFunAsync(_activeClient.ClientId, _activeRequestId);
    }

    private void OnClearClick(object sender, RoutedEventArgs e)
    {
        _messages.Clear();
        MessagesHost.Children.Clear();
        EmptyChatText.Visibility = Visibility.Visible;
    }

    private async void OnFunInputPreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != Key.Enter || Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) return;
        e.Handled = true;
        await SendCurrentMessageAsync();
    }

    private void OnBackClick(object sender, RoutedEventArgs e)
    {
        SetBusy(false);
        CharacterSelectionView.Visibility = Visibility.Visible;
        ChatView.Visibility = Visibility.Collapsed;
        _activeCharacter = null;
        _messages.Clear();
        MessagesHost.Children.Clear();
    }

    private void OnNormalModeClick(object sender, RoutedEventArgs e)
    {
        _thinkMode = false;
        UpdateModeButtons();
    }

    private void OnThinkModeClick(object sender, RoutedEventArgs e)
    {
        _thinkMode = true;
        UpdateModeButtons();
    }

    private void OnCreateCharacterClick(object sender, RoutedEventArgs e) => OpenEditor(null);

    private void OnEditCharacterClick(object sender, RoutedEventArgs e)
    {
        if (_activeCharacter is null) return;
        OpenEditor(_activeCharacter);
    }

    private void OnCancelEditorClick(object sender, RoutedEventArgs e) => CloseEditor();

    private void OnSaveCharacterClick(object sender, RoutedEventArgs e) => SaveEditor();

    private void OnChooseAvatarImageClick(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择角色头像",
            Filter = "Image files|*.png;*.jpg;*.jpeg;*.webp;*.bmp|All files|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (dialog.ShowDialog(this) != true) return;
        _pendingAvatarImagePath = CopyAvatarImage(dialog.FileName);
        UpdateEditorAvatarPreview();
    }

    private void OnClearAvatarImageClick(object sender, RoutedEventArgs e)
    {
        _pendingAvatarImagePath = "";
        UpdateEditorAvatarPreview();
    }

    private void OnEditorEmojiChanged(object sender, TextChangedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_pendingAvatarImagePath)) UpdateEditorAvatarPreview();
    }

    private void OnBackgroundSettingsClick(object sender, RoutedEventArgs e) => OpenVisualSettings("background");

    private void OnBubbleSettingsClick(object sender, RoutedEventArgs e) => OpenVisualSettings("bubble");

    private void OpenVisualSettings(string section)
    {
        if (_busy) return;
        _returnToChatAfterVisualSettings = ChatView.Visibility == Visibility.Visible;
        VisualSettingsTitle.Text = section == "bubble" ? "聊天气泡" : "窗口背景";
        CharacterSelectionView.Visibility = Visibility.Collapsed;
        ChatView.Visibility = Visibility.Collapsed;
        EditorView.Visibility = Visibility.Collapsed;
        VisualSettingsView.Visibility = Visibility.Visible;
        RenderVisualOptions();
    }

    private void OnCloseVisualSettingsClick(object sender, RoutedEventArgs e)
    {
        VisualSettingsView.Visibility = Visibility.Collapsed;
        if (_returnToChatAfterVisualSettings && _activeCharacter is not null)
        {
            ChatView.Visibility = Visibility.Visible;
            FunInput.Focus();
        }
        else
        {
            CharacterSelectionView.Visibility = Visibility.Visible;
        }
        _returnToChatAfterVisualSettings = false;
    }

    private void OnChooseWindowBackgroundClick(object sender, RoutedEventArgs e) => ChooseWindowBackground();

    private void ChooseWindowBackground()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择猫箱背景",
            Filter = "Image files|*.png;*.jpg;*.jpeg;*.webp;*.bmp|All files|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (dialog.ShowDialog(this) != true) return;
        _characterStore.CustomBackgroundImagePath = CopyWindowBackground(dialog.FileName);
        _characterStore.SelectedBackgroundId = "custom";
        _characterStore.Save();
        ApplyVisualPreferences();
        RenderVisualOptions();
    }

    private void OnClearWindowBackgroundClick(object sender, RoutedEventArgs e)
    {
        _characterStore.CustomBackgroundImagePath = "";
        _characterStore.SelectedBackgroundId = "none";
        _characterStore.Save();
        ApplyVisualPreferences();
        RenderVisualOptions();
    }

    private static string CopyAvatarImage(string sourcePath)
    {
        try
        {
            if (!File.Exists(sourcePath)) return "";
            var extension = Path.GetExtension(sourcePath);
            if (string.IsNullOrWhiteSpace(extension)) extension = ".png";
            var avatarDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TryloCode",
                "catbox-avatars");
            Directory.CreateDirectory(avatarDir);
            var targetPath = Path.Combine(avatarDir, Guid.NewGuid().ToString("N") + extension.ToLowerInvariant());
            File.Copy(sourcePath, targetPath, overwrite: false);
            return targetPath;
        }
        catch
        {
            return sourcePath;
        }
    }

    private static string CopyWindowBackground(string sourcePath)
    {
        try
        {
            if (!File.Exists(sourcePath)) return "";
            var extension = Path.GetExtension(sourcePath);
            if (string.IsNullOrWhiteSpace(extension)) extension = ".png";
            var backgroundDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TryloCode",
                "catbox-backgrounds");
            Directory.CreateDirectory(backgroundDir);
            var targetPath = Path.Combine(backgroundDir, Guid.NewGuid().ToString("N") + extension.ToLowerInvariant());
            File.Copy(sourcePath, targetPath, overwrite: false);
            return targetPath;
        }
        catch
        {
            return sourcePath;
        }
    }

    private void OnTitleBarMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed ||
            FindVisualParent<WpfButton>(e.OriginalSource as DependencyObject) is not null) return;

        if (e.ClickCount == 2)
        {
            ToggleMaximize();
            e.Handled = true;
            return;
        }

        e.Handled = true;
        try { DragMove(); } catch { }
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

    private void OnMaximizeClick(object sender, RoutedEventArgs e) => ToggleMaximize();

    private void ToggleMaximize()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => Close();

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        if (PresentationSource.FromVisual(this) is HwndSource source)
        {
            source.AddHook(WndProc);
        }
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != WmNchittest || WindowState == WindowState.Maximized)
        {
            return IntPtr.Zero;
        }

        var point = PointFromScreen(new System.Windows.Point(GetX(lParam), GetY(lParam)));
        var hit = HitTestResizeBorder(point);
        if (hit == HtClient)
        {
            return IntPtr.Zero;
        }

        handled = true;
        return new IntPtr(hit);
    }

    private int HitTestResizeBorder(System.Windows.Point point)
    {
        var left = point.X <= ResizeBorderThickness;
        var right = point.X >= ActualWidth - ResizeBorderThickness;
        var top = point.Y <= ResizeBorderThickness;
        var bottom = point.Y >= ActualHeight - ResizeBorderThickness;

        if (top && left) return HtTopLeft;
        if (top && right) return HtTopRight;
        if (bottom && left) return HtBottomLeft;
        if (bottom && right) return HtBottomRight;
        if (left) return HtLeft;
        if (right) return HtRight;
        if (top) return HtTop;
        if (bottom) return HtBottom;
        return HtClient;
    }

    private static int GetX(IntPtr lParam) => unchecked((short)((long)lParam & 0xffff));

    private static int GetY(IntPtr lParam) => unchecked((short)(((long)lParam >> 16) & 0xffff));

    internal void PrepareQaRender(
        string outputPath,
        bool openChat = false,
        bool openEditor = false,
        bool visualDemo = false)
    {
        Loaded += (_, _) =>
        {
            if (visualDemo)
            {
                _characterStore.SelectedBackgroundId = "rain-cafe";
                _characterStore.BubbleStyleId = "glass";
                ApplyVisualPreferences();
                RenderVisualOptions();
            }
            if (openEditor)
            {
                OpenEditor(null);
                EditorEmojiInput.Text = "*";
                EditorNameInput.Text = "Rain Mechanic";
                EditorDescriptionInput.Text = "会修理所有东西，也会认真听你说完";
                EditorSystemInput.Text = "你是一个温和但有点固执的机械师，擅长把复杂问题拆开讲清楚。";
                EditorOpeningInput.Text = "门口的雨还没停。你先进来，我把热茶放桌上了。";
                UpdateEditorAvatarPreview();
            }
            else if (openChat)
            {
                OpenCharacter(_characters.FirstOrDefault(item => item.Id == "tsundere-cat") ?? _characters.First());
                AddStoredMessage("user", "你今天怎么在桌宠里出现啦？", render: true);
                EnsureStreamingBubble();
                SetBusy(true);
            }
        };
        ContentRendered += (_, _) =>
        {
            Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(() =>
            {
            var bitmap = new RenderTargetBitmap(
                Math.Max(1, (int)Math.Ceiling(ActualWidth)),
                Math.Max(1, (int)Math.Ceiling(ActualHeight)),
                96,
                96,
                PixelFormats.Pbgra32);
            bitmap.Render(this);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
            using (var stream = File.Create(outputPath)) encoder.Save(stream);
            Close();
            }));
        };
    }
}
