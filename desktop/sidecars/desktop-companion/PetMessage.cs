using System.Text.Json.Serialization;

namespace TryloDesktopPet;

internal sealed class PetMessage
{
    [JsonPropertyName("protocol")]
    public int Protocol { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("clientId")]
    public string ClientId { get; set; } = "";

    [JsonPropertyName("workspacePath")]
    public string WorkspacePath { get; set; } = "";

    [JsonPropertyName("workspaceName")]
    public string WorkspaceName { get; set; } = "Trylo Code";

    [JsonPropertyName("state")]
    public string State { get; set; } = "idle";

    [JsonPropertyName("detail")]
    public string Detail { get; set; } = "Ready";

    [JsonPropertyName("level")]
    public string Level { get; set; } = "info";

    [JsonPropertyName("progress")]
    public double Progress { get; set; }

    [JsonPropertyName("at")]
    public long At { get; set; }

    [JsonPropertyName("permission")]
    public PetPermissionRequest? Permission { get; set; }

    [JsonIgnore]
    public DateTime LastSeenUtc { get; set; } = DateTime.UtcNow;
}

internal sealed class PetPermissionRequest
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; set; } = "";

    [JsonPropertyName("title")]
    public string Title { get; set; } = "Permission required";

    [JsonPropertyName("detail")]
    public string Detail { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("category")]
    public string Category { get; set; } = "edit";

    [JsonPropertyName("approvalState")]
    public string ApprovalState { get; set; } = "pending";
}

internal sealed class PetChatEnvelope
{
    [JsonPropertyName("protocol")]
    public int Protocol { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("clientId")]
    public string ClientId { get; set; } = "";

    [JsonPropertyName("requestId")]
    public string RequestId { get; set; } = "";

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = "chat";

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("delta")]
    public string Delta { get; set; } = "";

    [JsonPropertyName("error")]
    public string Error { get; set; } = "";

    [JsonPropertyName("sequence")]
    public int Sequence { get; set; }

    [JsonPropertyName("messages")]
    public List<PetChatHistoryItem> Messages { get; set; } = new();

    [JsonPropertyName("charId")]
    public string CharId { get; set; } = "";

    [JsonPropertyName("charName")]
    public string CharName { get; set; } = "";

    [JsonPropertyName("charSystemPrompt")]
    public string CharSystemPrompt { get; set; } = "";

    [JsonPropertyName("thinkMode")]
    public bool ThinkMode { get; set; }
}

internal sealed class PetChatHistoryItem
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = "assistant";

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("at")]
    public long At { get; set; }
}
