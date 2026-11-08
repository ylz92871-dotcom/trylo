import { CENTRAL_LEARNING_AGENT_DOMAINS, type CentralLearningAgentDomain } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_AGENT_CAPABILITY_ROLE, CENTRAL_AGENT_CAPABILITY_PREFIX } from "../../learning/central/runtime/material-role.js";
import type { CentralLearningExecutionPort } from "./contracts.js";

// Describe the native receivers, not a promise of task success or an instruction to dispatch.
const descriptions: Readonly<Record<CentralLearningAgentDomain, { readonly research: string; readonly candidate: string; readonly adoption: string }>> = {
  prompt: { research: "研究可复用的方法提示与适用条件。method_research_request 仅证明请求已保存，不证明模型已执行、形成方法卡或向 PA 发布。method_research_prompt_or_budget_boundary 是尚未开始模型调用的容量边界；须改变实际额度或上下文才能继续，不会自行产生在途产物。", candidate: "公开 finding，或方法卡与 scope 谓词候选。",
    adoption: "沿原方法发布；研究来源初期须由真实任务给匹配特征并显式 trial，发布不等于成熟或采用。" },
  tool: { research: "研究能力缺口，选择工具复用、构造、改进或获取。", candidate: "工具候选包、复用细化决策或契约修订提案。",
    adoption: "验证、审批、执行、激活和采用仍走原工具流程。" },
  skill: { research: "把有来源的中央研究目的交给原生技能学习。", candidate: "可复用技能的原生待审提案。",
    adoption: "应用仍须原用户审批，提案不证明采用或收益。" },
  workflow: { research: "研究流程改进、假设检查、步骤、失败处理与停止规则。", candidate: "原生流程候选。",
    adoption: "发布和任务采用仍受原版本谱系与适用性检查约束。" },
  collaboration: { research: "研究分工、交接与依赖。", candidate: "协作计划或经验候选。",
    adoption: "发布进入原隔离评估链；激活、执行和实际采用须另有原生许可与收据。" },
};

/** The assembled acceptResearch ports are the availability authority. This
 * control description supplies no observation, citation, native issue or wake. */
export function centralAgentResearchCapabilities(ports: readonly Pick<CentralLearningExecutionPort, "domain" | "acceptResearch">[]): CentralRuntimeMaterial {
  const available = new Set(ports.filter(port => typeof port.acceptResearch === "function").map(port => port.domain));
  const text = canonicalJson({ schemaVersion: 1, role: CENTRAL_AGENT_CAPABILITY_ROLE,
    interpretation: "当前已装配的 Agent 研究接收者。中央自主选择是否、何时及向谁投入；没有固定阶段，不要求派工或产出资产。此目录不是业务证据或支持来源。运行回执用于组织学习、判断真实阻塞和调整投入，不应逐条自动转成业务研究发现。host 环境的 advisorySourceContractVersion 变化表示实际来源校验能力变更；authenticated-native-control-transports-v3 已补齐原生控制记录、分页和技能任务别名的来源关联，可重新考虑此前的 source_access_denied；历史组织控制认证仍受支持。旧拒绝仍是历史事实，新选择仍按完整原文、当前目的与原权限检查；真实业务原件无法访问时仍拒绝发布，能力变更不保证成功。",
    input: "接受有原文引用支撑的中央 purpose/goal、knowledge、conditions、残余问题和操作；原 owner 校核真实材料与原额度，可返回等待。无需已有 native issue，接收者沿原来源创建或绑定工单。",
    context: "中央 purpose knowledge 用于中央延续、归档召回和原生研究交接；保存或 knowledgeEdits 不会自动进入普通 PA 任务上下文。完整知识与条件随研究请求或 centralSourceContext 交付给研究接收者，不要求各域同名字段。central-known 检索原生内容；归档 purpose 沿原目的目录与原文读取，两者不同。host 的 native-feedback-notice-read-choices-v6 将原生反馈变化通知的地址列为相邻 typed read 选项。通知不是反馈正文；正文可由中央自主选择读取，未读不表示正文不可用或必须由外部先读取。是否读取、如何解释及是否继续投入仍由中央判断。",
    capabilities: CENTRAL_LEARNING_AGENT_DOMAINS.filter(domain => available.has(domain))
      .map(domain => ({ domain, ...descriptions[domain] })),
    boundary: "可按学习价值自主选择已装配研究接收者；dispatch 走原生研究交接，不保证产出资产。普通 PA 按原内容引用或所属域合同接收原生公开 ContentRecord、方法内容或有效版本，适用的发布、试用、审批与采用约束仍保留。中央条件知识可沿显式 handoff 发布；发布来源核对支持已认证的历史原始组织决策控制，历史控制不必重复成为当前投递正文，但须与原账本前缀及完整原文一致。旧的来源未确认拒绝不等于之后新发布选择永远不可用，新选择仍须原完整来源和权限检查。保留知识或结束投资不要求派工或发布，不增加权限或资金，也不证明收益。" });

  return { ref: `${CENTRAL_AGENT_CAPABILITY_PREFIX}${contentHashOf(text)}`, kind: "source", text, sourceRefs: [] };
}
