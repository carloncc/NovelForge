import { isChapterContentComplete, emptyChapterLight } from "../src/composables/useChapterStatus";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // 无图像项目（关闭「图像」）：只写剧本即视为完成
  const noImage = emptyChapterLight();
  noImage.script = true;
  noImage.imageTotal = 0;
  noImage.imageDone = 0;
  assert(isChapterContentComplete(noImage), "关闭图像时，剧本完成即应判定章节完成");

  // 有图像项目：剧本＋图像齐了才算完成
  const done = emptyChapterLight();
  done.script = true;
  done.imageTotal = 3;
  done.imageDone = 3;
  assert(isChapterContentComplete(done), "剧本＋图像齐应判定完成");

  // 图像未齐 → 未完成
  const partial = emptyChapterLight();
  partial.script = true;
  partial.imageTotal = 3;
  partial.imageDone = 2;
  assert(!isChapterContentComplete(partial), "图像未齐不应判定完成");

  // 只有脚本、但图像缺失（有图像项目）→ 未完成
  const missingImages = emptyChapterLight();
  missingImages.script = true;
  missingImages.imageTotal = 3;
  missingImages.imageDone = 0;
  assert(!isChapterContentComplete(missingImages), "有图像任务但未生成不应判定完成");

  // 无剧本 → 未完成（无论图像）
  const noScript = emptyChapterLight();
  noScript.script = false;
  noScript.imageTotal = 0;
  noScript.imageDone = 0;
  assert(!isChapterContentComplete(noScript), "无剧本不应判定完成");

  // 空灯 → 未完成
  assert(!isChapterContentComplete(emptyChapterLight()), "空章节灯不应判定完成");

  console.log("=== 章节完成判定（含关闭图像）测试通过 ===");
}
main();
