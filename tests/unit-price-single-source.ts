import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * #1565：展示用单价必须来自**单一事实来源**。
 *
 * imageStory.ts 原先写死 `IMAGE_YUAN_EACH = 0.3`，并在注释里声称「与 pipeline 的
 * DEFAULT_PRICES.imageYuanEach 同口径」——但那只是**注释里的承诺**，没有任何东西保证它成立。
 * 两处字面量各改各的就会静默漂移，表现为「图片小说页」与「主生成页」对同一批量报出**不同费用**，
 * 而用户正是按这个数字点「继续」的。
 *
 * 与本会话 #1558（两个同名 stableHash 算法不同）是同一类教训：口径一致要靠**结构**保证，
 * 不能靠注释保证。现 imageStory 直接从 DEFAULT_PRICES 取值，不一致在结构上已不可能。
 */
import { DEFAULT_PRICES } from "../src/core/pipeline";
import { IMAGE_YUAN_EACH } from "../src/core/imageStory";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① 两个展示价必须相等（结构上已由派生保证，这里固化住）
  assert(IMAGE_YUAN_EACH === DEFAULT_PRICES.imageYuanEach,
    "展示单价必须等于主管线单价，实际 " + IMAGE_YUAN_EACH + " vs " + DEFAULT_PRICES.imageYuanEach + "（#1565）");

  // ② 反面对照：确认它不再是一份独立的字面量。
  //    做法是把主管线的值改掉后重读——派生实现会跟随，字面量实现不会。
  //    这里用「同一模块内取值」的方式表达：只要 ① 成立且 imageStory 未再定义字面量即可。
  assert(DEFAULT_PRICES.imageYuanEach === IMAGE_YUAN_EACH,
    "双向引用应相等（#1565）");

  // ③ 数值本身仍应是正数（防止有人改成 0 让费用恒显示 0）
  assert(IMAGE_YUAN_EACH > 0, "单价必须为正，实际 " + IMAGE_YUAN_EACH + "（#1565）");
  assert(DEFAULT_PRICES.llmInYuanPer1m > 0 && DEFAULT_PRICES.llmOutYuanPer1m > 0 && DEFAULT_PRICES.ttsYuanPer1mChars > 0,
    "其余单价也应为正（#1565）");

  // ④ 源码契约：imageStory 不得再出现写死的单价字面量
  const SRC = readFileSync(join(process.cwd(), "src", "core", "imageStory.ts"), "utf8");
  assert(!/IMAGE_YUAN_EACH\s*=\s*[0-9]/.test(SRC),
    "imageStory 不得再把 IMAGE_YUAN_EACH 写死成数字字面量（那会让两页费用重新可能漂移）（#1565）");
  assert(SRC.includes("DEFAULT_PRICES.imageYuanEach"),
    "imageStory 的 IMAGE_YUAN_EACH 应派生自 DEFAULT_PRICES.imageYuanEach（#1565）");

  console.log("=== 展示单价单一来源契约通过（#1565：IMAGE_YUAN_EACH = " + IMAGE_YUAN_EACH + " 元/张）===");
}

main();
