let seq = 0;

export function newId(prefix: string, now = Date.now()): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${now.toString(36)}_${seq.toString(36)}_${rand}`;
}

export function sourceHash(parts: readonly string[]): string {
  const input = parts.join('\u001f');
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a:${(h >>> 0).toString(16)}`;
}

export function workspaceIdFromRoot(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const key = /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
  return `ws:${sourceHash([key]).slice(6, 18)}`;
}

export function projectIdFromRoot(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = normalized.split('/').filter(Boolean).pop() ?? 'project';
  return `proj:${name}:${sourceHash([normalized]).slice(6, 14)}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
