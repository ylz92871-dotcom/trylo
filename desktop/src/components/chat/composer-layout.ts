import { createContext } from 'react';

// The surface owns the empty-state decision even when capabilities supply the composer slot.
export const ComposerLayoutContext = createContext<'conversation' | 'start'>('conversation');
