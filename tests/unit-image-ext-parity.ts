/**
 * #1539：图片缓存命中的扩展名集合漏了 gif。
 *
 * 命中链死循环：
 *   detectedImageExtension 认得 GIF 字节（0x47 0x49 0x46），withDetectedExt 会把 API 返回的
 *   GIF 改写成 .gif 落盘；下一次 cacheHit(dir, "cg_1_x.png") 精确未命中 → 按 basename 探测
 *   ["png","jpg","jpeg","webp"] → 磁盘上是 .gif，全都找不到 → 重新生成、重新付费。
 *   这正是 cacheHit 注释里写明要解决的那类问题（用户报告「每次都要重新生成」）。
 */
import { IMAGE_EXTS, stripImageExt } from "../src/core/cache";
import { detectedImageExtension } from "../src/core/images";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// GIF89a/87a 的合法 base64 前缀（仅为让字节嗅探器认出 GIF）
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function main(): void {
  // ① 扩展名集合必须含 gif，且与嗅探器可能产出的集合一致
  assert(IMAGE_EXTS.includes("gif"), "IMAGE_EXTS 必须含 gif（#1539）");
  assert(detectedImageExtension(GIF_B64) === "gif", "嗅探器应认出 GIF（#1539）");

  // 嗅探器能产出的每一种扩展名，都必须能被 stripImageExt 剥掉——
  // 否则「按 basename 探测」这一路永远够不到那个文件
  for (const ext of IMAGE_EXTS) {
    assert(stripImageExt("cg_1_scene." + ext) === "cg_1_scene",
      "stripImageExt 剥不掉 ." + ext + "（#1539）");
    assert(stripImageExt("cg_1_scene." + ext.toUpperCase()) === "cg_1_scene",
      "stripImageExt 大小写不敏感失效: ." + ext.toUpperCase() + "（#1539）");
  }

  // ② 非图片后缀不得被剥
  assert(stripImageExt("bg.mp3") === "bg.mp3", "不得剥掉音频扩展名（#1539）");
  assert(stripImageExt("a.png.mp3") === "a.png.mp3", "只剥最后一个扩展名（#1539）");
  assert(stripImageExt("png") === "png", "无扩展名时原样返回（#1539）");
  assert(stripImageExt("scene.png.gif") === "scene.png", "gif 也要能剥（#1539）");

  // ③ basename 探测（cacheHit 的第二路）对 gif 必须成立：
  //    给一个 .png 的任务名、磁盘上却是 .gif 时，去掉扩展名后的候选必须唯一确定
  assert(stripImageExt("cg_1_x.png") === stripImageExt("cg_1_x.gif"),
    "同一资源的 png 与 gif 必须得到同一 basename（#1539）");

  console.log("=== 图片扩展名口径测试通过（#1539：" + IMAGE_EXTS.join("/") + "）===");
}

main();
