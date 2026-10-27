// Desktop owns the typed engineering contract. The new CLI carries the
// prompt wrapper into its frozen member roles without importing Desktop types.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_TAG,
  CONTRACT_TAG as CONTRACT_TAG_LEARNING,
  ENGINEERING_CONTRACT_SCHEMA_VERSION,
  TEAM_ACCESS_SEAT_IDS,
} from '../../user-learning/team-access/contract-types';
import {
  CONTRACT_AUTHORITY_KEYS_UI,
  CONTRACT_TAG_UI,
  ENGINEERING_CONTRACT_SCHEMA_VERSION_UI,
  CONTRACT_SUMMARY_KEYS_UI,
} from './engineering-contract';
import { TRYLO_TEAM_SEAT_IDS_DESKTOP } from './seats';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_CONTRACT = join(
  HERE,
  '../../../../new trylo cli/src/internal/surface/cli/team-profile-wiring.ts',
);
const UL_CONTRACT = join(
  HERE,
  '../../user-learning/team-access/contract-types.ts',
);

describe('surfaces/shared/engineering-contract contract boundary', () => {
  it('uses the same wrapper tag as user-learning and the CLI copy', () => {
    expect(CONTRACT_TAG_UI).toBe(CONTRACT_TAG_LEARNING);
    const cli = readFileSync(CLI_CONTRACT, 'utf8');
    expect(cli).toContain(CONTRACT_TAG);
    expect(ENGINEERING_CONTRACT_SCHEMA_VERSION_UI).toBe(ENGINEERING_CONTRACT_SCHEMA_VERSION);
  });

  it('authority keys match the Desktop contract in order', () => {
    expect([...CONTRACT_AUTHORITY_KEYS_UI]).toEqual([
      'explicit',
      'inferred',
      'baseline',
      'recommendation',
    ]);
    const ul = readFileSync(UL_CONTRACT, 'utf8');
    expect(ul).toContain(
      "export type ContractAuthority = 'explicit' | 'inferred' | 'baseline' | 'recommendation';",
    );
    // Role prompts preserve this wrapper; authority is not reinterpreted by a second schema.
    expect(readFileSync(CLI_CONTRACT, 'utf8')).toContain('trylo_engineering_contract');
  });

  it('summary keys are a subset of the authority keys and match TaskSummary rows', () => {
    for (const key of CONTRACT_SUMMARY_KEYS_UI) {
      expect((CONTRACT_AUTHORITY_KEYS_UI as readonly string[]).includes(key)).toBe(true);
    }
  });

  it('seat ids match the local surfaces copy (shared roster order)', () => {
    expect([...TRYLO_TEAM_SEAT_IDS_DESKTOP]).toEqual([...TEAM_ACCESS_SEAT_IDS]);
  });

  it('core schema fields remain owned by the Desktop contract', () => {
    const fields = [
      'contractId',
      'personConversationId',
      'teamRunId',
      'supersedes',
      'provenance',
      'sourceUserModelIds',
    ];
    for (const field of fields) {
      expect(readFileSync(UL_CONTRACT, 'utf8')).toContain(`readonly ${field}`);
    }
  });
});
