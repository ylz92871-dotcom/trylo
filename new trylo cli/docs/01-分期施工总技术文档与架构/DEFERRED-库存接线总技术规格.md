# DEFERRED 库存接线总技术规格

> 状态：**W1 已执行（含 S1 修正）；W3 ADR 已出初稿；W2 阻塞（见 §7 W2）；W4 起逐波放行**
> 阶段：跨期（P03 存储 → P05 学习面 → P03/P07 工具链 → P08 协议面）
> 最后更新：2026-09-21（W1 执行 + W2 阻塞取证 + W3 ADR）
> 前置：`2026-09-20-WP-抽检修复-交付失败吞错与时钟契约.md`（门禁 11/11 ALL PASS 基线）
> 数据口径：`node scripts/quality/reachability.mjs`（静态 import 图，入口 `src/cmd/trylo/main.ts`）
> 铁律：**一根线一根线地接。每次接线后 "ALL PASS" 的含义必须比上一次更多，而不是更模糊。**
> **S1 修正记录**：本规格 §7 的 W1/W2 设计草案有两处与代码不符，已按 §5 S1 的「以代码
> 为准」条款回改（W1 见 §7 W1 的「S1 修正」段，W2 见 §7 W2 的「阻塞」段）。修正不是
> 放宽验收，而是把验收换成可达成的、非空转的那一条。

## 1. 目标

把 145 个 `approved_deferred` 文件按**就绪度 × 风险**的顺序、以可复核的小提交逐域接入生产入口，使每一根线满足：

1. 接线后从 `main.ts` 可达（reachability 分类如实变动）；
2. 默认行为 **byte-identical**（开关 absent 即关闭，prove-fail 证明"关"真的关着）；
3. 有**组合级**合同测试（adapter 级测试不算数——那测的是零件，不是接线）；
4. verify 门禁 11 步保持 ALL PASS，且**零新增运行时依赖**（许可证闭包不变）。

## 2. 非目标

- 不做大爆炸式合并接线（145 文件一次接通违反一切现行纪律）；
- 不修改 `domain/` 与 `ports/` 的既有合同（接线只发生在组合根 `surface/cli/wiring.ts`、`run-command.ts` 与 adapters 层；确需新端口时单独立 ADR）；
- 不在本规格内执行 W4（学习面）——P05 明文要求学习类工作包先与产品所有者讨论，本规格只给出方案与边界；
- 不接线 `surface/protocol`（7 文件）——它是 P08 Desktop parity 的协议面，目的地不是 CLI 入口；
- 不为接线引入任何第三方依赖（当前 3 packages 闭包不变）。

## 3. 基线数据（2026-09-20 实测）

### 3.1 五态分类现状

| 分类 | 数量 | 说明 |
| --- | --- | --- |
| production_reachable | 319 | 已接通 |
| library_reachable | 14 | 经端口/协议共享库可达（domain/index、protocol/* 等） |
| test_support | 19 | 仅测试消费 |
| **approved_deferred** | **145** | **本规格的对象** |
| unclassified | 0 | 分类必须始终为零，否则 reachability 步骤即红 |

### 3.2 库存分域清单（接线单元）

| 域 | 文件 | 就绪度 | 阻塞项 |
| --- | --- | --- | --- |
| `adapters/permission-store` | 4（codec/file-ledger/index/lock） | **已接通（W1）** | 无 |
| `adapters/verification-authority-store` | 4（codec/file-registry/index/lock） | T1→**阻塞** | 构造器强制 writer 持有者，见 §7 W2 |
| `learning/domains + control + profile + pipeline` | 31 | T2 | P05 产品所有者门 |
| `learning/verification-authority` | 6 | T2 | 依赖 W2 |
| `evaluation/` | 7 | T2 | 同上（评估器与 goodhart 防线属学习面） |
| `knowledge/` | 6 | T2 | 同上 |
| `integration/`（content/tool/contract/activation/shared） | 24 | T4 | 依赖学习面与工具链两侧都成型 |
| `tooling/`（acquisition→quarantine→sandbox→validation→catalog→my-tools→…） | 46 | **T3 红线** | 假绿两处未拆（见 §7 W3） |
| `adapters/tool-acquisition` | 13 | T3 红线 | 同上 |
| `surface/protocol` | 7 | P08 | 非 CLI 接线对象 |
| `loop/`（recover/reorder/replay） | 3 | T4 | 会话恢复增强，依赖 P04 收尾决策 |
| 其余单文件（domain/replay、mcp/session、config/layers、credentials/redact、evaluation 壳等） | — | 随所属域 | — |

### 3.3 2026-09-21 W1 执行后实测

| 分类 | 数量 | 说明 |
| --- | --- | --- |
| production_reachable | 325 | 319 + 6（构成见下） |
| library_reachable | 13 | |
| test_support | 19 | |
| approved_deferred | **142** | 145 − 3 |
| unclassified | 0 | |

W1 的变动逐条列出（`git stash` 回退生产改动后重算基线再比对）：

| 变动 | 文件 |
| --- | --- |
| `approved_deferred → production_reachable` | `adapters/permission-store/{codec,file-ledger,lock}.ts` |
| `library_reachable → production_reachable` | `ports/approval-consumption.ts`（`file-ledger.ts` 的端口依赖） |
| 新增 | `surface/cli/permission-ledger-wiring.ts`、`surface/cli/permission-for-run.ts` |
| **不动** | `adapters/permission-store/index.ts`（留在 deferred：barrel 再导出内存 fake，生产可达会触发 lint 红线） |
| **不动** | `adapters/permission-store/memory-fake.ts`（留在 test_support） |

净增 **+6**，其中「本域被接通的零件」是 3 个而不是 4 个——第 4 个（`index.ts`）是
barrel，它的再导出面把内存 fake 拉进生产图，被 `verify.mjs` 的 3-lint-hygiene 明文禁止。
生产因此**深导入 `file-ledger.js`**（见 §7 W1 的 S1 再修正）。

## 4. 接线总原则（六条铁律）

### R1 absent-即关，byte-identical

每根线以**可选注入**的形式存在。开关关闭时不构造任何对象、不读任何文件、不产生任何事件——一次运行的字节流与"从未听说过这个功能"的运行完全一致。仓库内的在案先例：

- `LoopPorts.method` / `toolGap` / `compaction` / `checkpoint`（`loop/runner.ts:41-74`，每项都有"absent means…"的契约注释）；
- `WiringInput.learning` / `userLearning`（`surface/cli/wiring.ts:43-56`："Absent nothing is constructed at all… byte-identical"）；
- `input.subagent?.enabled === true`、`input.mcp === undefined ? … : compose…`（组合根的两种既有开关形态）。

### R2 prove-fail 必须先红后绿

每根线的"关"路径必须有测试证明它真的关着：构造"开关打开才可能出现的副作用"（文件、事件、请求），断言默认配置下**不出现**。红例验证方式沿用 2026-09-20 WP 的做法：回退生产改动后测试必须失败。

### R3 组合级合同测试

adapter 级测试（如 file-ledger 的跨进程并发）证明零件可用；接线后必须新增**至少一条**从 CLI 入口出发的测试（`cmd/trylo` 层，参照 `main.test.ts` 的黑盒进程测试模式）：断言退出码、stdout/stderr 协议流、磁盘副作用——不是断言内部调用。

### R4 reachability 如实重算

每根线完成后运行 `node scripts/quality/reachability.mjs`，diff 必须恰好等于本次接通的文件集，`unclassified` 保持 0。禁止手工改分类。

### R5 假绿红线

**任何含"伪造成功"语义的代码不得接通生产。** 当前在案两处：`tooling/validation/pipeline.ts:157-165`（`independent_verdict` 是前序阶段布尔的取反聚合，无独立证据来源）与 `tooling/builder/admit.ts:22`（硬编码 `passingSandbox()`）。这两处存在于 deferred 域时是受控投机；接通即违反第一优先级纪律。**W3 是工具链接线的唯一门票。**

### R6 一根线一个提交，施工记录随行

每根线独立提交（可复核的小提交），施工记录归档到对应期目录（W1/W2 → P03；W4 → P05；工具链 → P03/P07），记录格式沿用 `2026-09-20-WP` 的"落点/改法/验收（红例）/证据"四段式。

## 5. 接线技术模板（每根线的标准工序 S0–S6）

以 W1 为例给出完整形状，后续各线照抄。

### S0 前置检查

```bash
cd "new trylo cli" && node scripts/quality/verify.mjs        # 必须 ALL PASS
node scripts/quality/reachability.mjs                          # 记录基线数字
```

### S1 确认零件的导出面与合同

读目标域的 `index.ts` 与端口定义，确认：它实现的是**已存在的端口**还是需要新端口。W1/W2 均为前者（`PermissionPort` / 验证权威存储端口——以 `adapters/*/index.ts` 导出面为准，不发明新名字）。**若发现域内 API 与本规格描述不符，以代码为准并回改本规格，不硬套。**

### S2 组合根接线（唯一允许改"接线"的位置）

> **S1 修正（2026-09-21，W1 实测）**：`index.ts` **不能**作为生产导入面。`verify.mjs`
> 的 3-lint-hygiene 有一条成文规则「生产可达文件不得 import fake 模块」
> （`fake-*.js` / `*-fake.js` / `fixtures?.js`），而 barrel 把同目录的内存 fake 一并
> 再导出；走 barrel 会让 `index.ts` 变生产可达、fake 进生产图，lint 直接红。**生产一律
> 深导入具体实现文件**（W1 用 `file-ledger.js`），barrel 留在 deferred。
> 另：`{ root }` 的字段名实测是 `path`——`FilePermissionStoreOptions` 收的是**文件路径**。

```ts
// surface/cli/wiring.ts —— WiringInput 增加可选字段（absent-即关）
export type WiringInput = {
  // …existing…
  /**
   * Durable permission ledger. Absent — every default path — is the
   * in-memory behavior exactly as before: no file is opened, so a run
   * without the switch is byte-identical.
   */
  readonly permissionLedger?: { readonly path: string } | undefined;
};

// wirePorts 内。S1 修正（W1 实测）：构造与就绪读取**都收进独立的组合层模块**
// （`permission-ledger-wiring.ts`，深导入 adapter 的实现文件），wiring.ts 只留一行
// 可选注入——理由是 `wirePorts` 按设计是同步的，而就绪读取是异步的。
const permissionLedger =
  input.permissionLedger === undefined ? undefined : openPermissionLedger(input.permissionLedger);
```

> 实况备注（2026-09-21 核实）：`createMemoryPermissionStore`（`memory-fake.ts`）与
> `createFilePermissionStore`（`file-ledger.ts`）当前**均无生产消费方**——整套权限
> 账本子系统（含 codec 的 grantIssued/Consumed/Revoked 事件与 `resolveGrant`）是
> 建好未接的完整零件。W1 是它第一次接入审批决策点，不是"内存换文件"的替换。

### S3 开关面（CLI flag + settings 层）

> **S1 修正（2026-09-21，W1 实测）**：下面第 2 条（settings 层）**不成立，后续各线照抄时删除它**。
> 两条理由：(a) `ports/settings.ts` 的开篇边界原文「**Configuration cannot expand
> permission.** Nothing here feeds the PermissionGate」，`settings/schema.ts` 的闭集注释把
> 「配置文件偷渡 `autoApprove`」列为它存在的理由——一个能从配置文件打开的授权/验证存储
> 开关正是该形态；(b) 仓库现有全部权限类开关（`--allow-writes` / `--ask` /
> `--allow-tools` / `--deny-tools`）都只走命令行。**权限与验证类存储的开关一律 flag-only。**

- args 层：布尔开关（无值旗，与 `--allow-writes` 同形：出现即开，`=false` 是用法错），
  解析进 `RunScaffold`，参照 `--learning` 的现有解析路径 `args-primitives.ts`；
- ~~settings 层：settings 键 `permission.ledger`（经 `settings-fs.ts` 读入…）~~ ——
  **见上方修正，不执行**；
- 路径由组合层给出（W1：`session-paths.ts::permissionLedgerPath`，家公式的唯一一份），
  存储自身不读任何环境变量；
- 优先级：显式 flag > 默认关闭（无中间层）。

### S4 组合级合同测试（`cmd/trylo` 层，黑盒进程测试）

> **S1 修正（2026-09-21，W1 实测）**：下面第 1 条**在「消费方尚未接线」的存储上不可实现**
> ——它要求存储有真实写入点（跑两进程、第一个授权、第二个重放），而写入点属于消费方
> （W1 是工具链准入门 W6，W2 是 verifier composition）。**没有写入点时第 1 条必须删除，
> 并在施工记录里显式声明「未兑现」**，不得用「构造成功」冒充「重放成功」。第 2、3 条
> 可达成的形态是：
>
> - **关**：磁盘上先放一份**损坏**的存储文件，默认运行必须**仍然成功**——证明「关真的
>   关着」不只是「没有文件」，而是「连已经存在的坏文件都不看」；且运行后不新建目录/文件；
> - **开**：同一份坏文件 + 开关打开 → 非零退出 + store 自己的失败分类码原样上报；
>   以及「开关打开且存储就绪 → 运行与关闭时逐字相同，且不落盘」（就绪读取必须是只读的）。
>
> 这三条构成**双向红例**：回退生产改动 → 开侧红；把接线泄漏进默认路径 → 关侧红。

1. **开**：带开关跑两进程，第一个授权、第二个不再问（grant 重放），断言第二个进程的协议流里没有审批询问事件；——**仅当该存储已有生产写入点时才成立**
2. **关**（prove-fail）：默认配置跑同样的流程，断言审批询问**出现**且无任何 ledger 文件落盘（`existsSync` 为 false）；——无写入点时的等价形态见上方修正
3. **fail-closed**：手工篡改 ledger 文件后带开关启动，断言进程拒绝重放并以非零退出或显式失败码报告（不静默回退到内存——那会把"账本坏了"伪装成"没有账本"）。

### S5 验收

```bash
node scripts/quality/verify.mjs            # 11/11 ALL PASS
node scripts/quality/reachability.mjs      # unclassified=0，且 diff 逐文件可解释
```

> **S1 修正（2026-09-21，W1 实测）**：原文要求「diff 恰好等于本域文件数（W1 为 +4）」。
> 该口径**不可达成且不该强求**：`production_reachable` 的增量还包含 (a) 本线新增的组合层
> 模块、(b) 被深导入连带拉进来的端口文件、(c) 本域里**不该**被接通的 barrel（见 §5 S2 的
> 修正）。正确口径是 **R4 的原话**：diff 必须**逐文件可解释**、`unclassified` 保持 0、
> 禁止手工改分类。W1 的实际增量与逐条解释见 §3.3。

### S6 记录与提交

施工记录四段式（落点/改法/验收红例/证据），归档对应期目录；提交信息格式：`feat(new-cli/wiring): W1 权限账本接线——absent 即关，重启可重放`。

## 6. 接线顺序与依赖图

```
W1 权限账本(4)───┐
                 ├─→ W4 学习面(44, 需产品所有者放行) ─→ W5 integration(24)
W2 验证权威表(4)─┤                                          ↑
                 └─→ W3 工具链拆雷决策(0 代码) ─→ W6 工具生态(59) ─┘
W7 surface/protocol(7)：不在本规格执行范围（P08）
```

排序理由一句话：**先地基（两个存储），再学习（有边界授权可循、有 UE-2 先例），工具链拆完雷再上，integration 等两侧都成型。**

## 7. 分域详细方案

### W1 权限账本持久化（T1，4 文件）——**已执行 2026-09-21**

> **施工记录**：`docs/02-分期工程产出/P03-工具权限与验证/2026-09-21-W1-权限账本接线.md`

- **域**：`adapters/permission-store`（codec.ts / file-ledger.ts / index.ts / lock.ts）。
- **能力**：事件溯源式审批账本——`grantIssuedEvent` / `grantConsumedEvent` / `grantRevokedEvent` 追加写入，`resolveGrant` 重放，跨版本重放 fail-closed，跨进程锁语义已测。
- **S1 修正（原草案推翻）**：原草案要求「装饰 `permissionFor` 返回的权限端口，让每次审批决策先问账本、决策后落 `grantIssuedEvent`」。按 S1「以代码为准」条款推翻，三条锚点：
  1. **域不对**：`permission-store` 实现 `ApprovalConsumptionPort`（action 闭集 `acquire|modify|activate|contribute`，绑定事实 `candidateId/packageVersionId/scope`），管的是**工具包获取授权**；`permissionFor` 返回 `PermissionPort`，管的是**单次工具调用准不准**。硬接要伪造 `candidateId`/`packageVersionId`，正是 S1 禁止的「硬套」。
  2. **语义不对**：账本是单次消费（`replayed`），CLI 审批是 `once|session` 两级，session 级必须可重复使用；记进账本后第二次调用会得到 `replayed` 被拒——是行为变更，不是接线。
  3. **已有成文禁令**：`loop/permission-grants.ts:13` 原文「This is deliberately *not* a ledger and *not* the persisted permission store」。
- **修正后的接线形态（地基先行 + 就绪校验）**：
  1. `surface/cli/permission-ledger-wiring.ts`（新）——唯一 import adapter 的模块：构造账本、只读就绪读取（`getGrant(PROBE)`，零写、零 mkdir）、拒绝报文与退出码；
  2. `surface/cli/wiring.ts::wirePorts`——`WiringInput.permissionLedger` 可选注入，absent 即关；`Wiring.permissionLedger` 仅在开关打开时**字段存在**；
  3. `surface/cli/host.ts`——`wirePorts` 之后、开跑之前做就绪校验，失败即 `TurnFailure`（退出码 52）。
- **开关面（S3 修正：flag-only）**：`--permission-ledger`（无值旗，与 `--allow-writes` 同形）。**刻意不做 settings 键**：`ports/settings.ts` 开篇边界原文「Configuration cannot expand permission. Nothing here feeds the PermissionGate」，而一个能从配置文件打开持久授权账本的键正是 `settings/schema.ts` 闭集要挡的「偷渡 autoApprove」形态；仓库现有全部权限类开关也都只走命令行。
- **行为合同**：
  - 开关开启：账本被构造；开跑前证明它可读；就绪读取**不落盘**；
  - 账本损坏/版本不符/撕裂：fail-closed，分类码（`ledger_corrupt` / `ledger_torn_tail` / `ledger_lock_conflict` / `ledger_write_failed`）原样上报，退出码 52，**不回退内存、不静默当成「没有账本」**；
  - 开关关闭：不构造、不开文件、不建目录、不读一个字节，byte-identical（R1/R2）。
- **测试（R3 组合级）**：`src/cmd/trylo/permission-ledger.test.ts` 5 条黑盒进程测试（关闭+坏账仍退出 0 / 关闭不建目录 / 打开+坏账退出 52 且报分类码 / 打开+就绪仍不落盘 / `--permission-ledger=false` 用法错）+ `wiring.test.ts` 1 条组合根合同。**红例双向已验**：回退生产改动 → 3 红；把接线泄漏进默认路径 → 第 1 条红。
- **未兑现的部分（诚实记录）**：S4 第 1 条「跑两进程，第二个不再问（grant 重放）」**未实现**——它需要账本有真实写入点，而写入点属于工具链准入门（W6）。本波证明的是开关/门控/fail-closed，不是 grant 重放。详见施工记录 §2.1。
- **回滚**：`git revert` 单提交；开关默认关，用户侧无感。

### W2 验证权威注册表持久化（T1，4 文件）——**阻塞，未执行**

> **阻塞取证**：`docs/02-分期工程产出/P03-工具权限与验证/2026-09-21-W1-权限账本接线.md` §5

- **域**：`adapters/verification-authority-store`（codec.ts / file-registry.ts / index.ts / lock.ts）。
- **能力**：验证权威注册表的持久化——`createFileVerificationRegistry`（事件式 registry，含格式版本与锁纪律）。
- **原草案**：`wirePorts` 可选注入，本轮不接消费方，只接通存储构造与开关，使 reachability 转绿、组合级有「开/关」两条测试。
- **S1 修正（原草案前提与代码不符）**：
  1. 原草案称「在案护栏强制『只有组合根与测试可以 import 本目录』」——**实测不成立**。`verification-authority.boundary.test.ts` 的 `WRITER_ALLOWED_PREFIXES` 只有 `src/internal/integration/testing`，其注释写明「组合根**尚未存在**」；`surface/cli/wiring.test.ts` 另有按子串 `verification-authority` 判定的「wiring 模块不得 import 学习包」门。
  2. **决定性阻塞**：`createFileVerificationRegistry` 的 options **强制要求 `clock` 与 `idFactory`**（`file-registry.ts:28-35`），返回 `VerificationAuthorityReader & VerificationAuthorityWriter`。把它接进 CLI 组合根 = 让组合根持有**签发验证收据的能力**，而 `learning/verification-authority/contracts.ts:238` 明文「writer 能力：**只允许 verifier / checker composition 持有**」。本波无任何消费方（草案自己禁止接消费方），即**能力无人使用却先存在**——这不是接线，是先把签发面铺进 CLI。
- **处置**：W2 滑到**存在 verifier/checker composition 的那一波**（W6 的前置件之一，见 W3 ADR §3.3 推荐形态），届时「允许清单扩展 + 消费方接线 + writer 归属」在**同一个可复核的提交**里发生。`adapters/verification-authority-store` 4 文件保持 `approved_deferred`。
- **回滚**：同 W1（本波无代码）。

### W3 工具链拆雷决策文档（0 代码，门票）——**ADR 初稿已出 2026-09-21**

> 产出：`docs/02-分期工程产出/P03-工具权限与验证/2026-09-21-ADR-工具链验证者来源决策.md`（状态：草案，待批准）

该 ADR 回答三件事：

1. **真验证者从哪来**：推荐**方案 A（语义改造 `adapters/sandbox`）作为接线形态、方案 B（独立验证沙箱进程，复用 `adapters/mcp-stdio` 的子进程纪律）作为 A 内部 `run` 的实现**——A 回答「验证者住哪个端口」，B 回答「实现怎么隔离」，不是二选一。评估维度逐项对照（到 `ClassifiedSandbox` 的映射成本、取消/超时分类真实性、许可证与供应链、接线面增量、主要风险）。**待产品所有者裁决**：候选包是否允许同进程执行（威胁模型问题，不是工程口味）。
2. **`FakeValidationSignals` 的 12 布尔判别联合化**：按证据来源分四组
   （`static-scan` / `unit-tests` / `health-probe` / `sandbox-run`），`sandbox-run` 只携带
   一份 `FakeSandboxReport`，从而让 `crashClassifiedUnknown: true` + `classified: "ok"`
   这类矛盾**不可表达**；`independent_verdict` 改为「必须引用独立证据来源」，
   首选形态是引用 Verification Authority 收据（`integration/contract/gateway.ts` 已建好
   且有测试），次选是引用独立执行的摘要。
3. **接线前置清单**：ADR 获批 + 两处假绿修复 + 红例（`passingSandbox` 注入后 pipeline
   必须拒绝；「无独立证据来源的 pass 必须被拒」有合同测试）——三项齐备前 `tooling/` 与
   `adapters/tool-acquisition` 保持 deferred。

### W4 学习面（T2，44 文件，产品所有者放行后执行）

- **域与子域顺序**（依赖从浅到深）：
  1. `learning/domains/shared`（4）→ `dispatch`（1）——域分发与共享解析；
  2. `learning/domains/prompt`（7）/ `skill`（4）/ `workflow`（4）/ `tool`（5）——四个学习域，每个走 UE-2 的"合成槽"模式（`integration/user-learning/port.ts` 的先例：一个注入点、共享预算顶、absent 即关）；
  3. `learning/verification-authority`（6）——依赖 W2；
  4. `learning/profile`（3）+ `pipeline`（1）+ `control/scheduler`（2）——控制板与调度；
  5. `evaluation/`（7，含 goodhart 防线）与 `knowledge/`（6）——评估与知识库。
- **边界（AGENTS.md 原文约束，接线不得越界）**：
  - Learning Loop 只能**提交提案和证据**；Permission Service 仍是唯一权限所有者；
  - 学习不得发起下载/安装/切换工具或对外提交——那必须走显式授权；
  - 核心权限门与一切学习假设隔离：学习永不扩张权限；
  - 双循环 + Learning Control Board + 两个执行接点的边界不得突破。
- **每子域的验收**：除 S0–S6 外，额外一条——**"学习关闭时的请求字节流不变"**（在案先例：`wireMethodLearning` 的 absent 分支已有此保证，新子域照抄）。
- **产品所有者门**：本节整体需要 P05 语义下的放行记录（哪个子域、哪个开关、什么默认值）。没有放行记录，本节一行代码都不动。

### W5 integration 面（T4，24 文件）

`integration/content`（提案/撤回/skill/user-rule 等 8）+ `integration/tool`（7）+ `integration/contract`（4）+ `activation`（2）+ `shared`（2）。这些是学习提案 ↔ 工具链准入之间的合同层：**等 W4 的第一个学习域和 W6 的准入链都各自成型后**按消费方逐个接线，届时本规格增补 W5 分册。提前接线只会造出没有两端的桥。

### W6 工具生态链（T3 红线，59 文件，W3 获批后）

`tooling/` 46 + `adapters/tool-acquisition` 13。接线顺序按数据流：acquisition（下载、allowlist）→ quarantine（隔离区、zip 炸弹/路径逃逸）→ sandbox（真验证执行，W3 产物）→ validation（判别联合信号）→ catalog（production-search、lifecycle）→ my-tools / contribution / events。每一步一个开关、一个合同测试、一个提交。**`admit.ts` 在 W3 修复完成前不得出现在任何接线路径上。**

### W7 surface/protocol（7 文件，P08）

`acp.ts / agui.ts / frames.ts / transport.ts / body.ts / state.ts / admit.ts`——版本化 Trylo Protocol 适配面，目的地是 Desktop 桥。**本规格明确不执行**；P08 启动时以其自身的期文档为准。

## 8. 波次与验收表

| 波 | 内容 | 前置 | 验收（全部满足才进下一波） |
| --- | --- | --- | --- |
| **今晚** | W1 ✅ + W3 ADR 初稿 ✅ + W2 **阻塞**（见 §7 W2） | 门禁 ALL PASS（已满足） | W1：verify 11/11 ALL PASS（59.98s，含并发落地的更严 `3-lint-hygiene`）；reachability 319→325、unclassified=0（**构成见 §3.3，不是「每域 +4」**）；组合级合同测试双向红例验证过（回退生产 → 3 红；泄漏进默认路径 → 1 红）；测试名 1869→1877（本线 6 + 并发 2）；许可证闭包不变（3 packages）。W3：ADR 三项问题全部回答。**W2 未验收** |
| 波 2 | W4 学习面子域 1–2（shared/dispatch + 第一个域） | P05 产品所有者放行记录 | 子域验收 + "学习关闭字节流不变"证明 |
| 波 3 | W4 剩余子域 + evaluation/knowledge | 波 2 复盘 | 同上 |
| 波 4 | W6 工具链（数据流顺序） | W3 ADR 获批 + 假绿修复 + 红例 | 每步一个开关一个合同测试 |
| 波 5 | W5 integration | W4 首域 + W6 准入链成型 | 增补 W5 分册后逐个接线 |
| **并入波 4 之前** | **W2 验证权威注册表**（原属「今晚」） | 存在 verifier / checker composition（writer 的合法持有者） | 允许清单扩展 + 消费方接线 + writer 归属在同一个可复核提交里 |

## 9. 风险登记册

| # | 风险 | 缓解 |
| --- | --- | --- |
| 1 | **兄弟函数漂移**（2026-09-20 修复的 mcp-http 吞错即此类：notify 有兜底 respond 漏了） | 接线只加组合不改域内代码；发现域内不一致时先修再接；共享词汇收进单一模块 |
| 2 | 接线膨胀：一根线顺手多接"相关"文件 | R6 一线一提交；review 时检查 diff 是否只含该域文件 + 组合根 + 测试 |
| 3 | 库存持有成本：剩余 deferred 越少越健康，长期滞留则 rot | 每波结束跑 reachability，把"剩余库存清单"写进施工记录；连续两波无进展要触发 triage 复议 |
| 4 | 学习面越界（权限扩张/工具自安装） | W4 的产品所有者门 + 每子域"学习关闭字节流不变"证明 + 既有合同测试（`grant replay across versions is fail-closed` 等）保持全绿 |
| 5 | 假绿随接线复活 | W3 红例（passingSandbox 注入后必拒）是永久回归测试；`independent_verdict` 修复后加"无独立证据来源的 pass 必须被拒"的合同测试 |
| 6 | Bus factor = 1 | 本规格本身即交接文档：每波施工记录 + reachability 台账，使第二个人（或 agent）可以从波次表任意一行接手 |

## 10. 回滚总策略

- 单线回滚：`git revert <该线提交>`（每线独立提交保证原子性）；
- 用户侧回滚：所有开关默认关闭——回滚后用户行为无感；
- 数据侧回滚：W1/W2 均为 append-only 带校验存储，账本文件可直接删除（等同"忘记全部授权"），删除本身是合法操作不需要迁移。

## 附录 A：本规格引用的实测锚点

### A.1 开工基线（2026-09-20）

- 门禁基线：11/11 ALL PASS（2026-09-20 终态，含施工记录后复跑，41.40s）；
- 测试基线：1869 test names 全过（含 2026-09-20 新增 10 个合同测试）；
- reachability：319 / 14 / 19 / **145** / 0（`dist/reachability.json`，2026-09-20 重算）；
- 假绿坐标：`tooling/validation/pipeline.ts:157-165`、`tooling/builder/admit.ts:22`、`tooling/sandbox/fake-executor.ts`（`passingSandbox`）；
- 组合根现状：`surface/cli/wiring.ts::wirePorts`（可选注入模式在案）、`run-command.ts::permissionFor`（四个权限分支，2026-09-21 外移到 `permission-for-run.ts`）、`integration/user-learning/port.ts`（UE-2 合成槽先例）。

### A.2 W1 落点后（2026-09-21）

- 门禁：11/11 ALL PASS（59.98s，含并发写入方新增的更严 `3-lint-hygiene`），测试名
  **1877**（1869 + 本线 6 + 并发写入方 2）；
- reachability：**325 / 13 / 19 / 142 / 0**，逐文件构成见 §3.3；
- 施工记录：`docs/02-分期工程产出/P03-工具权限与验证/2026-09-21-W1-权限账本接线.md`；
- W3 ADR：`docs/02-分期工程产出/P03-工具权限与验证/2026-09-21-ADR-工具链验证者来源决策.md`。
