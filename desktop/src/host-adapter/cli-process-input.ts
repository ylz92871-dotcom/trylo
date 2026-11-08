import { hostAdapter } from './index'
import { buildUserPrompt } from './control-protocol'

/** Write only to the immutable native id owned by the current new CLI turn. */
export async function sendCliControlLine(processId: string, line: string): Promise<boolean> {
  try {
    await hostAdapter.process.send(processId, line.endsWith('\n') ? line : line + '\n')
    return true
  } catch {
    return false
  }
}

export function sendCliPrompt(processId: string, prompt: string): Promise<boolean> {
  return sendCliControlLine(processId, buildUserPrompt(prompt))
}
