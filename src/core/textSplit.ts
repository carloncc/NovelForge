/** 按字符预算在段落边界切分长文本（无损覆盖：chunks.join("") === 原文）。
 *  提取（extractAgent）与翻译（translate）共用；旧位置在 extractAgent 内，翻译复用后抽为独立模块。 */
export function splitNovelForAgent(novelText: string, budget: number): string[] {
  const chunks: string[] = [];
  const sep = "\n\n";
  const budgetSafe = Math.max(100, budget);
  let start = 0;
  while (start < novelText.length) {
    let end = Math.min(start + budgetSafe, novelText.length);
    if (end < novelText.length) {
      const boundary = novelText.lastIndexOf(sep, end);
      if (boundary > start + budgetSafe / 2) end = boundary;
    }
    chunks.push(novelText.slice(start, end));
    start = end;
  }
  if (!chunks.length) chunks.push("");
  return chunks;
}
