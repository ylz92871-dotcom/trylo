import type { MemoryFactKind } from "../../learning/domains/user/memory-fact.js";

/** Normalization is only for verbatim grounding, never for inventing a claim. */
export function comparableMemoryText(text: string): string {
  return text.replace(/[\s，。、；：！？“”‘’《》（）()\-—…·,.;:!?"'`]/gu, "");
}

const CONFIRMATIONS: ReadonlySet<string> = new Set([
  "可以", "好", "好的", "行", "嗯", "对", "是的", "ok", "yes",
  "记住", "记住吧", "那就记住", "记住也行", "也行", "都行", "可以记住",
  "可以记住也行", "可以记住也行记不住也行", "记住也行记不住也行",
]);

export function isMemoryConfirmation(text: string): boolean {
  return CONFIRMATIONS.has(comparableMemoryText(text).toLowerCase());
}

export function explicitRememberRequest(text: string): boolean {
  if (!allowsDurableMemorySource(text)) return false;
  const instruction = memoryInstructionText(text);
  if (/(?:不要|别|不许|无需|不用|不需要|不想).{0,6}(?:记住|记下|保存)|\b(?:do not|don't|never)\s+(?:remember|save)/iu.test(instruction)) return false;
  return /记住|记一下|记下来|别忘了|帮我记|记着|\bremember\b|\bsave this\b/iu.test(instruction);
}

/** Literal intervals can provide data, but cannot provide the authorizing instruction. */
export function memoryInstructionText(text: string): string {
  const withoutCode = maskMemoryCode(maskMemoryLineLiterals(text));
  const quoteEnds: Readonly<Record<string, string>> = { "“": "”", "‘": "’", "「": "」", '"': '"', "'": "'" };
  const closers: string[] = [];
  let instruction = "", escaped = false;

  for (const character of withoutCode) {
    const current = closers.at(-1);
    if (current !== undefined) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if ((current === '"' || current === "'") && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === current) closers.pop();
      else if (current !== '"' && current !== "'" && quoteEnds[character] !== undefined) closers.push(quoteEnds[character]);
      continue;
    }

    const closer = quoteEnds[character];
    if (closer === undefined) instruction += character;
    else {
      closers.push(closer);
      instruction += " ";
    }
  }

  return instruction;
}

/** Conservative block lines: quoted/indented content may continue until a blank line. */
function maskMemoryLineLiterals(text: string): string {
  let literalBlock = false;
  return text.split("\n").map(line => {
    if (line.trim().length === 0) {
      literalBlock = false;
      return "";
    }
    if (/^(?: {0,3}(?:>|\t)| {4})/u.test(line)) literalBlock = true;
    return literalBlock ? "" : line;
  }).join("\n");
}

function runEnd(text: string, start: number): number {
  let end = start + 1;
  while (text[end] === text[start]) end += 1;
  return end;
}

/** Inline backticks close at equal run length; line fences close at equal or greater length. */
function codeLiteralEnd(text: string, start: number, openingEnd: number, fenced: boolean): number {
  const length = openingEnd - start;
  let cursor = fenced ? text.indexOf("\n", openingEnd) + 1 : openingEnd;
  if (fenced && cursor === 0) return text.length;

  while (cursor < text.length) {
    if (fenced) {
      const newline = text.indexOf("\n", cursor);
      const end = newline === -1 ? text.length : newline + 1;
      const closing = /^ {0,3}(`+|~+)[\t \r\n]*$/u.exec(text.slice(cursor, end));
      if (closing !== null && closing[1]![0] === text[start] && closing[1]!.length >= length) return end;
      cursor = end;
    } else {
      const next = text.indexOf("`", cursor);
      if (next === -1) return text.length;
      const end = runEnd(text, next);
      if (end - next === length) return end;
      cursor = end;
    }
  }

  // An unclosed literal has no trustworthy instruction boundary after its opener.
  return text.length;
}

/** Finite Markdown literal subset, not a renderer: 0–3-space fences and arbitrary backtick runs. */
function maskMemoryCode(text: string): string {
  let instruction = "", cursor = 0;

  while (cursor < text.length) {
    if (cursor === 0 || text[cursor - 1] === "\n") {
      const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(text.slice(cursor));
      if (fence !== null) {
        const start = cursor + fence[0].length - fence[1]!.length;
        cursor = codeLiteralEnd(text, start, start + fence[1]!.length, true);
        instruction += "\n";
        continue;
      }
    }
    if (text[cursor] === "`") {
      cursor = codeLiteralEnd(text, cursor, runEnd(text, cursor), false);
      instruction += " ";
    } else {
      instruction += text[cursor];
      cursor += 1;
    }
  }

  return instruction;
}

function memoryNegations(text: string): ReadonlyArray<number> {
  return [...text.matchAll(/不要|不许|禁止|无需|不用|不需要|不想让|不是让|别(?=保存|记住|修改|更正|改正|撤回|忘掉|忘记|持久|长期)|\b(?:do not|don't|never|must not|should not|no need to)\b/giu)]
    .map(match => match.index);
}

/** Persistence eligibility belongs here; unlike local grammar, mixed work and quotations are not blanket denials. */
export function allowsDurableMemorySource(text: string): boolean {
  if (/临时|暂时|暂用|(?:仅|只).{0,6}(?:本次|这次|本轮|这轮|这回|一次)|(?:本次|这次|本轮).{0,4}有效|示例|举例|例如|假设|\b(?:only(?: for)? (?:this|the current) (?:turn|session|conversation)|temporarily|for this turn only|this session only|for now|for the moment|as an example|hypothetically)\b/iu.test(text)) return false;
  return memoryNegations(text).every(offset => !/保存|记住|记忆|(?:修改|更正|改正|撤回|删除).{0,12}(?:身份|记忆|记录)|忘掉|忘记|遗忘|正式记录|持久|长期|\b(?:save|remember|memory|identity|record|forget|retract|persist)\b/iu.test(text.slice(offset)));
}

/** Explicit chat authority is separate from grounding a name and from tool permission. */
export function hasMemoryMutationIntent(text: string, action: "correct" | "retract"): boolean {
  if (!allowsDurableMemorySource(text)) return false;

  const instruction = memoryInstructionText(text);
  if (action === "correct" && /^我(?:叫|是)[^。\n]+[，,]请(?:更正|改正|纠正)[。.!！]?$/u.test(instruction)) return true;

  // Changing a document is not consent to change a memory. Each pattern binds
  // the verb to a memory object, the new identity clause, or an explicit referent.
  const patterns = action === "correct" ? [
    /^(?:更正|改正|纠正)(?:为|成|[：:]\s*我(?:叫|是))/u,
    /^(?:更正|改正|纠正|修改|更新)(?:一下|下)?(?:我的|我那条|这条|那条)?(?:身份|记忆)/u,
    /^(?:更正|改正|纠正|修改|更新)(?:这条|那条|我的)记录/u,
    /^把(?:我(?:的|原来那条|之前那条|那条)?|这条|那条)?(?:身份|记忆|记录).{0,12}(?:更正|改正|纠正|修改|更新)/u,
    /^(?:please\s+)?(?:correct|update|revise|change)\s+(?:(?:my|this|that|the)\s+)?(?:memory|identity|record)\b/iu,
  ] : [
    /^(?:撤回|忘掉|忘记|删除)(?:并撤回)?(?:我那条|我的|这条|那条)?(?:测试开发者)?(?:记忆|身份|记录)/u,
    /^(?:请)?(?:撤回|忘掉|忘记)[。.!！]?$/u,
    /^(?:please\s+)?(?:forget|retract|delete)\s+(?:(?:my|this|that|the)\s+)?(?:memory|identity|record|fact|name)\b/iu,
  ];

  return instruction.split(/[，,。；;\n]/u).some(part => {
    const clause = part.trim().replace(/^(?:(?:请|帮我|麻烦你|现在|然后|接着|随后|先|再)\s*)+/u, "");
    return !/[？?]|怎么|如何|是否|要不要|能否|吗\s*$/u.test(clause) && patterns.some(pattern => pattern.test(clause));
  });
}

export function confirmsExplicitMemory(text: string, previous: string): boolean {
  return isMemoryConfirmation(text) && (explicitRememberRequest(text) || explicitRememberRequest(previous));
}

export type LocalMemoryClaim = {
  readonly subject: string;
  readonly statement: string;
  readonly factKind: MemoryFactKind;
  readonly scopeKind: "user";
};

/** A deliberately small command grammar. Mixed tasks and quoted examples stay with the model. */
export function localMemoryClaim(text: string, previous?: string): LocalMemoryClaim | undefined {
  if (!isStandaloneClaimSource(text)) return undefined;

  let statement: string | undefined;

  if (isMemoryConfirmation(text)) {
    // A generic OK can answer any question. Without a bound memory proposal,
    // only an explicit remember request establishes persistence consent.
    if (!confirmsExplicitMemory(text, previous ?? "")) return undefined;
    if (previous === undefined || !isStandaloneClaimSource(previous)) return undefined;
    statement = previous;
  }
  else if (explicitRememberRequest(text)) {
    statement = /^(?:请|帮我)?(?:记住|记一下|记下来|记着)[：:，,\s]*(.+)$/u.exec(text)?.[1]
      ?? /^(.+?)[，,。；;\s]*(?:请|帮我)?(?:记住|记一下|记下来|记着)(?:吧)?[。.!！]*$/u.exec(text)?.[1]
      ?? /^(?:please\s+)?remember\s*[:：,]?\s*(.+)$/iu.exec(text)?.[1];
  }

  if (statement === undefined) return undefined;

  statement = statement.trim().replace(/[，,。；;\s]+$/u, "");
  const identity = /^我(?:是|叫|的名字是)\s*([^，。,.！？!?；;\n]{1,40})/u.exec(statement)
    ?? /^my name is\s+([^,.!?\n]{1,40})/iu.exec(statement);
  if (identity !== null) return { subject: identity[1]!.trim(), statement, factKind: "identity_fact", scopeKind: "user" };

  if (/^我(?:喜欢|希望|习惯|偏好|更愿意|不喜欢|讨厌)/u.test(statement)) {
    return { subject: "用户", statement, factKind: "preference", scopeKind: "user" };
  }

  return undefined;
}

/** Shared eligibility for the bounded local interpreter, not a replacement for consent/grounding. */
export function isStandaloneClaimSource(text: string): boolean {
  return text.length <= 1_024
    && allowsDurableMemorySource(text)
    && !/[`\r\n“”‘’"'「」]|MEMORY\.md|然后|顺便|另外|并且|同时|文件|代码|网页|示例|举例|例如|假设/iu.test(text)
    && !/[，,；;](?:请|帮我|再|并)?(?:修改|修复|重构|运行|执行|创建|生成|删除|新增|计算|安装|部署)/u.test(text)
    && memoryNegations(text).length === 0;
}
