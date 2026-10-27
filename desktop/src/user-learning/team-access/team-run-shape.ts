import { TEAM_ROLE_IDS } from './profiles/profile-types';
import type { PersistableTeamRun } from './persist';
import { isMemberObservation } from '../../domain/member-observation';

const RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'cancelled'];
const SEAT_STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'];
type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const identity = (value: unknown): value is string => text(value) && value.trim().length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const unique = (values: readonly Row[], key: string): boolean => new Set(values.map(value => value[key])).size === values.length;

function profile(value: unknown): boolean {
  if (!row(value) || value.schemaVersion !== 1 || !identity(value.id) || !text(value.title)
    || !['builtin', 'custom'].includes(String(value.origin)) || !['code', 'work'].includes(String(value.surface))
    || !count(value.createdAt) || !count(value.updatedAt) || !Array.isArray(value.members)) return false;
  const members = value.members;
  return members.every(member => row(member) && identity(member.memberId) && text(member.displayName)
    && (TEAM_ROLE_IDS as readonly unknown[]).includes(member.baseRole) && row(member.overlay)
    && text(member.overlay.model) && text(member.overlay.systemPromptOverlay) && strings(member.overlay.skills)
    && optional(member.overlay.tools, strings) && optional(member.overlay.disallowedTools, strings))
    && unique(members, 'memberId');
}

function seat(value: unknown): value is Row {
  if (!row(value) || !identity(value.id) || !(TEAM_ROLE_IDS as readonly unknown[]).includes(value.seat)
    || !SEAT_STATUSES.includes(String(value.status)) || !text(value.summary)) return false;
  return optional(value.observations, items => Array.isArray(items) && items.length <= 256 && items.every(item => isMemberObservation(item)
    && row(item) && count(item.at) && optional(item.completedAt, count)))
    && ['memberId'].every(key => optional(value[key], identity))
    && optional(value.taskId, identity) && optional(value.round, item => count(item) && item > 0)
    && ['canReceiveInput', 'awaitingInput', 'parked'].every(key => optional(value[key], item => typeof item === 'boolean'))
    && optional(value.conversation, items => Array.isArray(items) && items.every(item => row(item) && count(item.round)
      && item.round > 0 && optional(item.prompt, text) && optional(item.result, text)))
    && ['displayName', 'prompt', 'result', 'error', 'resolvedModel'].every(key => optional(value[key], text))
    && ['startedAt', 'endedAt', 'durationMs'].every(key => optional(value[key], count))
    && ['toolsApplied', 'skillsDropped'].every(key => optional(value[key], strings))
    && optional(value.activity, items => Array.isArray(items) && items.every(item => row(item) && identity(item.id)
      && ['tool', 'result', 'note'].includes(String(item.kind)) && count(item.at) && text(item.label)
      && optional(item.round, count) && optional(item.ok, flag => typeof flag === 'boolean')));
}

/** History is untrusted disk input; validate before migration or UI hydration. */
export function isPersistableTeamRun(value: unknown): value is PersistableTeamRun {
  if (!row(value) || !identity(value.id) || !identity(value.personConversationId) || !RUN_STATUSES.includes(String(value.status))
    || !row(value.summary) || !Array.isArray(value.seats) || !count(value.createdAt) || !count(value.updatedAt)) return false;
  return ['title', 'goal', 'oneLiner'].every(key => text((value.summary as Row)[key]))
    && ['explicit', 'inferred', 'baseline'].every(key => optional((value.summary as Row)[key], text))
    && value.seats.every(seat) && unique(value.seats, 'id')
    && optional(value.frozenProfile, profile) && optional(value.endedAt, count) && optional(value.error, text)
    && optional(value.lifecycle, item => item === 'open' || item === 'closed')
    && optional(value.contractId, identity) && optional(value.contractVersion, count)
    && optional(value.reports, items => Array.isArray(items) && items.every(item => row(item) && identity(item.id)
      && identity(item.seatId) && ['assignment', 'report', 'error', 'progress', 'blocked', 'ready'].includes(String(item.kind)) && text(item.text)
      && optional(item.memberId, identity) && optional(item.at, count) && optional(item.round, count)
      && optional(item.streaming, flag => typeof flag === 'boolean')) && unique(items as Row[], 'id'))
    && optional(value.handoffs, items => Array.isArray(items) && items.every(item => row(item) && identity(item.id)
      && identity(item.toSeatId) && text(item.message) && count(item.at)
      && ['sending', 'sent', 'queued', 'continued', 'restarted', 'failed'].includes(String(item.status))
      && optional(item.fromSeatId, identity) && optional(item.fromMemberId, identity) && optional(item.toMemberId, identity)
      && optional(item.settledAt, count) && optional(item.error, text)) && unique(items as Row[], 'id'));
}
