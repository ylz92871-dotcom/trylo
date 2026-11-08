import { promises as fs } from 'node:fs';
import path from 'node:path';
export async function containedPreviewFile(file: string, root: string): Promise<string> {
  const [target, base] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || target.startsWith('\\\\')) throw new Error('文件不在当前项目目录内');
  return target;
}
