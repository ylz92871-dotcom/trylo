using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.IO;

namespace TryloDesktopPet;

internal sealed class CompanionServer : IDisposable
{
    private const int Port = 49371;
    private const int ChatPort = 49372;
    private readonly UdpClient _udp = new(new IPEndPoint(IPAddress.Loopback, Port));
    private readonly TcpListener? _chatListener;
    private readonly CancellationTokenSource _stop = new();
    private readonly Dictionary<string, PetMessage> _clients = new();
    private readonly Dictionary<string, IPEndPoint> _clientEndpoints = new();
    private readonly Dictionary<string, ChatConnection> _chatConnections = new();
    private readonly object _gate = new();

    /// <summary>Raised when the active client changes. The second argument is
    /// the number of OTHER clients currently running a task (rank &gt;= 4), so
    /// the pet can show a very light "+N" hint alongside the active task.</summary>
    public event Action<PetMessage?, int>? ActiveClientChanged;
    public event Action<string>? OpenChatRequested;
    public event Action<PetChatEnvelope>? ChatEventReceived;
    public event Action<string, bool>? ChatConnectionChanged;

    public CompanionServer()
    {
        _ = ReceiveLoopAsync();
        try
        {
            _chatListener = new TcpListener(IPAddress.Loopback, ChatPort);
            _chatListener.Start();
            _ = AcceptChatLoopAsync();
        }
        catch
        {
            _chatListener = null;
        }
    }

    public PetMessage? GetActiveClient()
    {
        lock (_gate)
        {
            RemoveExpiredClients();
            return SelectActiveClient();
        }
    }

    public async Task<bool> SendPermissionDecisionAsync(
        string clientId,
        string requestId,
        string decision)
    {
        IPEndPoint? endpoint;
        lock (_gate)
        {
            _clientEndpoints.TryGetValue(clientId, out endpoint);
        }
        if (endpoint is null || string.IsNullOrWhiteSpace(requestId)) return false;

        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            protocol = 1,
            type = "permission_decision",
            clientId,
            requestId,
            decision,
            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
        try
        {
            await _udp.SendAsync(payload, endpoint);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public Task<bool> RequestChatHistoryAsync(string clientId) =>
        SendChatCommandAsync(clientId, new PetChatEnvelope
        {
            Protocol = 2,
            Type = "chat_history_request",
            ClientId = clientId,
            Mode = "chat",
        });

    public Task<bool> SendChatMessageAsync(string clientId, string requestId, string text) =>
        SendChatCommandAsync(clientId, new PetChatEnvelope
        {
            Protocol = 2,
            Type = "chat_send",
            ClientId = clientId,
            RequestId = requestId,
            Mode = "chat",
            Text = text,
        });

    public Task<bool> SendFunMessageAsync(
        string clientId,
        string requestId,
        string text,
        CatBoxCharacter character,
        IEnumerable<PetChatHistoryItem> history,
        bool thinkMode) =>
        SendChatCommandAsync(clientId, new PetChatEnvelope
        {
            Protocol = 2,
            Type = "chat_send",
            ClientId = clientId,
            RequestId = requestId,
            Mode = "fun",
            Text = text,
            CharId = character.Id,
            CharName = character.Name,
            CharSystemPrompt = character.SystemPrompt,
            ThinkMode = thinkMode,
            Messages = history.ToList(),
        });

    public Task<bool> ClearChatAsync(string clientId) =>
        SendChatCommandAsync(clientId, new PetChatEnvelope
        {
            Protocol = 2,
            Type = "chat_clear",
            ClientId = clientId,
            Mode = "chat",
        });

    public Task<bool> CancelChatAsync(string clientId, string requestId) =>
        SendChatCommandAsync(clientId, new PetChatEnvelope
        {
            Protocol = 2,
            Type = "chat_cancel",
            ClientId = clientId,
            RequestId = requestId,
            Mode = "chat",
        });

    public Task<bool> CancelFunAsync(string clientId, string requestId) =>
        SendChatCommandAsync(clientId, new PetChatEnvelope
        {
            Protocol = 2,
            Type = "chat_cancel",
            ClientId = clientId,
            RequestId = requestId,
            Mode = "fun",
        });

    private async Task<bool> SendChatCommandAsync(string clientId, PetChatEnvelope payload)
    {
        ChatConnection? connection;
        lock (_gate)
        {
            _chatConnections.TryGetValue(clientId, out connection);
        }
        if (connection is null) return false;
        try
        {
            var line = JsonSerializer.Serialize(payload);
            await connection.WriteLock.WaitAsync(_stop.Token);
            try
            {
                await connection.Writer.WriteLineAsync(line);
                await connection.Writer.FlushAsync();
            }
            finally
            {
                connection.WriteLock.Release();
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private async Task AcceptChatLoopAsync()
    {
        if (_chatListener is null) return;
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                var client = await _chatListener.AcceptTcpClientAsync(_stop.Token);
                _ = HandleChatConnectionAsync(client);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                await Task.Delay(250);
            }
        }
    }

    private async Task HandleChatConnectionAsync(TcpClient client)
    {
        string clientId = "";
        var connection = new ChatConnection(client);
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var line = await connection.Reader.ReadLineAsync(_stop.Token);
                if (line is null) break;
                PetChatEnvelope? message;
                try
                {
                    message = JsonSerializer.Deserialize<PetChatEnvelope>(line);
                }
                catch
                {
                    continue;
                }
                if (message is null || message.Protocol != 2 || string.IsNullOrWhiteSpace(message.ClientId)) continue;
                if (message.Type == "chat_hello")
                {
                    clientId = message.ClientId;
                    lock (_gate)
                    {
                        if (_chatConnections.TryGetValue(clientId, out var previous) && previous != connection)
                        {
                            previous.Dispose();
                        }
                        _chatConnections[clientId] = connection;
                    }
                    ChatConnectionChanged?.Invoke(clientId, true);
                    continue;
                }
                if (!string.Equals(message.ClientId, clientId, StringComparison.Ordinal)) continue;
                ChatEventReceived?.Invoke(message);
            }
        }
        catch (OperationCanceledException) { }
        catch { }
        finally
        {
            var removed = false;
            lock (_gate)
            {
                if (!string.IsNullOrWhiteSpace(clientId) &&
                    _chatConnections.TryGetValue(clientId, out var current) &&
                    current == connection)
                {
                    _chatConnections.Remove(clientId);
                    removed = true;
                }
            }
            if (removed) ChatConnectionChanged?.Invoke(clientId, false);
            connection.Dispose();
        }
    }

    private async Task ReceiveLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                var result = await _udp.ReceiveAsync(_stop.Token);
                var message = JsonSerializer.Deserialize<PetMessage>(result.Buffer);
                if (message is null || message.Protocol != 1 || string.IsNullOrWhiteSpace(message.ClientId)) continue;
                var shouldOpenChat = message.Type == "open_chat";

                PetMessage? active;
                lock (_gate)
                {
                    if (message.Type == "detach")
                    {
                        _clients.Remove(message.ClientId);
                        _clientEndpoints.Remove(message.ClientId);
                    }
                    else
                    {
                        message.LastSeenUtc = DateTime.UtcNow;
                        _clients[message.ClientId] = message;
                        _clientEndpoints[message.ClientId] = result.RemoteEndPoint;
                    }
                    RemoveExpiredClients();
                    active = SelectActiveClient();
                }
                // Count OTHER busy clients (a second desktop / workspace mid-task)
                // so the bubble can carry a light "+N" hint. Permissions and the
                // done/failed/idle ranks don't count as running tasks.
                var workingPeers = 0;
                if (active is not null)
                {
                    workingPeers = _clients.Values.Count(c =>
                        !ReferenceEquals(c, active) && ActivityRank(c.State) >= 4);
                }
                ActiveClientChanged?.Invoke(active, workingPeers);
                if (shouldOpenChat) OpenChatRequested?.Invoke(message.ClientId);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                await Task.Delay(250);
            }
        }
    }

    private void RemoveExpiredClients()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-9);
        foreach (var id in _clients.Where(pair => pair.Value.LastSeenUtc < cutoff).Select(pair => pair.Key).ToArray())
        {
            _clients.Remove(id);
            _clientEndpoints.Remove(id);
        }
    }

    private PetMessage? SelectActiveClient()
    {
        return _clients.Values
            .OrderByDescending(client => IsPendingPermission(client.Permission) ? 10 : ActivityRank(client.State))
            .ThenByDescending(client => client.At)
            .ThenByDescending(client => client.LastSeenUtc)
            .FirstOrDefault();
    }

    private static int ActivityRank(string state) => state switch
    {
        "failed" or "stalled" => 5,
        "thinking" or "planning" or "writing_files" or "running_command" or "program_running" => 4,
        "waiting_output" => 3,
        "done" => 2,
        _ => 1,
    };

    private static bool IsPendingPermission(PetPermissionRequest? permission) =>
        permission is not null &&
        !string.IsNullOrWhiteSpace(permission.RequestId) &&
        (string.IsNullOrWhiteSpace(permission.ApprovalState) ||
         permission.ApprovalState.Equals("pending", StringComparison.OrdinalIgnoreCase));

    public void Dispose()
    {
        _stop.Cancel();
        try { _chatListener?.Stop(); } catch { }
        lock (_gate)
        {
            foreach (var connection in _chatConnections.Values) connection.Dispose();
            _chatConnections.Clear();
        }
        _udp.Dispose();
        _stop.Dispose();
    }

    private sealed class ChatConnection : IDisposable
    {
        public TcpClient Client { get; }
        public StreamReader Reader { get; }
        public StreamWriter Writer { get; }
        public SemaphoreSlim WriteLock { get; } = new(1, 1);

        public ChatConnection(TcpClient client)
        {
            Client = client;
            Client.NoDelay = true;
            var stream = client.GetStream();
            Reader = new StreamReader(stream, new System.Text.UTF8Encoding(false), false, 4096, leaveOpen: true);
            Writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), 4096, leaveOpen: true)
            {
                AutoFlush = true,
            };
        }

        public void Dispose()
        {
            try { Client.Dispose(); } catch { }
            WriteLock.Dispose();
        }
    }
}
