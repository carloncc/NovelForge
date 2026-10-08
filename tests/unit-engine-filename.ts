/**
 * #1515：落盘文件名与「引用它的地方」必须完全同名。
 *
 * 背景：copyAssets 用 engineSafeFileName 把 ; | " -" 映射成全角 ；｜‑ 再落盘，
 * 而 cleanConfigValue 此前把它们替换成「空格」。于是 cover;art.png：
 *   磁盘        game/background/cover；art.png
 *   config.txt  Title_img:cover art.png   ← 引擎按 ./game/background/cover art.png 取图 → 404
 * 鉴赏室的 figure/cg/bg/shot/bgm 同样按原始 basename 引用，症状一致（画廊有图、点开 404）。
 *
 * 期望值一律用码点拼出：U+2011 / U+FF1B / U+FF5C 都是不可见字符，
 * 直接在源码里手打正是这类 bug 的温床（错一个码点，测试就悄悄失去意义）。
 */
import { engineSafeFileName, renderConfig } from "../src/core/render";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const NB_HYPHEN = String.fromCharCode(0x2011); // ‑
const FW_SEMI = String.fromCharCode(0xff1b); // ；
const FW_BAR = String.fromCharCode(0xff5c); // ｜

function main(): void {
  const tricky = "cover;art.png";
  const logo = "logo|final.webp";
  const bgm = "battle - night.mp3";
  const long = "x".repeat(120) + ".png";

  // 引擎安全映射本身（; | " -" → 全角/不换行等价物）
  assert(engineSafeFileName(tricky) === "cover" + FW_SEMI + "art.png", "分号应映射为 U+FF1B");
  assert(engineSafeFileName(logo) === "logo" + FW_BAR + "final.webp", "竖线应映射为 U+FF5C");
  assert(
    engineSafeFileName(bgm) === "battle " + NB_HYPHEN + " night.mp3",
    '" -" 应映射为「空格 + U+2011」，且只吃掉连字符本身，前后空格保留',
  );

  // config.txt 的文件类值必须与磁盘同名
  const cfg = renderConfig("书名", "key01", "zh_CN", tricky, bgm, logo);
  const cfgTitleImg = /^Title_img:(.*);$/m.exec(cfg)?.[1];
  const cfgTitleBgm = /^Title_bgm:(.*);$/m.exec(cfg)?.[1];
  const cfgLogo = /^Game_Logo:(.*);$/m.exec(cfg)?.[1];
  assert(cfgTitleImg === engineSafeFileName(tricky), "Title_img 应与磁盘同名");
  assert(cfgTitleBgm === engineSafeFileName(bgm), "Title_bgm 应与磁盘同名");
  assert(cfgLogo === engineSafeFileName(logo), "Game_Logo 应与磁盘同名");

  // 反向断言：分号/竖线都不得被降级成普通空格（那会产生另一个不存在的文件名）
  assert(!cfg.includes("cover art.png"), "分号不得替换成空格");
  assert(!cfg.includes(logo), "竖线不得替换成空格");

  // 1452：文件类值不截断（截断同样指向不存在的路径）
  const cfgLong = renderConfig("书名", "key01", "zh_CN", long);
  assert((/^Title_img:(.*);$/m.exec(cfgLong)?.[1] ?? "").length === long.length, "Title_img 不得被截断");

  // 标题类值仍按原口径清洗并保留 60 字截断
  const titleVal = /^Game_name:(.*);$/m.exec(renderConfig("a;b".repeat(40), "k"))?.[1] ?? "";
  assert(!titleVal.includes(";"), "Game_name 里的分号是配置分隔符，必须清掉");
  assert(titleVal.length <= 60, "Game_name 应保留 60 字截断");

  console.log("=== 引擎素材文件名一致性测试通过（#1515）===");
}

main();
