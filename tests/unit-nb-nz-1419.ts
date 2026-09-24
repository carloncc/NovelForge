/**
 * #1419 faceComposite 死开关文案回归守卫。
 * faceComposite/faceCompositeFallback 全链无启用入口（ImageTask.faceComposite 无写入点），
 * 旧文案却指引用户「开启 faceCompositeFallback 回退整张生成」——指向不存在的开关。
 * 本测试锁定 faceComposite.ts 不再出现该误导指引，并明确说明能力未开放。
 * 注：faceRig.ts 的同类文案不在本次改动白名单内，另见交付说明「剩余转交」。
 */
import { readFileSync } from "node:fs";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const src = readFileSync(new URL("../src/core/faceComposite.ts", import.meta.url), "utf8");

assert(
  !src.includes("开启 faceCompositeFallback"),
  "faceComposite.ts 不应再指引用户开启不存在的 faceCompositeFallback 开关",
);
assert(
  !src.includes("或为任务开启 faceCompositeFallback"),
  "faceComposite.ts 不应再出现「为任务开启 faceCompositeFallback」指引",
);
assert(
  src.includes("该能力当前未在界面开放"),
  "faceComposite.ts 应如实说明该能力当前未开放入口",
);

console.log("=== #1419 faceComposite copy guard tests passed ===");
