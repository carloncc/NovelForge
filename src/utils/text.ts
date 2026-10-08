/**
 * 文本截断的码元安全工具（#1551）。
 *
 * 背景：`str.slice(0, n)` 按 **UTF-16 码元**计数，n 落在代理对中间时会把一个
 * 增补平面字符（emoji、部分生僻字）劈成两半，留下一个**落单高位代理**。
 *
 * 这个坏串在 JS 内部几乎察觉不到——JSON.stringify 会把它转义成 \uD83D，
 * JSON.parse 还能原样还原。但一旦以 UTF-8 编码写盘（剧本、卡片缓存、项目文件），
 * 落单代理会变成 U+FFFD（"�"）：
 *
 *   "第1章😀结束".slice(0, 4)  ->  "第1章\uD83D"
 *   Buffer.from(..., "utf8")   ->  e7acac31e7aba0efbfbd   ← 末位已是替换字符
 *
 * 即：截断处会凭空多出一个「�」。所以凡是对**用户/模型文本**做限长、且结果会落盘的
 * 地方，都应该走这里。
 */

/**
 * 与 `s.slice(0, max)` 等价，但绝不把代理对劈开。
 *
 * 仅在末位恰好是落单高位代理时少取一个码元（最多丢 1 个字符），
 * 因此对纯 BMP 文本与 `slice` 完全一致，上限也不会因此变大。
 */
export function safeSlice(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  // 0xD800–0xDBFF 是高位代理：出现在末位就说明它的低位伙伴被切掉了
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
