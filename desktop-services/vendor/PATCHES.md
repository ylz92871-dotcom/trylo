# vendor/legacy 补丁清单（PATCHES）

> 规则（migration spec §0.3 / §4）：`vendor/legacy/` 下文件默认逐字节保留。
> **唯一允许修改的是本文件记录的补丁**。每处补丁必须写明原因与 diff。
> 新增补丁必须先在此登记，不得静默修改。

## 背景：为什么需要 6 处同类补丁

老仓库里 Python 源码（`hermes-capabilities/`）与 JS 控制面在同一目录，所有 JS 模块
都用 `path.join(__dirname, 'hermes-capabilities', 'xxx.py')` 定位脚本。

迁移后 Python 源码落在 `desktop/sidecars/hermes-capabilities/`（spec §3.1），JS 落在
`desktop-services/vendor/legacy/`。spec §4 白名单只列了 `server.py` 一处；执行核对时
发现**同目录下共有 6 个模块存在同样的路径假设**，全部按同一原则处理：

- 允许 host 用环境变量覆盖目录/脚本路径；
- 缺省值保持老布局，纯 Node 单测下行为不变（`node:test` 无需设置 env）；
- 不复制第二份 Python，不改上游调用语义、不改超时/校验逻辑。

| # | 文件 | env 覆盖 | 脚本 |
|---|---|---|---|
| 1 | `hermes-capability-manager.js` | `TRYLO_HERMES_SERVER_SCRIPT`（spec §4 原文，按字面执行） | `server.py` |
| 2 | `hermes-session-sync.js` | `TRYLO_HERMES_CAPABILITIES_DIR` | `session_adapter.py` |
| 3 | `hermes-pending-admin.js` | `TRYLO_HERMES_CAPABILITIES_DIR` | `admin.py` |
| 4 | `memory-context-client.js` | `TRYLO_HERMES_CAPABILITIES_DIR` | `memory_context_adapter.py` |
| 5 | `history-mining-client.js` | `TRYLO_HERMES_CAPABILITIES_DIR` | `history_adapter.py` |
| 6 | `learning-loop/prompt-client.js` | `TRYLO_HERMES_CAPABILITIES_DIR` | `learning_prompt_adapter.py` |

| env 变量 | 由谁设置 | 缺省 |
|---|---|---|
| `TRYLO_HERMES_CAPABILITIES_DIR` | `desktop-services/src/learning/hermes-env.mjs`（由 `host.mjs` 在加载任何 vendor 模块前调用；派生自 `TRYLO_SIDECARS_DIR`） | `<vendor/legacy>/hermes-capabilities` |
| `TRYLO_HERMES_SERVER_SCRIPT` | 同上，一并设置指向 `<sidecars>/hermes-capabilities/server.py` | 同缺省 |

`learning-loop/prompt-client.js` 位于 `vendor/legacy/learning-loop/`，因此它的缺省前缀是
`path.join(__dirname, '..', 'hermes-capabilities')`，与其余文件的 `__dirname` 前缀不同——
这是原文件的相对位置差异，不是新增差异。

---

## 补丁 1 — `hermes-capability-manager.js`（spec §4 白名单原始项）

原因：Python 源码落在 `desktop/sidecars/hermes-capabilities/`，与 JS 不同目录；不允许复制第二份 Python。

```diff
-const SERVER_SCRIPT = path.join(__dirname, 'hermes-capabilities', 'server.py');
+// PATCH 1 (see desktop-services/vendor/PATCHES.md): the Python sources live in
+// desktop/sidecars/hermes-capabilities/, not next to this vendored JS file.
+const SERVER_SCRIPT = process.env.TRYLO_HERMES_SERVER_SCRIPT
+  || path.join(__dirname, 'hermes-capabilities', 'server.py');
```

## 补丁 2 — `hermes-session-sync.js`

原因：同补丁 1；`session_adapter.py` 用于会话镜像（spec §7.4）。

```diff
-const ADAPTER = path.join(__dirname, 'hermes-capabilities', 'session_adapter.py');
+// PATCH 2 (see desktop-services/vendor/PATCHES.md): resolve the Python
+// capabilities dir from the host env (fallback keeps the upstream layout).
+const ADAPTER = path.join(
+  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
+  'session_adapter.py',
+);
```

## 补丁 3 — `hermes-pending-admin.js`

原因：同补丁 1；`admin.py` 是 3B 的 pending/apply/backup/rollback 唯一入口（spec §7.5）。

```diff
-const ADMIN = path.join(__dirname, 'hermes-capabilities', 'admin.py');
+// PATCH 3 (see desktop-services/vendor/PATCHES.md): resolve the Python
+// capabilities dir from the host env (fallback keeps the upstream layout).
+const ADMIN = path.join(
+  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
+  'admin.py',
+);
```

## 补丁 4 — `memory-context-client.js`

原因：同补丁 1；`memory_context_adapter.py` 是 3A `learning.memorySnapshot` 的来源。

```diff
-const ADAPTER_SCRIPT = path.join(__dirname, 'hermes-capabilities', 'memory_context_adapter.py');
+// PATCH 4 (see desktop-services/vendor/PATCHES.md): resolve the Python
+// capabilities dir from the host env (fallback keeps the upstream layout).
+const ADAPTER_SCRIPT = path.join(
+  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
+  'memory_context_adapter.py',
+);
```

## 补丁 5 — `history-mining-client.js`

原因：同补丁 1；`history_adapter.py` 是 3C 历史挖掘检索的入口。

```diff
-const ADAPTER_SCRIPT = path.join(__dirname, 'hermes-capabilities', 'history_adapter.py');
+// PATCH 5 (see desktop-services/vendor/PATCHES.md): resolve the Python
+// capabilities dir from the host env (fallback keeps the upstream layout).
+const ADAPTER_SCRIPT = path.join(
+  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
+  'history_adapter.py',
+);
```

## 补丁 6 — `learning-loop/prompt-client.js`

原因：同补丁 1；`learning_prompt_adapter.py` 取官方学习提示词（3C orchestrator 依赖）。

```diff
-const ADAPTER_SCRIPT = path.join(__dirname, '..', 'hermes-capabilities', 'learning_prompt_adapter.py');
+// PATCH 6 (see desktop-services/vendor/PATCHES.md): resolve the Python
+// capabilities dir from the host env (fallback keeps the upstream layout).
+const ADAPTER_SCRIPT = path.join(
+  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, '..', 'hermes-capabilities'),
+  'learning_prompt_adapter.py',
+);
```

## 补丁 7 — `desktop-companion-bridge.js`（只读状态投影，2026-08-28）

来源：审计 `docs/TRYLO-WORK-PHASE1-PHASE2-RUNTIME-AUDIT-AND-REMEDIATION-2026-08-28.md` §4.2
PET-P0-2。

原因：`pet.status` 曾经上报 `exeFound: platform === 'win32'`——一个在每台 Windows
机器上都返回 true 的猜测值。于是「宠物 exe 缺失、从未出现过」和「宠物健康运行」在
UI 上完全一样，无法区分。要修好它，必须能读到 bridge **自己**做了什么；而 exe 探测
逻辑只存在于这份 vendor 文件里。

约束（migration spec §0.3）：**不迁移源码、不重写、不改协议、不加依赖**。本补丁只做
四件事，全部是「读出现有局部变量」或「通知既有状态变化」：

1. 新增局部变量 `chatConnected` / `lastLaunch`，在既有代码路径上赋值；
2. `launchCompanion()` 的每个 return 分支前记录真实结果（找不到 exe / spawn 抛错 /
   拿不到 pid / 非 win32）；
3. `disable()` 时把 `launched` 复位（detach 会让 exe 退出），保留 `exeFound`；
4. 新增两个只读出口：`getStatus()` 与 `setChatStateHandler(fn)`。后者只是把
   connect/close/error 里已经发生的事实**通知**出去，不改变 socket 生命周期的
   任何一行逻辑。

不变的部分：所有控制流、所有 `send`/`sendChat` 语义、UDP 端口、心跳周期、重连退避、
`enable()`/`disable()`/`dispose()` 行为——逐字节保留。新增代码不发包、不 spawn、不
抛异常。

关于 `exePath`：只暴露 `path.basename()`。**禁止**把用户机器上的绝对路径穿过
Service Host 送到渲染进程（审计 §3.2 诊断脱敏约束）。

```diff
   let enabled = false;
+  // --- Trylo Desktop introspection (added 2026-08-28, audit §4.2 PET-P0-2) ---
+  let chatConnected = false;
+  let lastLaunch = { exeFound: false, launched: false, exePath: '', reasonCode: 'not_attempted' };
+  let chatStateHandler = null;
+  const notifyChatState = () => {
+    if (typeof chatStateHandler !== 'function') return;
+    try { chatStateHandler(chatConnected); } catch { }
+  };

   const launchCompanion = () => {
-    if (process.platform !== 'win32') return false;
+    if (process.platform !== 'win32') {
+      lastLaunch = { ..., reasonCode: 'unsupported_platform' };
+      return false;
+    }
     const executable = companionCandidates.find(candidate => fs.existsSync(candidate));
-    if (!executable) return false;
+    if (!executable) { lastLaunch = { ..., reasonCode: 'exe_not_found' }; return false; }
+    const exePath = path.basename(executable);
     try {
       const child = spawn(executable, [], { ... });
       child.unref();
-      return true;
+      if (typeof child.pid === 'number' && child.pid > 0) {
+        lastLaunch = { exeFound: true, launched: true, exePath, reasonCode: '' };
+        return true;
+      }
+      lastLaunch = { exeFound: true, launched: false, exePath, reasonCode: 'spawn_no_pid' };
+      return false;
     } catch {
-      return false;
+      lastLaunch = { exeFound: true, launched: false, exePath, reasonCode: 'spawn_failed' };
+      return false;
     }
   };

   const disable = () => {
     if (!enabled && !socket) return;
     enabled = false;
+    // detach 会让 exe 退出，因此 launched 不再为真；exeFound 保留（二进制还在原位）
+    chatConnected = false;
+    lastLaunch = { ...lastLaunch, launched: false, reasonCode: 'not_attempted' };
     ...

   const ensureChatSocket = () => {
       nextSocket.on('connect', () => {
+        chatConnected = true;
+        notifyChatState();
         sendChat({ type: 'chat_hello', at: Date.now() });
       });
       nextSocket.on('error', () => {
+        if (chatSocket === nextSocket) { chatConnected = false; notifyChatState(); }
       });
       nextSocket.on('close', () => {
         if (chatSocket === nextSocket) {
           chatSocket = null;
+          chatConnected = false;
+          notifyChatState();
         }
         scheduleChatReconnect();
       });

     dispose: disable,
     get enabled() { return enabled; },
+    get chatConnected() { return chatConnected; },
+    // 只把已发生的事实通知出去，不改变 socket 生命周期任何一行逻辑
+    setChatStateHandler(handler) {
+      chatStateHandler = typeof handler === 'function' ? handler : null;
+    },
+    getStatus() {
+      return { enabled, chatConnected, exeFound, launchAttempted, launched, exePath, reasonCode };
+    },
   };
```

`launchAttempted` 与 `launched` 是两个不同的事实，UI 需要同时拿到：
「从未尝试过」（模块预加载期、非 Windows）和「尝试过但失败」在用户文案上必须区分。

---

## 无需补丁（已核对，spec §4 结论沿用）

- `desktop-companion-bridge.js`：**除补丁 7 的只读投影外**无需改动；`extensionPath` 已
  由 options 注入，探测/启动/UDP 语义全部保留。
- `hermes-python-resolver.js`：支持 `HERMES_PYTHON` env 覆盖。
- `learning-loop/learning-state.js`：只要求 `{ get, update }` Memento 形状，Desktop 用
  `src/learning/file-memento.mjs` 提供，不新建 schema。
- `remote-gateway/index.js`、`remote-tunnel.js`：全部参数化（Phase 4）。
