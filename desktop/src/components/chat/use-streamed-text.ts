import { useLayoutEffect, useRef, useState } from 'react';

const IMMEDIATE_CHARACTERS = 24;
const REVEAL_MS = 160;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// Never cut a received UTF-16 pair in half during a frame.
function prefix(text: string, length: number): string {
  const end = Math.min(text.length, length);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

function initial(text: string, streaming: boolean): string {
  return streaming && !reduceMotion() ? prefix(text, IMMEDIATE_CHARACTERS) : text;
}

/** Reveal only received bytes. The canonical message is always the full snapshot. */
export function useStreamedText(id: string, text: string, streaming: boolean): string {
  const [view, setView] = useState(() => ({ id, text: initial(text, streaming) }));
  const state = useRef({ id, target: text, shown: view.text, frame: null as number | null,
    startedAt: 0, from: view.text.length });

  useLayoutEffect(() => {
    const current = state.current;
    const cancel = () => {
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      current.frame = null;
    };
    const show = (value: string) => {
      if (current.shown === value && current.id === view.id) return;
      current.shown = value;
      setView({ id: current.id, text: value });
    };
    if (current.id !== id || !text.startsWith(current.shown)) {
      cancel();
      current.id = id;
      show(initial(text, streaming));
    }
    current.target = text;
    if (!streaming || reduceMotion() || text.length - current.shown.length <= IMMEDIATE_CHARACTERS) {
      cancel();
      show(text);
      return;
    }
    // New snapshots update the existing frame target, without restarting its
    // deadline. Continuous input cannot keep postponing already received text.
    if (current.frame !== null) return;
    current.startedAt = performance.now();
    current.from = current.shown.length;
    const tick = (now: number) => {
      const progress = reduceMotion() ? 1 : Math.max(0, Math.min(1, (now - current.startedAt) / REVEAL_MS));
      const end = current.from + Math.ceil((current.target.length - current.from) * progress);
      show(prefix(current.target, end));
      current.frame = progress < 1 ? requestAnimationFrame(tick) : null;
    };
    current.frame = requestAnimationFrame(tick);
  }, [id, text, streaming]);

  useLayoutEffect(() => () => {
    if (state.current.frame !== null) cancelAnimationFrame(state.current.frame);
  }, []);

  if (!streaming || reduceMotion()) return text;
  return view.id === id && text.startsWith(view.text) ? view.text : initial(text, streaming);
}
