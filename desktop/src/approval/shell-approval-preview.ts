import type { ApprovalPreview } from './approval-preview';

/** Show every admitted operation, rather than lending the first command's
 * approval to an unseen receiver, later step or file publication. */
export function shellApprovalPreview(input: Readonly<Record<string, unknown>>, title: string, defaultCwd?: string): ApprovalPreview | undefined {
  if (typeof input.command !== 'string' || !input.command) return undefined;
  const commands = [input.command];
  if (typeof input.pipeTo === 'string') commands.push(`管道接收命令：\n${input.pipeTo}`);
  if (Array.isArray(input.steps)) input.steps.forEach((step, index) => {
    commands.push(`后续命令 ${index + 1}：\n${typeof step === 'string' ? step : '[无效命令参数]'}`);
  });
  const details = [
    ...(input.runInBackground === true ? ['后台运行'] : []),
    ...(typeof input.stdoutFile === 'string' ? [`成功后保存标准输出：${input.stdoutFile}`] : []),
    ...(typeof input.timeoutMs === 'number' ? [`超时：${input.timeoutMs} 毫秒`] : []),
  ];
  const cwd = typeof input.cwd === 'string' ? input.cwd : defaultCwd;
  return { kind: 'command', title, command: commands.join('\n\n'),
    ...(cwd === undefined ? {} : { cwd }), ...(details.length === 0 ? {} : { reason: details.join('；') }) };
}
