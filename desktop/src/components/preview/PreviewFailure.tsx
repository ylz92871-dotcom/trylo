import type { ReactElement, ReactNode } from 'react';

export function previewErrorMessage(raw: string): string {
  if (/ENOENT|NotFound|no such file|file not found/i.test(raw)) return '找不到文件，它可能已被移动或删除。';
  if (/EACCES|EPERM|PermissionDenied|access denied|拒绝访问/i.test(raw)) return '没有权限读取此文件，请检查文件访问权限。';
  if (/InvalidPDFException|Invalid PDF structure/i.test(raw)) return 'PDF 无法解析，文件可能损坏或格式不正确。';
  if (/PasswordException|password.protected/i.test(raw)) return '此文件受密码保护，请使用外部应用打开。';
  return raw;
}

/** Preserve diagnostics while keeping common failures understandable. */
export function PreviewFailure({ error, children }: { error: string; children?: ReactNode }): ReactElement {
  const message = previewErrorMessage(error);
  return <div className="preview__empty" role="alert">
    <p>{message}</p>
    {message !== error && <details className="preview__error-details"><summary>错误详情</summary><pre>{error}</pre></details>}
    {children}
  </div>;
}
