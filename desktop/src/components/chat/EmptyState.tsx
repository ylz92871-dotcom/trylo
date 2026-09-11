// Trylo Desktop — Landing configs for Code and Work.
//
// Both modes render the SAME skeleton (`LandingSurface`).
// Code and Work differ only in copy + suggestion set — the
// 80/20 split the 2026-08-29 refactor calls for. No extra UI
// modules are added to distinguish them.
//
// The Work mode is no longer an Office document generator and
// no longer shows a four-card onboarding grid. Its capability
// starters are downgraded to light suggestion pills.

import type { ReactElement } from 'react';
import { defaultStarters } from '@trylo/work';
import type { CodeMode } from '../../host-adapter/types';
import { LandingSurface, type LandingSuggestion } from '../landing/LandingSurface';

/* ── Code ──────────────────────────────────────────────────── */

const CODE_LANDING: Record<
  CodeMode,
  { headline: string; subtitle: string; suggestions: LandingSuggestion[] }
> = {
  chat: {
    headline: 'What are you building?',
    subtitle: 'Start from the current workspace, or describe the task directly.',
    suggestions: [
      { label: 'Understand this repo', value: 'Help me understand this repository.' },
      { label: 'Find a bug', value: 'Find a bug in this codebase.' },
      { label: 'Implement a change', value: 'Implement a change in this project.' },
    ],
  },
  plan: {
    headline: 'What do you want to design first?',
    subtitle: 'Plan from this workspace, or sketch the change.',
    suggestions: [
      { label: 'Design the data model', value: 'Design the data model for this feature.' },
      { label: 'Outline a refactor', value: 'Outline a refactor of this module.' },
      { label: 'Plan the API', value: 'Plan the API surface for this service.' },
    ],
  },
  agent: {
    headline: 'Tell the agent what to do.',
    subtitle: 'Start from the current workspace, or describe the task directly.',
    suggestions: [
      { label: 'Scaffold project', value: 'Scaffold a new project here.' },
      { label: 'Automate build', value: 'Automate the build and test pipeline.' },
      { label: 'Run migration', value: 'Run the database migration.' },
    ],
  },
  cognition: {
    headline: 'How should Trylo work with you?',
    subtitle: 'This is a conversation, not a questionnaire. Nothing is written to your project.',
    suggestions: [
      { label: 'Plan vs execute', value: '普通功能直接做，核心架构先计划并保留最终验证。' },
      { label: 'Work deliverables', value: '做 PPT 先出一版再改；对外方案必须先给我看结构。' },
      { label: 'Desktop', value: '电脑低风险你自己点，涉及账号先问我。' },
    ],
  },
};

export interface EmptyStateProps {
  readonly codeMode: CodeMode;
  /** Sends a suggestion straight to the agent (skips the composer). */
  readonly onSuggestion?: (text: string) => void;
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  const cfg = CODE_LANDING[props.codeMode];
  return (
    <LandingSurface
      headline={cfg.headline}
      subtitle={cfg.subtitle}
      suggestions={cfg.suggestions}
      onSuggestion={(s) => props.onSuggestion?.(s.value)}
    />
  );
}

/* ── Work ──────────────────────────────────────────────────── */

// The four capability starters, downgraded to short pills.
const WORK_PILL_IDS = [
  'research_sources',
  'data_analysis',
  'file_organization',
  'deliverable',
] as const;

const WORK_PILL_LABELS: Record<string, string> = {
  research_sources: 'Research',
  data_analysis: 'Analyze',
  file_organization: 'Organize',
  deliverable: 'Create',
};

export interface WorkLandingProps {
  /** When false, the credentials banner already covers this case. */
  readonly hasApiKey?: boolean;
  /** Writes the seed into the Work input; the user still reviews/sends. */
  readonly onPickStarter: (seed: string, starterId: string) => void;
}

export function WorkLanding(props: WorkLandingProps): ReactElement {
  // Banner (above the timeline) handles the missing-API-key case,
  // so suppress the landing surface to avoid double messaging.
  if (props.hasApiKey === false) {
    return <div className="work-landing--quiet" aria-hidden="true" />;
  }
  const starters = defaultStarters();
  const suggestions: LandingSuggestion[] = WORK_PILL_IDS.map((id) => {
    const starter = starters.find((s) => s.id === id);
    return {
      label: WORK_PILL_LABELS[id] ?? starter?.title ?? id,
      value: starter?.starterSeed ?? '',
      id,
    };
  }).filter((s) => s.value.length > 0);
  return (
    <LandingSurface
      headline="What are we working on?"
      subtitle="Describe the outcome you want from this workspace."
      suggestions={suggestions}
      onSuggestion={(s) => props.onPickStarter(s.value, s.id ?? '')}
    />
  );
}
