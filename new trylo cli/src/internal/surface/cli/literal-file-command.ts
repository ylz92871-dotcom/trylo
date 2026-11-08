export type LiteralFileCommand = { readonly path: string; readonly content: string };

/** A complete human command with one relative path and quoted literal text.
 * Quoted examples, conditionals, code blocks and additional actions never match.
 * Filesystem authority remains with the normal tools and workspace sandbox.
 */
export function literalFileCommand(text: string): LiteralFileCommand | undefined {
  if (text.length > 8_500) return undefined;

  const match = /^(?:请)?(?:生成|创建|写入)\s+([^\s，,：:;；“”"'`]+)(?:\s+文件)?[，,]\s*内容(?:只有|为|是)[“"]([^“”"\r\n]{0,8192})[”"][，,。.]?(?:不要存用户记忆[。.]?)?$/u.exec(text.trim());
  if (match === null) return undefined;

  const file = match[1]!;
  if (file.length > 200 || !/^[\p{L}\p{N}_./-]+$/u.test(file) || file.startsWith("/") || file.includes("\\")) return undefined;

  const segments = file.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." || /[. ]$/u.test(part)
    || /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(part))) return undefined;

  return { path: file, content: match[2]! };
}
