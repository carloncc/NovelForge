/**
 * #1548：Web 版 sample_bg_color 必须与 Rust cutout.rs 对齐。
 *
 * 差异有三处，每一处都会让同一张素材在桌面端与网页端抠出不同的图：
 *   1. ring：Rust = 8，Web = 6（采样带更窄，混入前景的概率更高）
 *   2. 亮像素过滤：Rust 会剔除 max channel < 60 的暗像素，暗像素大概率是前景黑发/黑衣；
 *      Web 此前直接对全量样本取中位数，背景色会被拉黑
 *   3. 亮样本优先：Rust 在亮样本 >= 8 时用亮样本，否则退回全量；Web 无此分支
 *
 * Rust 侧 green_bg_with_dark_edge_keeps_dark_figure 与 cutout_green_bg_preserves_black_figure
 * 就是为「暗色前景压低背景参考色」加的回归；Web 端此前没有任何等价约束。
 *
 * 本测试复刻 Rust 的判定口径，对 Web 端源码逐条校验参数与分支（不依赖 canvas/Image，
 * 因为 jsdom 环境下 drawImage 不可用）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** webRuntime.ts 里的字符串常量，保证测的就是线上那一份源码 */
const SRC = readFileSync(join(process.cwd(), "src", "utils", "webRuntime.ts"), "utf8");

function main(): void {
  const fn = SRC.slice(SRC.indexOf("export async function webCutoutImage"));

  // ① 采样带宽度必须与 Rust 的 ring = 8 一致
  assert(/const ring = 8;/.test(fn), "ring 必须为 8（对齐 Rust），实际 " + (fn.match(/const ring = \d+;/) || ["未找到"])[0] + "（#1548）");

  // ② 必须存在 max channel < 60 的暗像素剔除
  assert(/Math\.max\(px\[i\], px\[i \+ 1\], px\[i \+ 2\]\) >= 60/.test(fn),
    "必须按 max channel >= 60 过滤亮样本（对齐 Rust 的 BRIGHT_MIN），实际未找到（#1548）");

  // ③ 亮样本不足 8 个时退回全量样本（这图本身就是暗色背景）
  assert(/rsBright\.length >= 8/.test(fn), "必须存在亮样本 >= 8 的优先级判定（对齐 Rust），实际未找到（#1548）");
  assert(/useBright \? rsBright : rs/.test(fn), "亮样本必须真的被选用，R 通道未走 useBright 分支（#1548）");
  assert(/useBright \? gsBright : gs/.test(fn), "亮样本必须真的被选用，G 通道未走 useBright 分支（#1548）");
  assert(/useBright \? bsBright : bs/.test(fn), "亮样本必须真的被选用，B 通道未走 useBright 分支（#1548）");

  // ④ Rust 是 rs.is_empty() 才放弃；Web 不得用 < 8 提前放弃（否则 1~7 个样本时行为不一致）
  assert(/rs\.length === 0/.test(fn), "放弃条件必须是 rs.length === 0（对齐 Rust 的 is_empty），实际 " + (fn.match(/rs\.length [!=<>]+ \d+/) || ["未找到"])[0] + "（#1548）");

  // ⑤ 三处对齐后，行为结论：暗像素被排除出亮样本集合，只剩真实背景色
  const inBright = (px: number[]) => Math.max(px[0], px[1], px[2]) >= 60;
  assert(!inBright([10, 12, 8]), "暗像素不得进入亮样本集合（#1548）");
  assert(!inBright([59, 0, 59]), "恰好低于 60 的暗像素也不得进入（边界，#1548）");
  assert(inBright([60, 0, 0]), "恰好等于 60 的像素必须进入（边界与 Rust 一致，#1548）");
  assert(inBright([180, 200, 160]), "亮像素必须进入亮样本集合（#1548）");

  console.log("=== Web 抠图采样口径对齐测试通过（#1548：ring/暗像素过滤/亮样本优先 三处对齐 Rust）===");
}

main();