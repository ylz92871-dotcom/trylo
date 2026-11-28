import { useSyncExternalStore } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastAction {
  readonly label: string;
  readonly onAction: () => void | Promise<void>;
}

export interface ToastInput {
  readonly id?: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ToastAction;
  /** `0` keeps the toast persistent until dismissed. */
  readonly durationMs?: number;
}

export interface ToastItem {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ToastAction;
  readonly durationMs: number;
  readonly createdAt: number;
}

const MAX_TOASTS = 3;

let nextSeq = 0;
let items: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function defaultDuration(tone: ToastTone, hasAction: boolean): number {
  if (tone === 'error') return 0;
  return hasAction ? 5500 : 2800;
}

function scheduleDismiss(item: ToastItem): void {
  clearTimer(item.id);
  if (item.durationMs <= 0) return;
  const timer = setTimeout(() => {
    dismissToast(item.id);
  }, item.durationMs);
  timers.set(item.id, timer);
}

/**
 * Push or deduplicate a toast notification.
 * Errors persist until closed; action toasts default to 5.5s so undo stays reachable.
 */
export function pushToast(input: ToastInput): string {
  const durationMs = input.durationMs ?? defaultDuration(input.tone, Boolean(input.action));
  const duplicate = input.id
    ? items.find((item) => item.id === input.id)
    : items.find((item) => item.tone === input.tone && item.title === input.title && item.detail === input.detail);

  const id = duplicate?.id ?? input.id ?? `toast-${++nextSeq}`;
  const nextItem: ToastItem = {
    id,
    tone: input.tone,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.action ? { action: input.action } : {}),
    durationMs,
    createdAt: Date.now(),
  };

  if (duplicate) {
    items = items.map((item) => (item.id === id ? nextItem : item));
  } else {
    const trimmed = items.length >= MAX_TOASTS ? items.slice(items.length - (MAX_TOASTS - 1)) : items;
    for (const old of items) {
      if (!trimmed.includes(old)) clearTimer(old.id);
    }
    items = [...trimmed, nextItem];
  }

  scheduleDismiss(nextItem);
  emit();
  return id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function pauseToast(id: string): void {
  clearTimer(id);
}

export function resumeToast(id: string): void {
  const target = items.find((item) => item.id === id);
  if (!target || target.durationMs <= 0) return;
  scheduleDismiss(target);
}

export function clearToasts(): void {
  for (const id of timers.keys()) clearTimer(id);
  if (items.length === 0) return;
  items = [];
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastItem[] {
  return items;
}

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
