import { expect, it } from 'vitest';
import {
  parsePendingJson,
  readPendingEffects,
  recordEffectVerdict,
  type ReconcileCliTarget,
} from './effect-reconciliation';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath } from '../host-adapter/types';

const paths = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath };

/** One CLI invocation, answered synchronously with the given exit and streams. */
function cli(answer: { readonly code: number; readonly stdout?: string; readonly spawns?: string[][] }): ReconcileCliTarget {
  const process: Pick<ProcessService, 'spawn' | 'stop'> = {
    async spawn(options) {
      answer.spawns?.push([...options.args]);
      for (const line of (answer.stdout ?? '').split('\n')) if (line.length > 0) options.onOutput(line);
      options.onExit?.({ id: 'owned', pid: 1, code: answer.code, signal: null });
      return { id: 'owned', pid: 1, label: options.label, command: options.command };
    },
    stop: async () => {},
  };
  return { ...paths, process };
}

it('decodes the engine listing, keeping "no call survived" as a missing tool', () => {
  const decoded = parsePendingJson(JSON.stringify({
    pending: [
      { turn: 'turn-1', key: 'tool:call-a', issuedAtSequence: 12, issuedAt: '2026-11-11T06:27:50.607Z' },
      { key: 'tool:call-b', issuedAtSequence: 19, issuedAt: '2026-11-11T07:00:00.000Z', tool: 'run_shell',
        arguments: { command: 'node build.mjs' } },
    ],
    openBlocks: 1,
  }));
  expect(decoded).toEqual({
    ok: true,
    openBlocks: 1,
    pending: [
      { turn: 'turn-1', key: 'tool:call-a', issuedAtSequence: 12, issuedAt: '2026-11-11T06:27:50.607Z' },
      { key: 'tool:call-b', issuedAtSequence: 19, issuedAt: '2026-11-11T07:00:00.000Z', tool: 'run_shell',
        arguments: { command: 'node build.mjs' } },
    ],
  });
});

it('refuses the whole listing when one entry is not decodable', () => {
  // A half-decoded list reports a smaller number of open questions than the
  // session really has, which is worse than reporting nothing.
  expect(parsePendingJson(JSON.stringify({
    pending: [
      { key: 'tool:a', issuedAtSequence: 1, issuedAt: '2026-11-11T00:00:00.000Z' },
      { key: 'tool:b', issuedAt: '2026-11-11T00:00:00.000Z' },
    ],
    openBlocks: 0,
  }))).toEqual({ ok: false, reason: 'bad_shape' });
  expect(parsePendingJson('')).toEqual({ ok: false, reason: 'empty_output' });
  expect(parsePendingJson('{"pending":[]}')).toEqual({ ok: true, pending: [], openBlocks: 0 });
});

it('reads a blocked session as an answer, not as a transport failure', async () => {
  // The CLI exits non-zero on purpose while anything is unresolved — the same
  // condition that refuses `--resume`. Judging by exit code would erase it.
  const stdout = JSON.stringify({
    pending: [{ turn: 'turn-758e', key: 'tool:call_00_c9', issuedAtSequence: 4557, issuedAt: '2026-11-11T06:27:50.607Z' }],
    openBlocks: 0,
  });
  const read = await readPendingEffects(cli({ code: 1, stdout }), 'desktop-ddfe13cd');
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.pending.map(effect => effect.key)).toEqual(['tool:call_00_c9']);
});

it('a blocked session and a broken CLI stay distinguishable', async () => {
  const broken = await readPendingEffects(cli({ code: 2, stdout: '' }), 'desktop-ddfe13cd');
  expect(broken).toEqual({ ok: false, reason: 'exit_2' });

  const garbled = await readPendingEffects(cli({ code: 1, stdout: 'not json' }), 'desktop-ddfe13cd');
  expect(garbled).toEqual({ ok: false, reason: 'exit_1:invalid_json' });
});

it('records the verdict through the engine and never rewrites the journal itself', async () => {
  const spawns: string[][] = [];
  const recorded = await recordEffectVerdict(cli({ code: 0, stdout: 'recorded failed for tool:c\n', spawns }), {
    sessionId: 'desktop-ddfe13cd',
    key: 'tool:c',
    turn: 'turn-1',
    verdict: 'failed',
    evidence: '.trylo/out has no PDF',
  });
  expect(recorded).toEqual({ ok: true });
  // The transport puts the pinned CLI entry first; the engine arguments follow verbatim.
  expect(spawns).toHaveLength(1);
  expect(spawns[0]?.slice(1)).toEqual(['session', 'reconcile', 'desktop-ddfe13cd',
    '--turn', 'turn-1', '--key', 'tool:c', '--outcome', 'failed', '--evidence', '.trylo/out has no PDF']);
});

it('will not record a verdict without saying what was checked', async () => {
  const spawns: string[][] = [];
  const refused = await recordEffectVerdict(cli({ code: 0, spawns }), {
    sessionId: 's', key: 'tool:c', turn: 'turn-1', verdict: 'committed', evidence: '   ',
  });
  expect(refused).toEqual({ ok: false, reason: 'evidence_required' });
  expect(spawns).toEqual([]);
});
