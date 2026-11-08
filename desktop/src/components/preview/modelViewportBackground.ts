/** Paint the viewport's existing computed background; JPEG cannot retain WebGL alpha. */
export function paintModelViewportBackground(context: CanvasRenderingContext2D, mount: HTMLElement, width: number, height: number): void {
  const style = window.getComputedStyle(mount);
  const color = '(#[a-f0-9]+|rgba?\\([^)]*\\))';
  const pattern = new RegExp(`^radial-gradient\\(circle at ([\\d.]+)% ([\\d.]+)%,\\s*${color}\\s+([\\d.]+)%,\\s*${color}\\s+([\\d.]+)%\\)$`, 'i');
  const match = pattern.exec(style.backgroundImage);
  if (match) {
    const x = width * Number(match[1]) / 100;
    const y = height * Number(match[2]) / 100;
    // CSS circle defaults to farthest-corner. Read colors/stops from CSS instead of a second theme palette.
    const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(Number(match[4]) / 100, match[3]!);
    gradient.addColorStop(Number(match[6]) / 100, match[5]!);
    context.fillStyle = gradient;
  } else {
    if (style.backgroundImage && style.backgroundImage !== 'none') throw new Error('无法导出当前模型预览背景');
    context.fillStyle = style.backgroundColor;
  }
  context.fillRect(0, 0, width, height);
}
