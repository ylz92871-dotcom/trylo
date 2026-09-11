// Trylo Work — risk classification for dont_ask (fully auto) mode.
//
// Principle: 完全自动下仅提醒不卡住，特高风险才强阻塞。
// Tool side enforces hard gates; UI decides whether to show a
// blocking ApprovalCard or a non-blocking AutoNotice.

export type RiskLevel = 'low' | 'medium' | 'high';

/** High-risk = always blocks, even in dont_ask. */
export function isHighRiskTool(tool: string, input?: Record<string, unknown>): boolean {
  const t = tool.toLowerCase();
  // office: remove / raw-set / overwrite original
  if (t.startsWith('mcp__trylo-office__')) {
    const cmd = String(input?.['command'] ?? input?.['cmd'] ?? '').toLowerCase();
    if (/^(remove|raw-set|delete)/.test(cmd)) return true;
    // overwrite outside .trylo/out is already gated server-side,
    // but UI still treats it as high-risk for the modal.
    const path = String(input?.['path'] ?? input?.['file_path'] ?? '');
    if (path && !path.replace(/\\/g, '/').includes('.trylo/out/') && /(overwrite|write|save)/.test(cmd)) {
      // heuristic: any write not under .trylo/out is high
      return true;
    }
  }
  // browser: payment / install / external submit — model via tool name
  if (t.startsWith('mcp__trylo-browser__')) {
    // browser is medium by default; high only for explicit risky intents
    return false;
  }
  // computer: only allow-listed 11 tools; high = anything outside or Registry/PowerShell
  if (t.startsWith('mcp__trylo-windows__')) {
    const name = t.split('__').pop() ?? '';
    const allowed = new Set(['screenshot','snapshot','displayinventory','click','type','scroll','move','shortcut','wait','waitfor','app']);
    if (!allowed.has(name)) return true;
  }
  // CAD/EDA (TRYLO-CAD-EDA-TOOL-ADAPTER §7): arbitrary code execution and
  // the delete/clear/overwrite/board-wide families stay HIGH even in
  // dont_ask — the classifier prompts them anyway; this keeps the UI modal.
  if (/^mcp__trylo-(solidworks|autocad|kicad|jlceda|freecad|blender)__/.test(t)) {
    const name = t.split('__').pop() ?? '';
    if (/execute|run_command|run_lisp/.test(name)) return true;
    if (/^(delete|clear|remove|discard|purge|replace|refill|autoroute|download_jlcpcb_database|sch_generate_from|close_documents|construction_clear)/.test(name)) {
      return true;
    }
    return false;
  }
  // generic high-risk keywords
  if (/powershell|registry|process|install|payment|pay|submit/.test(t)) return true;
  return false;
}

export function riskLevelFor(tool: string, input?: Record<string, unknown>): RiskLevel {
  if (isHighRiskTool(tool, input)) return 'high';
  const t = tool.toLowerCase();
  if (t.startsWith('mcp__trylo-office__') && /^(create|add|set|import|batch|generate|write|edit)/.test(String(input?.['command'] ?? ''))) return 'medium';
  if (t.startsWith('mcp__trylo-windows__')) return 'medium';
  if (t.startsWith('mcp__trylo-browser__')) return 'medium';
  if (/^mcp__trylo-(solidworks|autocad|kicad|jlceda|freecad|blender)__/.test(t)) return 'medium';
  return 'low';
}
