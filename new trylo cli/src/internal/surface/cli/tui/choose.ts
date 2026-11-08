import type { ChoiceRequest } from "./choice.js";
import type { TuiIo } from "./io.js";

/** Line-reader compatibility for scripted surfaces; real TUI uses raw keys. */
export async function choose(io: TuiIo, request: ChoiceRequest): Promise<string | undefined> {
  if (io.choose !== undefined) return io.choose(request);

  io.write(`${request.title}\n`);
  request.items.forEach((item, index) => io.write(`  ${index + 1}. ${item.label}${item.detail === undefined ? "" : ` · ${item.detail}`}\n`));

  for (;;) {
    const answer = await io.readLine("输入编号或 ID（/cancel 返回）： ");
    if (answer === undefined || answer.trim() === "/cancel") return undefined;
    const item = request.items[Number(answer.trim()) - 1] ?? request.items.find(item => item.id === answer.trim());
    if (item !== undefined) return item.id;
    io.write("没有此选项，请重新选择。\n");
  }
}
