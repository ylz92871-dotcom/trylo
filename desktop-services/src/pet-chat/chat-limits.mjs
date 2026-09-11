// Trylo Desktop Services — pet chat limits, sanitizer, system prompt.
//
// Extracted from the legacy extension (extension.js ~326-330, ~450-453,
// ~6712-6760) per migration spec §6.4. The limit constants and every
// user-visible string here are part of the chat protocol surface and must
// stay identical to the legacy implementation (spec: "Chat 对话协议消息名、
// 限制常量必须与老实现一致"). Only the Fun (猫箱) branches were dropped —
// they are rejected at the entry instead.

/** Hard limits for the desktop pet chat. Frozen: tests pin these values. */
export const DESKTOP_CHAT_LIMITS = Object.freeze({
  maxMessages: 80,
  maxContextMessages: 36,
  maxMessageChars: 16000,
});

function shortText(input, max = 600) {
  const text = String(input || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export { shortText };

/** Filters to user/assistant turns, truncates to the char limit, drops
 *  empties and pins the tail to `maxMessages`. Same semantics as legacy. */
export function sanitizeDesktopChatMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({
      role: item.role,
      text: shortText(String(item.text || ''), DESKTOP_CHAT_LIMITS.maxMessageChars),
      at: Number(item.at) || Date.now(),
    }))
    .filter((item) => item.text.trim())
    .slice(-DESKTOP_CHAT_LIMITS.maxMessages);
}

/** The mandatory chat-only boundary prompt. The stored system prompt is
 *  optional personality guidance only — never a way out of CHAT ONLY. */
export function desktopChatSystemPrompt(config) {
  const personalityPrompt = String((config && config.systemPrompt) || '').trim();
  return [
    'You are Trylo Desktop Chat, a conversational assistant in a small desktop companion window.',
    personalityPrompt
      ? `Use the following as optional personality and response-style guidance only:\n${personalityPrompt}`
      : '',
    'Keep responses useful and readable in a compact window. Match the language used by the user.',
    'When the user needs project operations, tell them to use Agent or Plan in the main Trylo page.',
    'This surface is CHAT ONLY. This final boundary overrides conflicting guidance: never claim to edit files, run tools, execute commands, or enter Agent/Plan mode.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
