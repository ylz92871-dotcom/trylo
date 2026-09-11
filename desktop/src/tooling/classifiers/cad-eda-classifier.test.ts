// Trylo Desktop — CAD/EDA adapter classifier tests.
//
// TRYLO-CAD-EDA-TOOL-ADAPTER §7 acceptance:
//   - every classifier matches its shipped desktop-services manifest
//     EXACTLY (server name + full expectedTools, cross-package pin);
//   - the policy tables partition each tool surface (proven at module
//     load; re-proven here via counts);
//   - read → auto-allow at every level (incl. read_only);
//   - workspace-write → auto-allow at ≥ ask, deny at read_only;
//   - external / sensitive / destructive → prompt at ask/workspace_write,
//     deny at read_only, auto at unrestricted (§6.3 matrix);
//   - arbitrary-code-execution surfaces are ALWAYS destructive prompts;
//   - previews are redaction-first (no geometry/coordinate/code echo).

import { describe, expect, it } from 'vitest';

import { AUTOCAD_MCP_MANIFEST } from '../../../../desktop-services/src/tooling/manifests/autocad-mcp.mjs';
import { BLENDER_MCP_MANIFEST } from '../../../../desktop-services/src/tooling/manifests/blender-mcp.mjs';
import { FREECAD_MCP_MANIFEST } from '../../../../desktop-services/src/tooling/manifests/freecad-mcp.mjs';
import { JLCEDA_MCP_MANIFEST } from '../../../../desktop-services/src/tooling/manifests/jlceda-mcp.mjs';
import { KICAD_MCP_MANIFEST } from '../../../../desktop-services/src/tooling/manifests/kicad-mcp.mjs';
import { SOLIDWORKS_MCP_MANIFEST } from '../../../../desktop-services/src/tooling/manifests/solidworks-mcp.mjs';
import {
  CAD_EDA_CLASSIFIERS,
  autocadClassifier,
  blenderClassifier,
  freecadClassifier,
  jlcedaClassifier,
  kicadClassifier,
  solidworksClassifier,
  buildCadEdaApprovalPreviewForTool,
  classifyWithClassifier,
} from './cad-eda-classifier';
import type { PackageRiskClassifier, ToolRiskContext } from '../tool-risk-classifier';
import type { PermissionLevel } from '../../permission/permission-policy';

const MANIFESTS = [
  SOLIDWORKS_MCP_MANIFEST,
  AUTOCAD_MCP_MANIFEST,
  KICAD_MCP_MANIFEST,
  JLCEDA_MCP_MANIFEST,
  FREECAD_MCP_MANIFEST,
  BLENDER_MCP_MANIFEST,
];

const CLASSIFIER_BY_ID = new Map(
  CAD_EDA_CLASSIFIERS.map((classifier) => [classifier.id, classifier]),
);

function ctx(
  classifier: PackageRiskClassifier,
  shortTool: string,
  input: Record<string, unknown> = {},
  level: PermissionLevel = 'workspace_write',
): ToolRiskContext {
  return {
    profileId: 'work.cad.v1',
    packageId: classifier.id,
    toolName: `mcp__${classifier.serverName}__${shortTool}`,
    input,
    permissionLevel: level,
    projectRoot: 'D:/work/proj',
    conversationId: 'conv-cad',
    at: 1_000,
  };
}

describe('manifest ↔ classifier twin contract', () => {
  for (const manifest of MANIFESTS) {
    it(`pins ${manifest.id} exactly (server + expectedTools)`, () => {
      const classifier = CLASSIFIER_BY_ID.get(manifest.id);
      expect(classifier).toBeDefined();
      expect(classifier!.serverName).toBe(manifest.mcp.serverName);
      expect([...classifier!.expectedTools]).toEqual(
        manifest.mcp.expectedTools.map((tool) => `mcp__${manifest.mcp.serverName}__${tool}`),
      );
    });
  }

  it('carries the audited tool counts', () => {
    // SolidWorks = 45 base tools (audit 2026-09-04) + 6 controlled-modeling
    // channel tools (2026-09-06) = 51.
    expect(solidworksClassifier.expectedTools).toHaveLength(51);
    expect(autocadClassifier.expectedTools).toHaveLength(154);
    expect(kicadClassifier.expectedTools).toHaveLength(229);
    expect(jlcedaClassifier.expectedTools).toHaveLength(59);
    expect(freecadClassifier.expectedTools).toHaveLength(15);
    expect(blenderClassifier.expectedTools).toHaveLength(28);
  });
});

describe('risk matrix', () => {
  it('read tools auto-allow at every permission level', () => {
    for (const level of ['read_only', 'ask', 'workspace_write', 'unrestricted'] as const) {
      const decision = classifyWithClassifier(
        kicadClassifier,
        ctx(kicadClassifier, 'get_board_info', {}, level),
      );
      expect(decision.behavior).toBe('auto_allow');
    }
  });

  it('workspace-write auto-allows at ≥ ask and denies at read_only', () => {
    const ask = classifyWithClassifier(
      kicadClassifier,
      ctx(kicadClassifier, 'place_component', { reference: 'R1' }, 'ask'),
    );
    expect(ask.behavior).toBe('auto_allow');
    const readOnly = classifyWithClassifier(
      kicadClassifier,
      ctx(kicadClassifier, 'place_component', { reference: 'R1' }, 'read_only'),
    );
    expect(readOnly.behavior).toBe('deny');
  });

  it('destructive / external / sensitive surfaces always prompt below unrestricted', () => {
    const cases: readonly [PackageRiskClassifier, string, 'destructive' | 'external' | 'sensitive'][] = [
      [blenderClassifier, 'execute_blender_code', 'destructive'],
      [freecadClassifier, 'execute_code', 'destructive'],
      [jlcedaClassifier, 'pcb_execute_code', 'destructive'],
      [autocadClassifier, 'system_run_lisp', 'destructive'],
      [solidworksClassifier, 'solidworks_close_documents', 'destructive'],
      [kicadClassifier, 'delete_component', 'destructive'],
      [blenderClassifier, 'download_polyhaven_asset', 'external'],
      [kicadClassifier, 'get_jlcpcb_part', 'external'],
      [solidworksClassifier, 'solidworks_connect', 'sensitive'],
      [kicadClassifier, 'launch_kicad_ui', 'sensitive'],
    ];
    for (const [classifier, tool] of cases) {
      const decision = classifyWithClassifier(classifier, ctx(classifier, tool, {}));
      expect(decision.behavior, `${classifier.id}:${tool}`).toBe('prompt');
      const readOnly = classifyWithClassifier(classifier, ctx(classifier, tool, {}, 'read_only'));
      expect(readOnly.behavior, `${classifier.id}:${tool} @ read_only`).toBe('deny');
      const unrestricted = classifyWithClassifier(classifier, ctx(classifier, tool, {}, 'unrestricted'));
      expect(unrestricted.behavior, `${classifier.id}:${tool} @ unrestricted`).toBe('auto_allow');
    }
  });

  it('every destructively-flagged tool of every policy prompts (exhaustive)', () => {
    // The module's compiled policies are not exported directly; the
    // exhaustive check rides on the manifest: any pinned tool whose name
    // matches the destructive families MUST prompt at workspace_write.
    const destructiveFamilies =
      /^(delete|clear|remove|discard|purge|replace_board_outline|refill_zones|autoroute|download_jlcpcb_database|sch_generate_from|close_documents|construction_clear|system_run_command|system_run_lisp|execute)/;
    for (const classifier of CAD_EDA_CLASSIFIERS) {
      for (const full of classifier.expectedTools) {
        const short = full.split('__').pop() ?? '';
        if (!destructiveFamilies.test(short)) continue;
        const decision = classifyWithClassifier(classifier, ctx(classifier, short, {}));
        expect(decision.behavior, `${classifier.id}:${short}`).toBe('prompt');
        if (decision.behavior === 'prompt') {
          expect(decision.risk).toBe('destructive');
        }
      }
    }
  });
});

describe('previews', () => {
  it('are redaction-first (no input fields at all)', () => {
    // The builder takes ONLY the tool name — there is no path through which
    // geometry parameters, coordinates or embedded scripts could be echoed.
    const preview = buildCadEdaApprovalPreviewForTool('mcp__trylo-autocad__system_run_lisp');
    expect(preview.kind).toBe('summary');
    expect(preview.target).toBe('system_run_lisp');
    expect(preview.title).toContain('AutoCAD');
    expect(preview.command).toBeUndefined();
    expect(preview.diff).toBeUndefined();
    expect(preview.cwd).toBeUndefined();
    expect(preview.textChars).toBeUndefined();
  });

  it('falls back to a generic title for an unknown server', () => {
    const preview = buildCadEdaApprovalPreviewForTool('mcp__trylo-unknown__whatever');
    expect(preview.title).toContain('CAD/EDA');
  });
});
