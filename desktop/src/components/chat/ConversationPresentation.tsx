import { createContext, type ReactNode } from 'react';
import type { ApprovalMessage, ChatMessage } from './types';

export interface HostedApprovalIdentity {
  readonly messageId: string;
  readonly approvalId: string;
  readonly authority: 'code';
}

export interface LiveCodeApproval extends ApprovalMessage {
  readonly authority: 'code';
  readonly status: 'pending';
  readonly pendingRequest: NonNullable<ApprovalMessage['pendingRequest']>;
}

/** UI projection of the registry's typed transient handle, never a grant. */
export function isLiveCodeApproval(message: ChatMessage): message is LiveCodeApproval {
  return message.kind === 'approval' && message.authority === 'code' && message.status === 'pending'
    && message.pendingRequest?.requestId === message.approvalId;
}

export function isHostedApproval(message: ChatMessage, hosted?: readonly HostedApprovalIdentity[]): boolean {
  return isLiveCodeApproval(message) && Boolean(hosted?.some(identity =>
    identity.messageId === message.id && identity.approvalId === message.approvalId
    && identity.authority === message.authority));
}

export interface ConversationTimelineEnvironment {
  readonly onOpenArtifact?: (path: string) => void;
  readonly artifactHost?: import('../../host-adapter/artifact-actions').ArtifactHost;
  readonly workspacePath?: string;
  readonly renderEvent?: (message: ChatMessage) => ReactNode;
}

/** A host may change the reading surface while retaining the real composer. */
export const ConversationPresentation = createContext<{
  readonly embedded: boolean;
  /** Exact live cards already rendered by the surrounding host's approval rail. */
  readonly hostedApprovals?: readonly HostedApprovalIdentity[];
  readonly observeEnvironment?: (environment: ConversationTimelineEnvironment) => void;
  readonly timeline?: ReactNode | ((messages: readonly ChatMessage[], environment: ConversationTimelineEnvironment) => ReactNode);
}>({ embedded: false });
