export type SettingsNotice = 'routing-learning-retired';

export function withoutSettingsNotice(notices: readonly SettingsNotice[] | undefined, notice: SettingsNotice): readonly SettingsNotice[] {
  return (notices ?? []).filter(value => value !== notice);
}

/** UI migration metadata only: never a runtime switch, budget or learning state. */
export function settingsNotices(value: unknown): readonly SettingsNotice[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const stored = value as Record<string, unknown>;
  const notices: SettingsNotice[] = Array.isArray(stored.settingsNotices)
    && stored.settingsNotices.includes('routing-learning-retired') ? ['routing-learning-retired'] : [];
  if (Object.prototype.hasOwnProperty.call(stored, 'routingLearningConfig') && notices.length === 0) notices.push('routing-learning-retired');
  return notices;
}
