import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { RemoteSnapshot } from "../src/gateway";

const h = vi.hoisted(() => ({
  client: {} as any,
  snapshot: null as any,
  snapshots: null as any,
  states: null as any,
  directMounts: 0,
  directUnmounts: 0,
}));
vi.mock("../src/gateway", () => ({
  gatewayClient: h.client,
  parsePairingData: JSON.parse,
}));
vi.mock("../src/DirectChatView", async () => {
  const { useEffect } = await import("react");
  return { default: ({ onHome }: any) => {
    useEffect(() => { h.directMounts++; return () => { h.directUnmounts++; }; }, []);
    return <div><p>手机直连页面</p><button onClick={onHome}>返回首页</button></div>;
  } };
});
vi.mock("../src/ui", () => ({
  MarkdownMessage: ({ text }: any) => <p>{text}</p>,
  BrandMark: () => <span />,
  EmptyState: ({ title }: any) => <p>{title}</p>,
  AttachmentStrip: () => <span />,
  uiText: (language: string, zh: string, en: string) =>
    language === "en" ? en : zh,
  formatBytes: (value: number) => String(value),
  formatRecentTime: () => "",
  formatChatTime: () => "",
  hasWideMarkdownBlock: () => false,
}));
vi.mock("@capacitor/barcode-scanner", () => ({
  CapacitorBarcodeScanner: { scanBarcode: vi.fn() },
  CapacitorBarcodeScannerAndroidScanningLibrary: {},
  CapacitorBarcodeScannerCameraDirection: {},
  CapacitorBarcodeScannerScanOrientation: {},
  CapacitorBarcodeScannerTypeHint: {},
}));
vi.mock("@ionic/react", async () => {
  const React = await import("react");
  const div = ({ children, className, ...props }: any) => (
    <div className={className} hidden={props.hidden} style={props.style}>{children}</div>
  );
  const result: Record<string, any> = Object.fromEntries(
    [
      "IonApp",
      "IonBadge",
      "IonButtons",
      "IonContent",
      "IonHeader",
      "IonIcon",
      "IonLabel",
      "IonList",
      "IonPage",
      "IonRange",
      "IonSpinner",
      "IonTitle",
      "IonToolbar",
    ].map((name) => [name, div]),
  );
  result.IonIcon = () => <span />;
  result.IonBadge = ({ children }: any) => <span>{children}</span>;
  result.IonButton = ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  result.IonItem = ({ children, button, onClick, disabled, className }: any) =>
    button ? (
      <button className={className} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ) : (
      <div>{children}</div>
    );
  result.IonModal = ({ isOpen, children }: any) =>
    isOpen ? <div data-modal>{children}</div> : null;
  result.IonToast = ({ isOpen, message }: any) =>
    isOpen ? <p role="alert">{message}</p> : null;
  result.IonTextarea = ({ label, value, onIonInput }: any) => (
    <textarea
      aria-label={label}
      value={value}
      onChange={(event) =>
        onIonInput?.({ detail: { value: event.target.value } })
      }
    />
  );
  return result;
});

import App from "../src/App";
import RemoteWorkbench from "../src/remote/RemoteWorkbench";
import {
  saveRemoteConversation,
  readLatestCachedConversation,
} from "../src/remoteCache";

let root: Root;
let container: HTMLDivElement;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function snapshot(session = "s1", project = "p1"): RemoteSnapshot {
  return {
    device: {
      id: "pc",
      name: "开发电脑",
      workspace: project,
      online: true,
      latencyMs: 1,
      lastSeenAt: Date.now(),
    },
    agent: {
      status: "idle",
      title: "就绪",
      detail: "",
      progress: 0,
      elapsed: "",
      mode: "agent",
      phase: "ready",
      finalResponse: null,
      technicalEventCount: 0,
      timeline: [],
    },
    activeProjectId: project,
    projects: [
      { id: "p1", name: "项目一", lastSeenAt: 1 },
      { id: "p2", name: "项目二", lastSeenAt: 2 },
    ],
    activeSessionId: session,
    sessions: [
      {
        id: session,
        title: session,
        surface: "code",
        preview: "",
        updatedAt: 1,
      },
    ],
    conversation: [
      {
        id: "same-id",
        role: "tool",
        title: "读取配置",
        text: "",
        status: "done",
        input: '{"path":"config.ts"}',
        output: session,
        at: 1,
      },
    ],
    approvals: [],
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const render = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};
const visible = (el: Element) => !el.closest("[hidden]");
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      visible(el) &&
      (el.getAttribute("aria-label") === name ||
        el.textContent?.trim() === name),
  );
async function click(name: string) {
  const el = button(name);
  expect(el, `button ${name}`).toBeDefined();
  await act(async () => el!.click());
}
async function input(value: string) {
  const el = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="发送到电脑的消息"]',
  )!;
  expect(el).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const draft = () =>
  container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="发送到电脑的消息"]',
  )?.value;
const heading = (text: string) =>
  [...container.querySelectorAll("h1,h2")].find(
    (el) => visible(el) && el.textContent === text,
  );
async function devices() {
  if (button("返回会话列表")) await click("返回会话列表");
  await click("设备");
}
async function direct() {
  await devices();
  await click("手机直连聊天");
}
function workbench(state = h.snapshot, connection = "connected", demo = false) {
  return (
    <RemoteWorkbench
      navigation={{ id: 0, tab: "chat" }}
      snapshot={state}
      messages={state.conversation}
      state={connection as any}
      language="zh"
      demo={demo}
      cachedAt={null}
      artifacts={[]}
      artifactsLoading={false}
      artifactError=""
      onRefreshArtifacts={vi.fn()}
      onReconnect={vi.fn()}
      onPair={vi.fn()}
      onSettings={vi.fn()}
      onDirect={vi.fn()}
      onProjects={vi.fn()}
      onSession={vi.fn()}
      onCreate={vi.fn()}
      onOpenArtifact={vi.fn()}
    />
  );
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  h.directMounts = 0;
  h.directUnmounts = 0;
  h.snapshot = snapshot();
  h.snapshots = null;
  h.states = null;
  Object.assign(h.client, {
    isDemo: false,
    currentConfig: { deviceId: "pc", deviceName: "开发电脑" },
    initialize: vi.fn(async () => {}),
    getSnapshot: vi.fn(async () => clone(h.snapshot)),
    getArtifacts: vi.fn(async () => []),
    getProjects: vi.fn(async () => ({
      projects: h.snapshot.projects,
      activeProjectId: h.snapshot.activeProjectId,
    })),
    subscribe: vi.fn((onSnapshot, onState) => {
      h.snapshots = onSnapshot;
      h.states = onState;
      onState("connecting");
      queueMicrotask(() => {
        onSnapshot(clone(h.snapshot));
        onState("connected");
      });
      return () => {};
    }),
    selectProject: vi.fn(async () => ({ accepted: true })),
    selectSession: vi.fn(async () => ({ accepted: true })),
    createSession: vi.fn(async () => ({ accepted: true })),
    sendChat: vi.fn(async () => ({ accepted: true, requestId: "r" })),
    decidePermission: vi.fn(async () => {}),
    cancelCurrentTask: vi.fn(async () => {}),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test("home exposes phone chat and computer work without a setup gate", async () => {
  await render(<App />);
  expect(heading("从这里开始")).toBeDefined();
  await click("在手机上聊聊写作、问答、整理想法，无需连接电脑");
  expect(container.textContent).toContain("手机直连页面");
  await click("返回首页");
  expect(heading("从这里开始")).toBeDefined();
  await click("待处理");
  expect(heading("待处理")).toBeDefined();
});

async function openCurrent() {
  await click("会话");
  const row = container.querySelector<HTMLButtonElement>(".rw-session");
  expect(row).not.toBeNull();
  await act(async () => row!.click());
}
async function renderConversation() { await render(<App />); await openCurrent(); }

test("demo content never claims a connected computer or permits remote writes", async () => {
  await render(workbench(h.snapshot, "connected", true));
  expect(container.textContent).toContain("未配对");
  expect(container.textContent).toContain("尚未连接电脑，当前显示演示内容");
  expect(container.textContent).not.toContain("已同步");
  expect(button("发送消息")?.disabled).toBe(true);
  await devices();
  expect(container.textContent).not.toContain("连接正常，会话已同步");
  expect(container.querySelector('.rw-device-card .online')).toBeNull();
});
test("remote draft survives a visit to direct chat", async () => {
  await renderConversation();
  await input("还没发送的远程草稿");
  await direct();
  await click("返回首页");
  // Returning keeps the previous remote navigation position; reopen the current chat.
  if (button("会话")) {
    await click("会话");
    const row = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (el) =>
        visible(el) &&
        el.textContent?.includes("s1") &&
        el.classList.contains("rw-session"),
    );
    await act(async () => row!.click());
  }
  expect(draft()).toBe("还没发送的远程草稿");
});
test("same tool ids in another session do not inherit expansion", async () => {
  await render(workbench());
  await click("过程模式");
  const summary = container.querySelector("summary")!;
  await act(async () => {
    summary.click();
  });
  await flush();
  expect(container.querySelector("details")?.open).toBe(true);
  await render(workbench(snapshot("s2")));
  expect(container.querySelector("details")?.open).toBe(false);
});
test("a late projects read cannot roll back a newer selected project", async () => {
  const pending = deferred<any>();
  h.client.getProjects.mockReturnValue(pending.promise);
  await renderConversation();
  await devices();
  await click("切换项目");
  h.snapshot = snapshot("s2", "p2");
  await act(async () => h.snapshots(clone(h.snapshot)));
  await act(async () =>
    pending.resolve({ projects: snapshot().projects, activeProjectId: "p1" }),
  );
  const p2 = [...container.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("项目二"),
  );
  expect(p2?.classList.contains("project-item--active")).toBe(true);
});
test("project selection is serialized while its request is pending", async () => {
  const pending = deferred<any>();
  h.client.selectProject.mockReturnValue(pending.promise);
  await renderConversation();
  await devices();
  await click("切换项目");
  const p2 = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.includes("项目二"),
  )!;
  await act(async () => {
    p2.click();
    p2.click();
  });
  expect(h.client.selectProject).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ accepted: true }));
});
test("a failed refresh preserves the current session rather than loading a newer different cache", async () => {
  await renderConversation();
  saveRemoteConversation(
    "other",
    "p2",
    [{ id: "wrong", role: "assistant", text: "不属于当前会话的内容", at: 1 }],
    "pc",
  );
  h.client.getSnapshot.mockRejectedValue(new Error("读取失败"));
  h.client.subscribe.mockImplementation((s, state) => {
    h.snapshots = s;
    h.states = state;
    state("connecting");
    return () => {};
  });
  await click("查看会话与设备");
  await click("重新同步");
  expect(container.textContent).not.toContain("不属于当前会话的内容");
});
test("secure-storage initialization failure still leaves an actionable offline screen", async () => {
  h.client.initialize.mockRejectedValue(new Error("安全存储不可用"));
  await render(<App />);
  expect(heading("从这里开始")).toBeDefined();
});
test("an empty authoritative session clears its prior offline cache", () => {
  saveRemoteConversation(
    "s1",
    "p1",
    [{ id: "old", role: "assistant", text: "已清空的内容", at: 1 }],
    "pc",
  );
  saveRemoteConversation("s1", "p1", [], "pc");
  expect(readLatestCachedConversation("pc")?.messages || []).toEqual([]);
});
test("failed send keeps draft and a pending send cannot submit twice", async () => {
  const pending = deferred<any>();
  h.client.sendChat.mockReturnValue(pending.promise);
  await render(workbench());
  await input("请继续");
  await click("发送消息");
  await click("发送消息");
  expect(h.client.sendChat).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error("发送失败")));
  expect(draft()).toBe("请继续");
});
test("offline approval controls never call the mutation API", async () => {
  h.snapshot.approvals = [
    {
      id: "permission-1",
      category: "command",
      title: "运行检查",
      detail: "check",
      risk: "low",
      requestedAt: 1,
    },
  ];
  await render(workbench(h.snapshot, "offline"));
  await click("需要你确认运行检查查看");
  await click("允许本次");
  expect(h.client.decidePermission).not.toHaveBeenCalled();
});
test("approval retry submits the selected request id and keeps the panel after failure", async () => {
  h.snapshot.approvals = [
    {
      id: "permission-1",
      category: "command",
      title: "第一项",
      detail: "one",
      risk: "low",
      requestedAt: 1,
    },
    {
      id: "permission-2",
      category: "write",
      title: "第二项",
      detail: "two",
      risk: "high",
      requestedAt: 2,
    },
  ];
  h.client.decidePermission
    .mockRejectedValueOnce(new Error("审批提交失败"))
    .mockResolvedValueOnce(undefined);
  await render(workbench());
  await click("返回会话列表");
  await click("待处理");
  const second = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (el) =>
      el.classList.contains("rw-inbox-item") &&
      el.textContent?.includes("第二项"),
  )!;
  await act(async () => second.click());
  await click("允许本次");
  expect(h.client.decidePermission).toHaveBeenLastCalledWith(
    "permission-2",
    "allow",
  );
  expect(container.textContent).toContain("审批提交失败");
  await click("拒绝");
  expect(h.client.decidePermission).toHaveBeenLastCalledWith(
    "permission-2",
    "deny",
  );
});
test("late artifact lists cannot replace files from a newer session", async () => {
  const old = deferred<any>();
  h.client.getArtifacts
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue([
      { id: "new.md", name: "new.md", kind: "file", size: 1, modifiedAt: 1 },
    ]);
  await renderConversation();
  h.snapshot = snapshot("s2");
  await act(async () => h.snapshots(clone(h.snapshot)));
  await click("结果1");
  expect(container.textContent).toContain("new.md");
  await act(async () =>
    old.resolve([
      { id: "old.md", name: "old.md", kind: "file", size: 1, modifiedAt: 1 },
    ]),
  );
  expect(container.textContent).not.toContain("old.md");
  expect(container.textContent).toContain("new.md");
});
test("navigation blocks other writes until a fresh subscription snapshot arrives", async () => {
  const pending = deferred<any>();
  h.client.selectProject.mockReturnValue(pending.promise);
  const oldSnapshots: any[] = [];
  h.client.subscribe.mockImplementation((next, state) => {
    h.snapshots = next;
    h.states = state;
    oldSnapshots.push(next);
    state("connecting");
    if (oldSnapshots.length === 1) {
      next(clone(h.snapshot));
      state("connected");
    }
    return () => {};
  });
  await renderConversation();
  await devices();
  await click("切换项目");
  const p2 = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.includes("项目二"),
  )!;
  await act(async () => p2.click());
  await act(async () =>
    oldSnapshots[0]({
      ...snapshot("stale"),
      conversation: [
        { id: "old", role: "assistant", text: "迟到旧连接内容", at: 1 },
      ],
    }),
  );
  await act(async () => pending.resolve({ accepted: true }));
  expect(container.textContent).not.toContain("迟到旧连接内容");
  await input("等待同步");
  expect(button("发送消息")?.disabled).toBe(true);
  h.snapshot = snapshot("s2", "p2");
  await act(async () => {
    h.snapshots(clone(h.snapshot));
    h.states("connected");
  });
  await input("新的操作");
  expect(button("发送消息")?.disabled).toBe(false);
});
test("a send failure from an old session is not shown in the newly selected session", async () => {
  const pending = deferred<any>();
  h.client.sendChat.mockReturnValue(pending.promise);
  await render(workbench());
  await input("属于 s1 的请求");
  await click("发送消息");
  await render(workbench(snapshot("s2")));
  await act(async () => pending.reject(new Error("s1 的发送失败")));
  expect(container.textContent).not.toContain("s1 的发送失败");
});
test("cold offline cache restores the matching session identity and Work surface", async () => {
  saveRemoteConversation(
    "cached-work",
    "离线项目",
    [{ id: "cached", role: "assistant", text: "离线的会话内容", at: 1 }],
    "pc",
    { title: "历史 Work", surface: "work", projectId: "p2" },
  );
  h.client.getSnapshot.mockRejectedValue(new Error("离线"));
  h.client.subscribe.mockImplementation((s, state) => {
    h.snapshots = s;
    h.states = state;
    state("connecting");
    return () => {};
  });
  await renderConversation();
  expect(heading("历史 Work")).toBeDefined();
  expect(container.textContent).toContain("离线的会话内容");
  expect(container.textContent).toContain("Work");
  expect(button("发送消息")?.disabled).toBe(true);
});
test("a failed stop stays reviewable and reports its error inside the active panel", async () => {
  h.snapshot.agent.status = "running";
  h.client.cancelCurrentTask.mockRejectedValue(new Error("停止请求失败"));
  await render(workbench());
  await click("停止");
  await click("停止任务");
  expect(
    container.querySelector('[role="dialog"] [role="alert"]')?.textContent,
  ).toBe("停止请求失败");
  expect(heading("停止当前任务？")).toBeDefined();
});


test("team selection is explicit and members remain separate from assistant replies", async () => {
  h.snapshot.collaboration = { canStartTeam: true, profiles: [{ id: "team-profile", title: "实现与审查", members: ["实现", "审查"] }], team: null,
    members: [{ id: "child", name: "审查员", status: "waiting", prompt: "审查窄屏布局", result: "第一轮发现问题", rounds: [{ round: 1, prompt: "检查", result: "第一轮发现问题" }, { round: 2, prompt: "复核", result: "第二轮通过" }] }] };
  await render(workbench());
  await click("选择协作方式");
  await click("实现与审查实现 · 审查");
  expect(h.client.sendChat).not.toHaveBeenCalled();
  await input("请完成移动端优化");
  await click("发送消息");
  expect(h.client.sendChat).toHaveBeenCalledWith("请完成移动端优化", [], { surface: "code", teamProfileId: "team-profile" });
  await click("成员1");
  const row = container.querySelector<HTMLButtonElement>(".rw-member-row")!;
  await act(async () => row.click());
  expect(container.textContent).toContain("审查窄屏布局");
  expect(container.textContent).toContain("第二轮通过");
  expect(container.textContent).toContain("等待中");
  await render(workbench(snapshot("s2")));
  expect(container.textContent).not.toContain("第二轮通过");
});

test("a fresh unpaired home has real choices and hides simulated approvals", async () => {
  await render(<RemoteWorkbench {...workbench(h.snapshot, "connected", true).props} navigation={{ id: 0, tab: "home" }} />);
  expect(button("连接我的电脑")).toBeDefined();
  expect(button("在手机上聊聊写作、问答、整理想法，无需连接电脑")).toBeDefined();
  expect(button("发送消息")).toBeUndefined();
  await click("待处理");
  expect(heading("暂时没有待处理事项")).toBeDefined();
});


test("visiting home and remote work never tears down an active phone chat", async () => {
  await render(<App />);
  await click("在手机上聊聊写作、问答、整理想法，无需连接电脑");
  await click("返回首页");
  await openCurrent();
  expect(h.directMounts).toBe(1);
  expect(h.directUnmounts).toBe(0);
});

test("offline team cache keeps member details with their conversation and disables team launch", () => {
  saveRemoteConversation("s1", "p1", [], "pc", { collaboration: { canStartTeam: true, profiles: [{ id: "profile", title: "Team", members: [] }], team: null,
    members: [{ id: "child", name: "审查", status: "done", result: "已完成审查" }] } });
  const cached = readLatestCachedConversation("pc");
  expect(cached?.collaboration?.members[0].result).toBe("已完成审查");
  expect(cached?.collaboration?.canStartTeam).toBe(false);
  expect(readLatestCachedConversation("other-computer")).toBeNull();
});


test("a canonical resumed member updates the open detail without adding another person", async () => {
  const first = snapshot();
  first.collaboration = { canStartTeam: true, profiles: [], team: null, members: [{ id: "stable-row", name: "审查员", status: "done", prompt: "检查", result: "初次回复", rounds: [{ round: 1, prompt: "检查", result: "初次回复" }] }] };
  await render(workbench(first));
  await click("成员1");
  await act(async () => container.querySelector<HTMLButtonElement>(".rw-member-row")!.click());
  const next = clone(first);
  next.collaboration!.members = [{ ...next.collaboration!.members[0], status: "running", rounds: [{ round: 1, prompt: "检查", result: "初次回复" }, { round: 2, prompt: "再检查", result: "续跑回复" }] }];
  await render(workbench(next));
  expect(heading("审查员")).toBeDefined();
  expect(container.textContent).toContain("续跑回复");
  expect(container.textContent).toContain("进行中");
  expect(container.querySelectorAll(".rw-member-row")).toHaveLength(0);
});
