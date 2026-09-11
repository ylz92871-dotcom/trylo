// Trylo Desktop — OfficeCLI risk classifier tests.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.3 / §6.4 / §14.2.
// Data-driven: every command of the pinned enum × every permission level ×
// the path-attack catalogue, plus batch recursion and the redaction rules.
//
// The headline acceptance (spec §13 PR-2):
//   read_only 无法 create/set/remove/raw；
//   workspace_write 只能自动写 .trylo/out；
//   原件、remove、raw 必须审批。

import { describe, expect, it } from 'vitest';

import {
  classifyOfficecli,
  analyzeOfficecliInput,
  buildOfficecliApprovalPreview,
  OFFICECLI_COMMANDS,
  OFFICECLI_TOOL_NAME,
} from './officecli-classifier';
import type { ToolRiskContext } from '../tool-risk-classifier';
import type { PermissionLevel } from '../../permission/permission-policy';

const ROOT = 'D:/work/proj';
const ALL_LEVELS: readonly PermissionLevel[] = [
  'read_only',
  'ask',
  'workspace_write',
  'unrestricted',
];

function ctx(
  input: Record<string, unknown>,
  level: PermissionLevel = 'workspace_write',
): ToolRiskContext {
  return {
    profileId: 'work.core.v1',
    packageId: 'officecli',
    toolName: OFFICECLI_TOOL_NAME,
    input,
    permissionLevel: level,
    projectRoot: ROOT,
    conversationId: 'conv-1',
    at: 1_700_000_000_000,
  };
}

describe('command table (§6.4)', () => {
  it('covers exactly the pinned command enum', () => {
    expect([...OFFICECLI_COMMANDS].sort()).toEqual(
      [
        'add',
        'batch',
        'create',
        'get',
        'help',
        'layout',
        'merge',
        'move',
        'query',
        'raw',
        'remove',
        'set',
        'validate',
        'view',
      ].sort(),
    );
  });

  it('unknown commands are denied at every level (never a guess)', () => {
    for (const level of ALL_LEVELS) {
      const decision = classifyOfficecli(ctx({ command: 'format-c-drive' }, level));
      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') {
        expect(decision.reasonCode).toBe('unknown_command');
      }
    }
  });

  it('a missing or non-string command fails closed (§6.2 解析失败不能自动放行)', () => {
    expect(classifyOfficecli(ctx({})).behavior).toBe('deny');
    expect(classifyOfficecli(ctx({ command: 42 })).behavior).toBe('deny');
    expect(classifyOfficecli(ctx({ command: '' })).behavior).toBe('deny');
    expect(
      classifyOfficecli(ctx('not an object' as unknown as Record<string, unknown>)).behavior,
    ).toBe('deny');
    expect(classifyOfficecli(ctx({ command: ['view'] })).behavior).toBe('deny');
  });
});

describe('read commands auto-allow at every level (§6.3 读取=自动)', () => {
  for (const command of ['view', 'get', 'query', 'validate', 'help']) {
    it(`${command} inside the workspace is automatic`, () => {
      for (const level of ALL_LEVELS) {
        const decision = classifyOfficecli(ctx({ command, file: 'docs/report.docx' }, level));
        expect(decision.behavior).toBe('auto_allow');
        if (decision.behavior === 'auto_allow') {
          expect(decision.risk).toBe('read');
          expect(decision.reasonCode).toBe('workspace_read');
        }
      }
    });
  }

  it('reads without any path field are automatic (e.g. help)', () => {
    const decision = classifyOfficecli(ctx({ command: 'help' }, 'read_only'));
    expect(decision.behavior).toBe('auto_allow');
  });

  it('an absolute path INSIDE the workspace is still a workspace read', () => {
    const decision = classifyOfficecli(
      ctx({ command: 'view', file: 'D:/work/proj/docs/a.docx' }, 'read_only'),
    );
    expect(decision.behavior).toBe('auto_allow');
    // Case-insensitive containment on a Windows drive root.
    const upper = classifyOfficecli(
      ctx({ command: 'view', file: 'D:/WORK/Proj/docs/a.docx' }, 'read_only'),
    );
    expect(upper.behavior).toBe('auto_allow');
  });
});

describe('path defences (§6.4 禁止 ..、绝对路径逃逸、UNC/设备路径)', () => {
  const attacks: readonly { readonly name: string; readonly input: Record<string, unknown> }[] = [
    { name: 'dotdot escape', input: { command: 'view', file: '../secret.docx' } },
    // `..` is forbidden OUTRIGHT, even when it stays inside the root.
    { name: 'dotdot inside', input: { command: 'view', file: 'docs/../docs/a.docx' } },
    { name: 'absolute outside', input: { command: 'view', file: 'C:/Users/me/secret.docx' } },
    { name: 'posix absolute', input: { command: 'view', file: '/etc/passwd' } },
    { name: 'unc path', input: { command: 'view', file: '\\\\server\\share\\a.docx' } },
    { name: 'device namespace', input: { command: 'view', file: '\\\\.\\pipe\\x' } },
    { name: 'drive-relative', input: { command: 'view', file: 'D:file.docx' } },
    { name: 'reserved device name', input: { command: 'view', file: 'CON.docx' } },
    { name: 'reserved device name mid-path', input: { command: 'view', file: 'docs/CON.docx' } },
    { name: 'control characters', input: { command: 'view', file: 'docs/\u0000a.docx' } },
    { name: 'non-string path', input: { command: 'view', file: 42 } },
  ];

  for (const attack of attacks) {
    it(`denies ${attack.name} at every level — reads included`, () => {
      for (const level of ALL_LEVELS) {
        const decision = classifyOfficecli(ctx(attack.input, level));
        expect(decision.behavior).toBe('deny');
      }
    });
  }

  it('carries a distinct reasonCode per attack class', () => {
    const codes = attacks.map((a) => {
      const decision = classifyOfficecli(ctx(a.input));
      return decision.behavior === 'deny' ? decision.reasonCode : '';
    });
    expect(codes).toEqual([
      'dotdot_segment',
      'dotdot_segment',
      'path_outside_workspace',
      'path_outside_workspace',
      'unc_path',
      'device_path',
      'drive_relative_path',
      'reserved_device_name',
      'reserved_device_name',
      'invalid_path',
      'malformed_path_field',
    ]);
  });

  it('the same defences apply to the output and path fields', () => {
    for (const field of ['output', 'path'] as const) {
      const decision = classifyOfficecli(ctx({ command: 'create', [field]: '../evil.docx' }));
      expect(decision.behavior).toBe('deny');
    }
  });

  it('a SIBLING directory sharing the root prefix is outside (startsWith trap)', () => {
    // "D:/work/proj2" must NOT pass a naive "startsWith(root)" containment
    // check against root "D:/work/proj" (OWASP path-traversal C2).
    const decision = classifyOfficecli(ctx({ command: 'view', file: 'D:/work/proj2/a.docx' }, 'read_only'));
    expect(decision.behavior).toBe('deny');
    if (decision.behavior === 'deny') expect(decision.reasonCode).toBe('path_outside_workspace');
  });

  it('a bare "." reference resolves to nothing usable and fails closed', () => {
    expect(classifyOfficecli(ctx({ command: 'view', file: '.' })).behavior).toBe('deny');
    expect(classifyOfficecli(ctx({ command: 'view', file: './' })).behavior).toBe('deny');
  });
});

describe('workspace-write matrix (§6.4 create/set/add/move/merge)', () => {
  it('read_only cannot create/set/add/move/merge at all (PR-2 验收)', () => {
    for (const command of ['create', 'set', 'add', 'move', 'merge']) {
      const toOut = classifyOfficecli(
        ctx({ command, output: '.trylo/out/report.docx' }, 'read_only'),
      );
      expect(toOut.behavior).toBe('deny');
      if (toOut.behavior === 'deny') expect(toOut.reasonCode).toBe('write_denied_read_only');

      const toOriginal = classifyOfficecli(
        ctx({ command, file: 'docs/report.docx' }, 'read_only'),
      );
      expect(toOriginal.behavior).toBe('deny');
    }
  });

  it('workspace_write auto-allows ONLY the .trylo/out zone (PR-2 验收)', () => {
    const decision = classifyOfficecli(
      ctx({ command: 'create', output: '.trylo/out/report.docx' }, 'workspace_write'),
    );
    expect(decision.behavior).toBe('auto_allow');
    if (decision.behavior === 'auto_allow') {
      expect(decision.risk).toBe('workspace-write');
      expect(decision.reasonCode).toBe('write_to_out');
    }
  });

  it('ask level still approves an .trylo/out write (§6.3)', () => {
    const decision = classifyOfficecli(
      ctx({ command: 'create', output: '.trylo/out/report.docx' }, 'ask'),
    );
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') {
      expect(decision.risk).toBe('sensitive');
      expect(decision.reasonCode).toBe('ask_level_write');
    }
  });

  it('modifying a workspace ORIGINAL requires approval at ask/workspace_write (PR-2 验收)', () => {
    for (const level of ['ask', 'workspace_write'] as const) {
      const decision = classifyOfficecli(
        ctx({ command: 'set', file: 'docs/report.docx' }, level),
      );
      expect(decision.behavior).toBe('prompt');
      if (decision.behavior === 'prompt') {
        expect(decision.reasonCode).toBe('modifies_original');
      }
    }
  });

  it('unrestricted may auto-modify originals but stays inside the root boundary (§6.3)', () => {
    const original = classifyOfficecli(
      ctx({ command: 'set', file: 'docs/report.docx' }, 'unrestricted'),
    );
    expect(original.behavior).toBe('auto_allow');
    if (original.behavior === 'auto_allow') expect(original.reasonCode).toBe('modifies_original');

    // The root boundary holds at unrestricted: outside = deny.
    const outside = classifyOfficecli(
      ctx({ command: 'set', file: 'C:/Windows/system32/evil.docx' }, 'unrestricted'),
    );
    expect(outside.behavior).toBe('deny');
  });

  it('a write with no determinable target is never auto-allowed except in unrestricted (A 完全自动放行)', () => {
    const decision = classifyOfficecli(ctx({ command: 'create' }, 'workspace_write'));
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('write_target_unknown');
    expect(classifyOfficecli(ctx({ command: 'create' }, 'unrestricted')).behavior).toBe('auto_allow');
  });

  it('move touching the original prompts even when the destination is .trylo/out', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'move', file: 'docs/report.docx', output: '.trylo/out/report.docx' },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('modifies_original');
  });
});

describe('remove / raw (§6.4 destructive / sensitive) — A 完全自动下 unrestricted 放行', () => {
  it('remove is denied at read_only, prompt at ask/workspace_write, auto in unrestricted', () => {
    expect(classifyOfficecli(ctx({ command: 'remove', file: 'docs/a.docx' }, 'read_only')).behavior).toBe('deny');
    for (const level of ['ask', 'workspace_write'] as const) {
      const decision = classifyOfficecli(ctx({ command: 'remove', file: 'docs/a.docx' }, level));
      expect(decision.behavior).toBe('prompt');
      if (decision.behavior === 'prompt') {
        expect(decision.risk).toBe('destructive');
        expect(decision.reasonCode).toBe('remove_requires_approval');
      }
    }
    expect(classifyOfficecli(ctx({ command: 'remove', file: 'docs/a.docx' }, 'unrestricted')).behavior).toBe('auto_allow');
  });

  it('raw is denied at read_only and approved at ask/workspace_write, auto in unrestricted', () => {
    expect(classifyOfficecli(ctx({ command: 'raw', action: 'view' }, 'read_only')).behavior).toBe('deny');
    for (const level of ['ask', 'workspace_write'] as const) {
      const decision = classifyOfficecli(ctx({ command: 'raw', action: 'get' }, level));
      expect(decision.behavior).toBe('prompt');
      if (decision.behavior === 'prompt') {
        expect(decision.risk).toBe('sensitive');
        expect(decision.reasonCode).toBe('raw_requires_approval');
      }
    }
    expect(classifyOfficecli(ctx({ command: 'raw', action: 'get' }, 'unrestricted')).behavior).toBe('auto_allow');
  });
});

describe('batch recursion (§6.4 递归取最高风险)', () => {
  it('read + out-write batches auto-allow at workspace_write and prompt at ask', () => {
    const input = {
      command: 'batch',
      batch: [
        { command: 'view', file: 'docs/a.docx' },
        { command: 'create', output: '.trylo/out/b.docx' },
      ],
    };
    const ws = classifyOfficecli(ctx(input, 'workspace_write'));
    expect(ws.behavior).toBe('auto_allow');
    if (ws.behavior === 'auto_allow') expect(ws.risk).toBe('workspace-write');

    const ask = classifyOfficecli(ctx(input, 'ask'));
    expect(ask.behavior).toBe('prompt');
  });

  it('a batch touching the original escalates to approval at workspace_write', () => {
    const decision = classifyOfficecli(
      ctx(
        {
          command: 'batch',
          batch: [
            { command: 'view', file: 'docs/a.docx' },
            { command: 'set', file: 'docs/a.docx' },
          ],
        },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('modifies_original');
  });

  it('a batch with remove is destructive (read_only → deny, unrestricted auto per A, else approval)', () => {
    const input = {
      command: 'batch',
      batch: [
        { command: 'view', file: 'docs/a.docx' },
        { command: 'remove', file: 'docs/a.docx' },
      ],
    };
    expect(classifyOfficecli(ctx(input, 'read_only')).behavior).toBe('deny');
    const decision = classifyOfficecli(ctx(input, 'unrestricted'));
    expect(decision.behavior).toBe('auto_allow');
    const ask = classifyOfficecli(ctx(input, 'ask'));
    expect(ask.behavior).toBe('prompt');
    if (ask.behavior === 'prompt') expect(ask.risk).toBe('destructive');
  });

  it('a batch with raw is sensitive — A 完全自动下放行', () => {
    const decision = classifyOfficecli(
      ctx({ command: 'batch', batch: [{ command: 'raw', action: 'x' }] }, 'unrestricted'),
    );
    expect(decision.behavior).toBe('auto_allow');
    const ask = classifyOfficecli(
      ctx({ command: 'batch', batch: [{ command: 'raw', action: 'x' }] }, 'ask'),
    );
    expect(ask.behavior).toBe('prompt');
    if (ask.behavior === 'prompt') expect(ask.risk).toBe('sensitive');
  });

  it('sub-command parse failures NEVER auto-allow (§6.4 解析失败不能自动放行)', () => {
    const cases: readonly Record<string, unknown>[] = [
      { command: 'batch', batch: 'not-an-array' },
      { command: 'batch' },
      { command: 'batch', batch: [] },
      { command: 'batch', batch: ['view docs/a.docx'] },
      { command: 'batch', batch: [{ command: 'format' }] },
      { command: 'batch', batch: [{ command: 'batch' }] },
      { command: 'batch', batch: [{ command: 'view', file: '../escape.docx' }] },
    ];
    for (const input of cases) {
      for (const level of ALL_LEVELS) {
        const decision = classifyOfficecli(ctx(input, level));
        expect(decision.behavior).toBe('deny');
      }
    }
  });

  it('validates top-level path fields beside the sub-operations', () => {
    const decision = classifyOfficecli(
      ctx({ command: 'batch', batch: [{ command: 'view', file: 'a.docx' }], file: '../rogue.docx' }),
    );
    expect(decision.behavior).toBe('deny');
  });
});

describe('oversized input (§14.2) — A 完全自动下 unrestricted 放行', () => {
  it('is never auto-allowed except in unrestricted, even for a plain read', () => {
    const input = { command: 'view', file: 'docs/a.docx', content: 'x'.repeat(300 * 1024) };
    for (const level of ['read_only', 'ask', 'workspace_write'] as const) {
      const decision = classifyOfficecli(ctx(input, level));
      expect(decision.behavior).toBe('prompt');
      if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('input_too_large');
    }
    expect(classifyOfficecli(ctx(input, 'unrestricted')).behavior).toBe('auto_allow');
  });

  it('a normal payload passes the cap', () => {
    const analysis = analyzeOfficecliInput({ command: 'view', file: 'docs/a.docx' }, ROOT);
    expect(analysis.oversized).toBe(false);
  });
});

describe('redaction (§6.2 不写文档正文/键入文本)', () => {
  it('the audit carries zones and a digest — never the raw input', () => {
    const secret = 'CONFIDENTIAL-CONTRACT-BODY';
    const decision = classifyOfficecli(
      ctx({ command: 'create', output: '.trylo/out/report.docx', content: secret }, 'workspace_write'),
    );
    expect(decision.behavior).toBe('auto_allow');
    if (decision.behavior !== 'auto_allow') return;
    expect(JSON.stringify(decision.audit)).not.toContain(secret);
    expect(decision.audit.inputDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(decision.audit.pathZones).toEqual([{ field: 'output', zone: 'out' }]);
    expect(decision.audit.at).toBe(1_700_000_000_000);
    expect(decision.audit.packageId).toBe('officecli');
    expect(decision.audit.toolName).toBe(OFFICECLI_TOOL_NAME);
  });

  it('key order must not matter: same logical input yields the same analysis', () => {
    const a = analyzeOfficecliInput({ command: 'view', file: 'a.docx' }, ROOT);
    const b = analyzeOfficecliInput({ file: 'a.docx', command: 'view' }, ROOT);
    expect(a).toEqual(b); // key order must not matter
    const changed = analyzeOfficecliInput({ command: 'view', file: 'b.docx' }, ROOT);
    expect(changed).not.toEqual(a);
  });

  it('the input digest is stable across key order and changes with the input', () => {
    const first = classifyOfficecli(ctx({ command: 'view', file: 'a.docx' }));
    const reordered = classifyOfficecli(
      ctx({ file: 'a.docx', command: 'view' }),
    );
    if (first.behavior !== 'auto_allow' || reordered.behavior !== 'auto_allow') {
      throw new Error('expected auto_allow');
    }
    expect(first.audit.inputDigest).toBe(reordered.audit.inputDigest);
    const changed = classifyOfficecli(ctx({ command: 'view', file: 'b.docx' }));
    if (changed.behavior !== 'auto_allow') throw new Error('expected auto_allow');
    expect(changed.audit.inputDigest).not.toBe(first.audit.inputDigest);
  });

  it('the approval preview shows command and paths but never the content fields', () => {
    const secret = 'TOP-SECRET-BODY';
    const preview = buildOfficecliApprovalPreview(
      { command: 'set', file: 'docs/report.docx', content: secret },
      ROOT,
    );
    expect(preview.kind).toBe('summary');
    expect(preview.target).toContain('set');
    expect(preview.target).toContain('docs/report.docx');
    expect(JSON.stringify(preview)).not.toContain(secret);
  });

  it('the preview marks an out-of-root path instead of silently hiding it', () => {
    const preview = buildOfficecliApprovalPreview(
      { command: 'view', file: 'C:/elsewhere/a.docx' },
      ROOT,
    );
    expect(preview.target).toContain('工作区外');
  });

  it('the preview never throws on garbage input', () => {
    const preview = buildOfficecliApprovalPreview(null as unknown as Record<string, unknown>, ROOT);
    expect(preview.kind).toBe('summary');
  });
});

describe('analysis determinism', () => {
  it('classify is pure: same context, same decision', () => {
    const input = { command: 'create', output: '.trylo/out/a.docx' };
    expect(classifyOfficecli(ctx(input))).toEqual(classifyOfficecli(ctx(input)));
  });

  it('analysis never throws for any of the attack inputs', () => {
    const garbage: readonly unknown[] = [
      null,
      42,
      'string',
      [],
      { command: 'batch', batch: [{ command: 'view' }, null] },
      { command: 'view', file: {} },
    ];
    for (const input of garbage) {
      expect(() =>
        analyzeOfficecliInput(input as Record<string, unknown>, ROOT),
      ).not.toThrow();
    }
  });
});

describe('slide geometric layout one-call path (align/distribute via set)', () => {
  // The pptx skill teaches `set <deck> /slide[N] --prop align=… /
  // --prop distribute=…` as the single-call replacement for the old
  // get-coords → hand-compute → N×set loop. These pin the permission
  // path that call takes: plain `set` semantics, props are opaque to
  // the classifier (--prop is skipped), so layout flows exactly like
  // any other set — auto in .trylo/out, approval on originals.
  it('align in .trylo/out auto-allows at workspace_write (real agent call shape)', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'set .trylo/out/deck.pptx /slide[2] --prop align=bottom' },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('auto_allow');
    if (decision.behavior === 'auto_allow') {
      expect(decision.risk).toBe('workspace-write');
      expect(decision.reasonCode).toBe('write_to_out');
    }
  });

  it('distribute with targets= in .trylo/out auto-allows at workspace_write', () => {
    const decision = classifyOfficecli(
      ctx(
        {
          command:
            'set .trylo/out/deck.pptx /slide[2] --prop distribute=horizontal --prop targets="shape[@id=100000],shape[@id=100001]"',
        },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('auto_allow');
  });

  it('align on a workspace ORIGINAL still requires approval (no privilege hole)', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'set docs/deck.pptx /slide[2] --prop align=bottom' },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('modifies_original');
  });

  it('pdf delivery (view pdf --out) auto-allows into .trylo/out at workspace_write', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'view .trylo/out/deck.pptx pdf --out .trylo/out/deck.pdf' },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('auto_allow');
  });

  it('layout verb in .trylo/out auto-allows at workspace_write (real agent call shape)', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'layout .trylo/out/deck.pptx /slide[2] --align bottom --distribute horizontal' },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('auto_allow');
    if (decision.behavior === 'auto_allow') {
      expect(decision.risk).toBe('workspace-write');
      expect(decision.reasonCode).toBe('write_to_out');
    }
  });

  it('layout verb on a workspace ORIGINAL requires approval (no privilege hole)', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'layout docs/deck.pptx /slide[2] --align bottom' },
        'workspace_write',
      ),
    );
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('modifies_original');
  });

  it('layout verb is denied at read_only', () => {
    const decision = classifyOfficecli(
      ctx(
        { command: 'layout .trylo/out/deck.pptx /slide[2] --align bottom' },
        'read_only',
      ),
    );
    expect(decision.behavior).toBe('deny');
  });

  it('a batch with a layout sub-op follows the write matrix (real call shape: file slot + inline JSON)', () => {
    const cmd =
      'batch .trylo/out/deck.pptx --commands \'[{"command":"layout","path":"/slide[2]","props":{"align":"bottom"}}]\'';
    expect(classifyOfficecli(ctx({ command: cmd }, 'workspace_write')).behavior).toBe('auto_allow');
    expect(classifyOfficecli(ctx({ command: cmd }, 'ask')).behavior).toBe('prompt');
  });

  it('a batch with a layout sub-op on an original prompts at workspace_write', () => {
    const cmd =
      'batch docs/deck.pptx --commands \'[{"command":"layout","path":"/slide[2]","props":{"align":"bottom"}}]\'';
    const decision = classifyOfficecli(ctx({ command: cmd }, 'workspace_write'));
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') expect(decision.reasonCode).toBe('modifies_original');
  });
});
