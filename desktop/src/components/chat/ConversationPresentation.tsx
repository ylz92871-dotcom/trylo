import { createContext, type ReactNode } from 'react';
import type { ChatMessage } from './types';

export interface ConversationTimelineEnvironment {
  readonly onOpenArtifact?: (path: string) => void;
  readonly artifactHost?: import('@trylo/work').HostAdapter;
  readonly workspacePath?: string;
  readonly renderEvent?: (message: ChatMessage) => ReactNode;
}

/** A host may change the reading surface while retaining the real composer. */
export const ConversationPresentation = createContext<{
  readonly embedded: boolean;
  readonly observeEnvironment?: (environment: ConversationTimelineEnvironment) => void;
  readonly timeline?: ReactNode | ((messages: readonly ChatMessage[], environment: ConversationTimelineEnvironment) => ReactNode);
}>({ embedded: false });
