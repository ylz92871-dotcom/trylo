// Read-only constraint detection cases for the Work step contract.
//
// Real failure being fixed: the user asked (in Chinese) to read a PPT and
// discuss revision ideas WITHOUT modifying anything, and the run failed with
// "mutation-required contract unmet ... contractReason:
// step_requires_artifact_mutation". detectReadOnlyConstraint() only matched
// English phrasings, so the Chinese constraint was invisible and the step was
// held to a strict "must mutate files" contract.

/** Mirror of the ORIGINAL English-only implementation. */
const LEGACY_EXPLICIT =
  /\b(?:do\s+not\s+(?:edit|create|modify|write)\s+(?:any\s+)?files?|do\s+not\s+make\s+(?:any\s+)?changes|no\s+file\s+changes|without\s+(?:editing|modifying|creating)|don'?t\s+(?:edit|create|modify|write)\s+(?:any\s+)?files?|situational\s+awareness\s+(?:only|mode))\b/;

function legacyDetect(prompt) {
  const lower = String(prompt || '').toLowerCase();
  if (!lower.trim()) return false;
  if (LEGACY_EXPLICIT.test(lower)) return true;
  if (/\bread[- ]only\b/.test(lower)) return true;
  return false;
}

export const CASES = [
  // English controls — must stay true (no regression).
  { text: 'review the deck, do not edit files', expect: true, note: 'EN explicit' },
  { text: 'analyze this presentation without modifying anything', expect: true, note: 'EN without' },
  { text: 'no file changes please, just summarize', expect: true, note: 'EN no changes' },
  // Chinese cases — the actual bug.
  { text: '你帮我读一下变色小魔术最新的那个PPT，给一点修改建议，不是让你修改，先和我交流', expect: true, note: 'ZH 用户原话' },
  { text: '请分析这份PPT，不要修改文件', expect: true, note: 'ZH 不要修改文件' },
  { text: '只读分析这个PPT，不要改动', expect: true, note: 'ZH 只读' },
  { text: '读一下PPT，先和我交流，先不要改', expect: true, note: 'ZH 先不要改' },
  { text: '帮我看看这份教案，给点建议就行，不用改', expect: true, note: 'ZH 不用改' },
  { text: '不要生成文件，直接告诉我结论', expect: true, note: 'ZH 不要生成文件' },
  // Negative controls — must NOT be treated as read-only.
  { text: '帮我修改这份PPT并保存到 .trylo/out/', expect: false, note: 'ZH 明确要改' },
  { text: 'create a new spreadsheet from this data', expect: false, note: 'EN 明确产出' },
  { text: '把这个教案重写一遍', expect: false, note: 'ZH 重写' },
];

export function evaluate(detectFn) {
  const rows = [];
  for (const c of CASES) {
    const actual = detectFn(c.text);
    rows.push({ ...c, actual, pass: actual === c.expect });
  }
  return rows;
}

export { legacyDetect };

// ─────────────────────────────────────────────────────────────────────────────
// Candidate Chinese-aware implementation. Deliberately built and validated here
// FIRST, then transplanted into detectReadOnlyConstraint() in
// vendor/cowork-os/src/electron/agent/executor-completion-utils.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chinese equivalents of the English constraint vocabulary.
 *
 * Ordering matters: every pattern is anchored on a NEGATION or an explicit
 * read-only declaration, never on the bare verb. That is what keeps genuine
 * write requests ("帮我修改这份PPT并保存", "把这个教案重写一遍") out — they
 * contain no negator, so they do not match.
 */
const ZH_CONSTRAINT_PATTERNS = [
  // 1. Negated mutation: 不要/别/不用/不必/无需/请勿/不是让你 + 修改|改动|编辑|写|创建|生成|保存|新增|删除|动|碰
  /(?:不要|别|不许|不准|不用|不需要|不必|无需|勿|请勿|不得|不是(?:让|要|叫)?你?)\s*(?:去)?(?:修改|改动|更改|编辑|改写|重写|写入|写|创建|生成|保存|输出|导出|新增|添加|删除|动|碰)(?:\s*(?:任何|这些|这个|那个|这份|我的)?(?:文件|文档|内容|东西|资料|表格|报告|ppt|pptx))?/,
  // 2. Explicit read-only / analysis-only declaration
  /(?:只读|只读取|仅读取|只分析|仅分析|只是分析|只查看|仅查看|只看|仅看|只做分析|仅供分析)/,
  // 3. "no file output" phrasing
  /(?:不要|不用|无需|不需|别)\s*(?:生成|创建|保存|输出|导出|写)\s*(?:任何)?(?:文件|文档|表格|报告|ppt|pptx)?/,
  // 4. Advice / discussion intent: 给建议 + 不改 (the negation is required, so
  //    "修改并给建议" still counts as a mutation request)
  /(?:给|提|提供|给出)[一点一些]*(?:修改|改进|优化)?(?:建议|意见|想法|思路)[^。！？\n]{0,12}(?:不要|不用|不是|别|先不改|无需)/,
  // 5. "先和我交流/先聊聊" — discussion-first, defer mutation
  /(?:先|只)(?:和我|跟我|与我|跟我们)?\s*(?:交流|讨论|聊聊|沟通|谈谈|说说|谈一下)/,
];

function newDetect(prompt) {
  const lower = String(prompt || '').toLowerCase();
  if (!lower.trim()) return false;
  if (LEGACY_EXPLICIT.test(lower)) return true;
  if (/\bread[- ]only\b/.test(lower)) return true;
  for (const re of ZH_CONSTRAINT_PATTERNS) {
    if (re.test(lower)) return true;
  }
  return false;
}

export { newDetect };

// Standalone: show the legacy behaviour (expected: all ZH cases fail).
if (process.argv[1] && process.argv[1].endsWith('readonly-contract-cases.mjs')) {
  // --dist: verify against the ACTUAL compiled daemon module, not the copy in
  // this file. This is what proves the fix reached the shipped runtime.
  if (process.argv.includes('--dist')) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const mod = require('../vendor/cowork-os/dist/daemon/electron/agent/executor-completion-utils.js');
    const detect = mod.detectReadOnlyConstraint;
    if (typeof detect !== 'function') {
      process.stdout.write('FAIL: detectReadOnlyConstraint not exported from dist\n');
      process.exit(1);
    }
    const rows = evaluate(detect);
    let failed = 0;
    for (const r of rows) {
      if (!r.pass) failed += 1;
      process.stdout.write(
        `${r.pass ? 'PASS' : 'FAIL'}  expect=${String(r.expect).padEnd(5)} actual=${String(r.actual).padEnd(5)}  ${r.note}\n`,
      );
    }
    process.stdout.write(`\nDIST: ${rows.length - failed}/${rows.length} pass, ${failed} fail\n`);

    // Contract level — this is the failure the user actually hit. A step that
    // would otherwise DEMAND a file mutation must be downgraded once a
    // read-only constraint is recognised.
    const { deriveStepContractMode } = require('../vendor/cowork-os/dist/daemon/electron/agent/step-contract.js');
    const base = {
      description: 'Read 变色小魔术 PPT and suggest revisions',
      requiresMutation: true,
      requiresArtifactEvidence: true,
      requiresWriteByArtifactMode: true,
    };
    const downgraded = deriveStepContractMode({ ...base, hasReadOnlyConstraint: true });
    const strict = deriveStepContractMode({ ...base, hasReadOnlyConstraint: false });
    process.stdout.write(
      `\ncontract WITH read-only    : ${downgraded.mode} / ${downgraded.enforcementLevel} (${downgraded.contractReason})\n` +
        `contract WITHOUT read-only : ${strict.mode} / ${strict.enforcementLevel} (${strict.contractReason})\n`,
    );
    const contractOk =
      downgraded.mode === 'analysis_only' && strict.mode === 'mutation_required';
    if (!contractOk) {
      process.stdout.write('\nFAIL: read-only constraint did not downgrade the contract\n');
      process.exit(1);
    }
    process.stdout.write('\nCONTRACT: read-only downgrade verified\n');
    process.exit(failed === 0 ? 0 : 1);
  }

  const before = evaluate(legacyDetect);
  const after = evaluate(newDetect);
  let failed = 0;
  process.stdout.write('                                      before → after\n');
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    if (!a.pass) failed += 1;
    process.stdout.write(
      `${a.pass ? 'PASS' : 'FAIL'}  expect=${String(a.expect).padEnd(5)} ` +
        `${b.pass ? 'ok' : 'FAIL'} → ${String(a.actual).padEnd(5)}  ${a.note}\n`,
    );
  }
  const beforeFail = before.filter((r) => !r.pass).length;
  const afterFail = after.filter((r) => !r.pass).length;
  process.stdout.write(`\nbefore: ${before.length - beforeFail}/${before.length} pass (${beforeFail} fail)\n`);
  process.stdout.write(`after : ${after.length - afterFail}/${after.length} pass (${afterFail} fail)\n`);
}
