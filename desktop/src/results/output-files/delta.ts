import type { OutputSnapshot } from './snapshot';
import type { StoredProducedFile } from '../conversation-result-types';

export interface OutputDelta {
  readonly files: readonly StoredProducedFile[];
  readonly incomplete: boolean;
}

/** An incomplete start cannot prove absence. In that case only paths present
 * in both snapshots can prove a change. Removed files are not deliverables. */
export function outputFileDelta(baseline: OutputSnapshot | null, final: OutputSnapshot | null): OutputDelta {
  const prior = new Map(baseline?.files.map((file) => [file.path, file.signature]));
  const files: StoredProducedFile[] = [];
  if (baseline && final) for (const file of final.files) {
    const before = prior.get(file.path);
    if (before ? before.size !== file.signature.size || before.modifiedMs !== file.signature.modifiedMs : !baseline.incomplete) {
      files.push({ path: file.path, change: before ? 'updated' : 'created', signature: file.signature });
    }
  }
  files.sort((a, b) => b.signature.modifiedMs - a.signature.modifiedMs || a.path.localeCompare(b.path));
  return { files, incomplete: !baseline || !final || baseline.incomplete || final.incomplete };
}
