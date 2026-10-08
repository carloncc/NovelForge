/**
 * #1551：safeSlice 必须在截断时不劈开代理对。
 *
 * 这个 bug 的隐蔽之处在于 JS 内部看不出来：落单高位代理能被 JSON.stringify/parse
 * 原样往返，只有在按 UTF-8 落盘时才变成 U+FFFD（"�"）。
 * 所以本测试的核心断言不是「长度对不对」，而是「编码成 UTF-8 再解回来是否逐字相等」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeSlice } from "../src/utils/text";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 落单高位代理 = 代理对被劈开的证据 */
function endsWithLoneHighSurrogate(s: string): boolean {
  if (!s.length) return false;
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdbff;
}

/** 以 UTF-8 往返一次（落单代理会变成 U+FFFD，从而被这里抓住） */
function utf8RoundTrip(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

const ASTRAL = "第1章😀结束🎬终";
const BMP = "第一章风雪夜归人";

function main(): void {
  // ① 纯 BMP：必须与 slice 完全一致（不能改变既有行为）
  for (let n = 0; n <= BMP.length + 2; n++) {
    assert(safeSlice(BMP, n) === BMP.slice(0, n),
      "纯 BMP 文本下 safeSlice 必须等价于 slice，n=" + n + "（#1551）");
  }

  // ② 含增补平面字符：任何 n 都不得留下落单高位代理，且 UTF-8 往返逐字相等
  const bad: string[] = [];
  for (let n = 0; n <= ASTRAL.length + 2; n++) {
    const got = safeSlice(ASTRAL, n);
    if (endsWithLoneHighSurrogate(got)) bad.push("n=" + n + " 留下落单代理");
    if (utf8RoundTrip(got) !== got) bad.push("n=" + n + " UTF-8 往返不等（出现替换字符）");
  }
  assert(bad.length === 0, bad.slice(0, 5).join("；") + "（#1551）");

  // ③ 反面对照：证明这个 n 确实会劈开——否则②是空跑
  const split = ASTRAL.slice(0, 4);
  assert(endsWithLoneHighSurrogate(split),
    "取 n=4 时裸 slice 本应劈开代理对，测试前提不成立（#1551）");
  assert(utf8RoundTrip(split) !== split,
    "取 n=4 时裸 slice 的 UTF-8 往返本应出现替换字符，测试前提不成立（#1551）");
  assert(utf8RoundTrip(split).includes("\uFFFD"), "裸 slice 的产物应含 U+FFFD（#1551）");

  // ④ 修复点本身：同一个 n 下 safeSlice 干净，且只少取一个码元
  const fixed = safeSlice(ASTRAL, 4);
  assert(!endsWithLoneHighSurrogate(fixed), "safeSlice(.,4) 不得留下落单代理（#1551）");
  assert(utf8RoundTrip(fixed) === fixed, "safeSlice(.,4) 的 UTF-8 往返必须相等（#1551）");
  assert(fixed === "第1章", "safeSlice(.,4) 应为 「第1章」，实际 " + JSON.stringify(fixed) + "（#1551）");

  // ⑤ 边界
  assert(safeSlice(BMP, 0) === "", "max=0 应返回空串（#1551）");
  assert(safeSlice(BMP, -3) === "", "max<0 应返回空串（#1551）");
  assert(safeSlice(BMP, 999) === BMP, "max 超过长度应原样返回（#1551）");
  assert(safeSlice("", 5) === "", "空串应返回空串（#1551）");

  // ⑥ 源码契约（#1571 补）：对**用户文本**做限长截断的地方必须用 safeSlice。
  //    extract.ts 的 truncate 截的是小说正文（可能含 emoji），当时漏改；这里钉住。
  const EXTRACT = readFileSync(join(process.cwd(), "src", "core", "extract.ts"), "utf8");
  assert(EXTRACT.includes("safeSlice(text, maxChars)"),
    "extract.ts 的 truncate 必须用 safeSlice（正文可能含 emoji，裸 slice 会劈开代理对）（#1571）");
  assert(!/text\.slice\(0, maxChars\)/.test(EXTRACT),
    "extract.ts 不得残留裸 text.slice(0, maxChars)（#1571）");

  // ⑦ 源码契约（#1572 补）：**喂进 LLM 提示词**的用户文本截断也必须用 safeSlice。
  //    上一轮补了 extract.ts（挑音色用正文）；本轮把同一类里剩下的核心路径补齐——
  //    script.ts 的章节正文（进剧本生成提示词，4000 字）与 images.ts fitImagePrompt 的两处。
  const SCRIPT = readFileSync(join(process.cwd(), "src", "core", "script.ts"), "utf8");
  assert(SCRIPT.includes("safeSlice(chapter.text, 4000)"),
    "script.ts 的章节正文截断必须用 safeSlice（它是用户文本，会进剧本生成提示词）（#1572）");
  assert(!/chapter\.text\.slice\(0, 4000\)/.test(SCRIPT), "script.ts 不得残留裸 chapter.text.slice（#1572）");
  const IMAGES = readFileSync(join(process.cwd(), "src", "core", "images.ts"), "utf8");
  assert(IMAGES.includes("safeSlice(prompt, maxChars)") && IMAGES.includes("safeSlice(tail, maxChars)"),
    "fitImagePrompt 的截断必须用 safeSlice（压缩后的提示词会发往图像 API）（#1572）");
  assert(!/prompt\.slice\(0, maxChars\)/.test(IMAGES), "images.ts 不得残留裸 prompt.slice(0, maxChars)（#1572）");

  console.log("=== safeSlice 代理对安全测试通过（#1551/#1571/#1572：落盘、提示词两条路径的用户文本截断均已纳入）===");
}

main();
