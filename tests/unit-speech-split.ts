/**
 * #1545：splitLineForSpeech 必须真的把每段切到 ≤ maxChars。
 *
 * 函数注释承诺「把超长台词切成 ≤maxChars 的若干段」，但最后一步「尾部不足 8 字则并入上一段」
 * 是无条件拼接的：前一段正好切到上限、尾部又只有几个字时，拼出来就是 maxChars+7。
 * TTS 侧按段上限正是靠这个函数兜底，超限段会被整段送去合成。
 */
import { splitLineForSpeech } from "../src/core/render";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 语料：覆盖短句、无标点长句、句号密集、emoji（代理对）、中英标点混排、空串 */
const CORPUS: [string, string][] = [
  ["短句", "他走了进来。"],
  ["空串", ""],
  ["纯空白", "   \n\t "],
  ["单字", "好"],
  ["无标点长串", "甲".repeat(1200)],
  ["句号密集", "甲。".repeat(300)],
  ["中英标点混排", "Hello world. 你好，世界！OK?" .repeat(40)],
  ["emoji 代理对", "\u{1F600}".repeat(300) + "。"],
  ["感叹号问号", "啊！".repeat(200) + "？".repeat(200)],
  ["全角分号", "甲；".repeat(200) + "乙乙乙"],
  ["尾部短片段", "甲".repeat(499) + "。" + "乙乙乙"],
  ["尾部7字", "甲".repeat(499) + "。" + "乙".repeat(7)],
  ["多段加短尾", "甲".repeat(499) + "。" + "乙".repeat(499) + "。" + "丙丙丙"],
  ["换行混入", "甲\n".repeat(600)],
];

function main(): void {
  for (const maxChars of [10, 37, 100, 500, 2000]) {
    for (const [label, text] of CORPUS) {
      const parts = splitLineForSpeech(text, maxChars);
      assert(parts.length > 0, label + "/" + maxChars + "：不得返回空数组（#1545）");
      for (const [i, p] of parts.entries()) {
        // 按码点计：与被测函数一致（emoji/生僻字算 1 个字符）
        assert(
          [...p].length <= maxChars,
          label + "/" + maxChars + "：第 " + i + " 段长 " + [...p].length + " 超出上限 " + maxChars + "（#1545）",
        );
      }
      // 空/纯空白输入的既有约定：返回一个空串而不是空数组
      if (!text.trim()) {
        assert(parts.length === 1 && parts[0] === "", label + "/" + maxChars + "：空白应返回单个空串（#1545）");
      }
    }
  }

  // 不得丢字：把各段原样拼回（去掉段间被 trim 掉的空白）应仍覆盖全部非空白内容
  const t = "甲".repeat(499) + "。" + "乙乙乙";
  assert(splitLineForSpeech(t, 500).join("").replace(/\s+/g, "") === t.replace(/\s+/g, ""),
    "分段不得丢字（#1545）");

  // 确定性：同输入多次调用结果一致
  const a = splitLineForSpeech(CORPUS[5][1], 500).join("|");
  const b = splitLineForSpeech(CORPUS[5][1], 500).join("|");
  assert(a === b, "同输入必须得到同输出（#1545）");

  // 仍在 maxChars 以内时必须保持单段（不能因为修复就过度切分）
  assert(splitLineForSpeech("短句。", 500).length === 1, "短句应仍为单段（#1545）");
  assert(splitLineForSpeech("甲".repeat(500), 500).length === 1, "恰好等长应仍为单段（#1545）");

  // #1545 契约钉死：长度按**码点**计。这条不是冗余——只有钉住段数，才能区分
  // 「按码点切」与「按 UTF-16 码元切」：300 个 emoji + 上限 37，前者 9 段、后者 17 段，
  // 两者的每段码点数都 <=37，光看长度不变量区分不出来。
  {
    const emoji = "\u{1F600}".repeat(300) + "。";
    const parts = splitLineForSpeech(emoji, 37);
    const cp = (x: string): number => [...x].length;
    assert(parts.length === Math.ceil(301 / 37),
      "300 emoji + 句号、上限 37 应切出 " + Math.ceil(301 / 37) + " 段，实为 " + parts.length + "（#1545 码点口径）");
    assert(cp(parts.join("")) === 301, "不得丢字（#1545）");
    assert(parts.every((p) => cp(p) <= 37), "每段码点数须 <=37（#1545）");
  }

  console.log("=== 台词分段长度不变量测试通过（#1545：每段恒 <= maxChars，按码点计）===");
}

main();
