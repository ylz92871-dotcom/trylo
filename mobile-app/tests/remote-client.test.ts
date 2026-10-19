import { afterEach, beforeEach, expect, test, vi } from "vitest";
const storage = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../src/secureStorage", () => ({
  secureGet: storage.get,
  secureSet: storage.set,
  secureRemove: storage.remove,
}));
import { RemoteGatewayClient, parsePairingData } from "../src/gateway";

const baseUrl = "https://example.invalid";
const identity = {
  device: { id: "verified-pc", latencyMs: 0 },
  conversation: [],
  activeSessionId: "s",
  sessions: [],
  projects: [],
  approvals: [],
  agent: { timeline: [] },
};
let request: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  request = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ accepted: true, sessionId: "s", artifacts: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
});
afterEach(() => vi.restoreAllMocks());
function client() {
  return new RemoteGatewayClient({
    baseUrl,
    token: "test-token",
    demo: false,
    deviceId: "old-pc",
  });
}

test("an unpaired demo client reports offline without opening a remote connection", () => {
  const gateway = new RemoteGatewayClient({ baseUrl: '', demo: true });
  const state = vi.fn();
  const dispose = gateway.subscribe(vi.fn(), state);
  expect(state).toHaveBeenCalledWith('offline');
  expect(request).not.toHaveBeenCalled();
  dispose();
});

test("production client sends the expected methods, routes, identity and Code/Work payloads", async () => {
  const gateway = client();
  await gateway.sendChat(
    "整理报告",
    [
      {
        id: "a",
        kind: "text",
        name: "note.txt",
        mimeType: "text/plain",
        size: 5,
        text: "notes",
      },
    ],
    { surface: "work" },
  );
  await gateway.createSession("code");
  await gateway.selectSession("s /2");
  await gateway.selectProject("p /2");
  await gateway.decidePermission("approval /2", "deny");
  await gateway.cancelCurrentTask();
  await gateway.getArtifacts();
  const calls = request.mock.calls.map(([url, init]: any[]) => ({
    url: String(url),
    method: init?.method || "GET",
    headers: init?.headers,
    body: init?.body && JSON.parse(init.body),
  }));
  expect(calls.map((c) => [c.method, c.url])).toEqual([
    ["POST", baseUrl + "/v1/chat/messages"],
    ["POST", baseUrl + "/v1/sessions"],
    ["POST", baseUrl + "/v1/sessions/s%20%2F2/select"],
    ["POST", baseUrl + "/v1/projects/p%20%2F2/select"],
    ["POST", baseUrl + "/v1/permissions/approval%20%2F2/decision"],
    ["POST", baseUrl + "/v1/tasks/current/cancel"],
    ["GET", baseUrl + "/v1/artifacts"],
  ]);
  expect(calls[0].body).toEqual({
    text: "整理报告",
    surface: "work",
    attachments: [
      {
        kind: "text",
        name: "note.txt",
        mimeType: "text/plain",
        size: 5,
        text: "notes",
      },
    ],
  });
  expect(calls[1].body).toEqual({ surface: "code" });
  expect(calls[4].body).toEqual({ decision: "deny" });
  expect(
    calls.every((c) => c.headers.Authorization === "Bearer test-token"),
  ).toBe(true);
});
test("artifact reads encode their path and carry authentication", async () => {
  request.mockResolvedValueOnce(
    new Response("report", {
      headers: {
        "Content-Type": "text/markdown",
        "Content-Disposition": 'inline; filename="report.md"',
      },
    }),
  );
  const result = await client().getArtifactContent("out/中文 report.md");
  expect(request.mock.calls[0][0]).toBe(
    baseUrl + "/v1/artifacts/content?path=out%2F%E4%B8%AD%E6%96%87%20report.md",
  );
  expect((request.mock.calls[0][1] as RequestInit).headers).toEqual({
    Authorization: "Bearer test-token",
  });
  expect(result.name).toBe("report.md");
  expect(await result.blob.text()).toBe("report");
});
test("HTTP errors reject rather than presenting a successful operation", async () => {
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "电脑拒绝此请求" }), { status: 409 }),
  );
  await expect(
    client().sendChat("hello", [], { surface: "code" }),
  ).rejects.toThrow("电脑拒绝此请求");
});
test("pairing identity mismatch cannot replace the existing credentials", async () => {
  request.mockResolvedValueOnce(
    new Response(JSON.stringify(identity), { status: 200 }),
  );
  const gateway = client();
  await expect(
    gateway.configureFromPairing({
      baseUrl,
      deviceId: "wrong-pc",
      deviceName: "new",
      token: "candidate-token",
      protocol: 1,
      service: "trylo-remote",
      workspaceName: "w",
    }),
  ).rejects.toThrow("电脑身份");
  expect(storage.set).not.toHaveBeenCalled();
  expect(localStorage.getItem("trylo-remote.gateway.metadata.v1")).toBeNull();
  expect(gateway.currentConfig.deviceId).toBe("old-pc");
});
test("verified pairing saves metadata and credentials only after the identity read", async () => {
  request.mockResolvedValueOnce(
    new Response(JSON.stringify(identity), { status: 200 }),
  );
  const gateway = client();
  await gateway.configureFromPairing({
    baseUrl,
    deviceId: "verified-pc",
    deviceName: "new",
    token: "candidate-token",
    protocol: 1,
    service: "trylo-remote",
    workspaceName: "w",
  });
  expect(gateway.currentConfig.deviceId).toBe("verified-pc");
  expect(storage.set).toHaveBeenCalledWith(
    "trylo_remote_",
    "gateway_token",
    "candidate-token",
  );
  expect(
    JSON.parse(localStorage.getItem("trylo-remote.gateway.metadata.v1")!)
      .deviceId,
  ).toBe("verified-pc");
});

const serverPairing = {
  baseUrl, deviceId: 'verified-pc', deviceName: 'server-pc', token: 'one-time-ticket-with-at-least-32-characters', protocol: 1,
  service: 'trylo-remote', workspaceName: 'w', connectionMode: 'server' as const, relayDeviceId: '00000000-0000-4000-8000-000000000001',
};
test('server QR exchanges its one-time ticket before persisting a device-scoped credential', async () => {
  request.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'scoped-token-with-at-least-32-characters', relayDeviceId: serverPairing.relayDeviceId, desktopIdentity: 'verified-pc' }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(identity), { status: 200 }));
  const gateway = client();
  const parsed = parsePairingData(JSON.stringify(serverPairing));
  await gateway.configureFromPairing(parsed);
  expect(request.mock.calls[0][0]).toBe(baseUrl + '/relay/pair');
  expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ ticket: serverPairing.token });
  expect(request.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer scoped-token-with-at-least-32-characters', 'X-Trylo-Device': serverPairing.relayDeviceId });
  expect(storage.set).toHaveBeenCalledWith('trylo_remote_', 'gateway_token', 'scoped-token-with-at-least-32-characters');
  expect(gateway.currentConfig.connectionMode).toBe('server');
  expect(JSON.parse(localStorage.getItem('trylo-remote.gateway.metadata.v1')!).relayDeviceId).toBe(serverPairing.relayDeviceId);
  await gateway.sendChat('hello'); await gateway.getArtifactContent('a.txt');
  for (const [, init] of request.mock.calls.slice(1)) expect(init?.headers).toMatchObject({ 'X-Trylo-Device': serverPairing.relayDeviceId });
});
test('server identity mismatch or expired QR leaves the saved computer untouched', async () => {
  request.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'scoped-token-with-at-least-32-characters', relayDeviceId: serverPairing.relayDeviceId, desktopIdentity: 'another-pc' }), { status: 201 }));
  const gateway = client();
  await expect(gateway.configureFromPairing(serverPairing)).rejects.toThrow('身份');
  expect(storage.set).not.toHaveBeenCalled(); expect(gateway.currentConfig.deviceId).toBe('old-pc');
  request.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Pairing code expired' }), { status: 401 }));
  await expect(gateway.configureFromPairing(serverPairing)).rejects.toThrow('expired');
  expect(storage.set).not.toHaveBeenCalled();
});
