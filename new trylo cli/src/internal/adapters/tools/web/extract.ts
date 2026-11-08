/**
 * HTML → text without a parser, on purpose.
 *
 * A real DOM parser would be a dependency, and the contract this serves is
 * small: the model needs the *prose* of a page, not its layout. So the rules
 * are the three that matter and no others —
 *
 *  - `script` and `style` blocks vanish whole, because their text is code and
 *    a model repeating `alert('x')` back is noise at best;
 *  - every remaining tag becomes whitespace, so words glued between `<p>`
 *    boundaries stay separated;
 *  - the six entities that actually appear in prose are decoded; anything else
 *    (`&copy;`, numeric references) is left visibly as written, because a half
 *    -decoded page is worse than an honestly marked one.
 */

const BLOCK_TAGS = /<(script|style)\b[\s\S]*?<\/\1>/gi;
const TAGS = /<[^>]*>/g;
const ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
];

export function htmlToText(html: string): string {
  let text = html.replace(BLOCK_TAGS, " ").replace(TAGS, " ");

  for (const [pattern, replacement] of ENTITIES) {
    text = text.replace(pattern, replacement);
  }

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
