import type { ToolMessage } from './types';

const VERBS: Readonly<Record<string, string>> = {
  read: '读取', grep: '查找', glob: '查找', edit: '修改', multiedit: '修改',
  notebookedit: '修改', notebook_edit: '修改', edit_file: '修改', apply_patch: '修改', applypatch: '修改', write: '写入', write_file: '写入', bash: '执行',
  task: '委派', webfetch: '读取网页', websearch: '搜索网页',
  image_generate: '生成图片', video_generate: '创建视频任务', video_get_result: '获取视频',
  listmcpresourcestool: '读取资源列表', readmcpresourcetool: '读取资源',
};

export function toolEventVerb(tool: string): string {
  return VERBS[tool.toLowerCase()] ?? tool.split('__').at(-1) ?? tool;
}

export function toolEventStatus(status: ToolMessage['status']): string {
  return { pending: '待执行', running: '执行中', done: '已完成', error: '失败', interrupted: '已中断' }[status];
}

export function toolEventTarget(message: ToolMessage): string {
  const input = message.input;
  const value = input?.['file_path'] ?? input?.['path'] ?? input?.['command'] ?? input?.['url'];
  return typeof value === 'string' ? value : message.summary;
}

export function toolEventTargetLabel(message: ToolMessage): string {
  const target = toolEventTarget(message);
  return /^(read|edit|write|multiedit|notebookedit|notebook_edit)$/i.test(message.tool)
    ? target.replace(/\\/g, '/').split('/').at(-1) ?? target
    : target === '{}' ? '' : target;
}
