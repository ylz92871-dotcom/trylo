/** Let React commit the sent bubble and let the browser paint it before
 * synchronous learning/profile preparation occupies the renderer again.
 * The fallback also progresses when an unfocused WebView throttles frames. */
export function yieldForSendFeedback(): Promise<void> {
  return new Promise((resolve) => {
    let secondFrame: number | undefined
    const finish = () => {
      clearTimeout(fallback)
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
      resolve()
    }
    const fallback = setTimeout(finish, 50)
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(finish)
    })
  })
}
