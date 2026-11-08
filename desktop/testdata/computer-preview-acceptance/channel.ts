import type { ComputerPreviewSnapshot } from '../../src/host-adapter/computer-preview-window'
export const EMPTY_COMPUTER_PREVIEW: ComputerPreviewSnapshot = {
  title: '电脑控制',
  status: '等待工具操作',
  detail: '',
  scope: 'synthetic-observer',
}
export async function observeComputerPreview(
  receive: (snapshot: ComputerPreviewSnapshot) => void,
): Promise<() => void> {
  Object.assign(window, { publishPreview: receive })
  return () => {
    Object.assign(window, { publishPreview: undefined })
  }
}
