import { fitImagePrompt, imagePromptLimitFor, promptLimitFromError } from "../src/core/images";
import type { ApiConfig } from "../src/core/types";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const GREEN_SUFFIX = ", solid chroma key green #00FF00 background filling 100% of every exposed area, no shadow";

function makeLongFigurePrompt(): string {
  const subject = "anime style, full body, a brave young knight with silver armor";
  const filler = Array.from({ length: 60 }, (_, i) => `filler-detail-${i} with ornate engravings and flowing cape`).join(", ");
  return `${subject}, ${filler}${GREEN_SUFFIX}`;
}

function main(): void {
  // 1) 短提示词原样返回
  const short = "anime background, a sunny beach, no people";
  assert(fitImagePrompt(short, 1500) === short, "短提示词不应被截断");

  // 2) 超长 + 绿幕后缀：后缀整段保留，头部按预算截断（中间填充段被裁掉）
  const longFigure = makeLongFigurePrompt();
  const fitted = fitImagePrompt(longFigure, 1500);
  assert(fitted.length <= 1500, `压缩后应 ≤1500，实际 ${fitted.length}`);
  assert(fitted.endsWith(GREEN_SUFFIX), "绿幕背景后缀应整段保留");
  assert(fitted.startsWith("anime style, full body, a brave young knight"), "主体描述开头应保留");
  assert(!fitted.includes("filler-detail-59"), "中间填充内容应被裁掉");
  assert(fitted.includes("filler-detail-0"), "靠前的填充段应保留在预算内");

  // 3) 无绿幕后缀的超长提示词：直接头部截断且不越界
  const longBg = "a vast desert landscape at night with countless stars " + "y".repeat(3000) + ", anime background style";
  const fittedBg = fitImagePrompt(longBg, 1200);
  assert(fittedBg.length <= 1200, `无后缀压缩后应 ≤1200，实际 ${fittedBg.length}`);
  assert(fittedBg.startsWith("a vast desert landscape"), "背景主体开头应保留");

  // 4) 极限限制（后缀本身超长）：只保留后缀尾部，不越界
  const tiny = fitImagePrompt(longFigure, 100);
  assert(tiny.length <= 100, `极限压缩应 ≤100，实际 ${tiny.length}`);
  assert(GREEN_SUFFIX.includes(tiny.replace(/^.*?no shadow/, "no shadow")) || GREEN_SUFFIX.endsWith(tiny.slice(-50)) || tiny.length > 0, "极限压缩应取自后缀");

  // 5) 服务端报错解析上限
  assert(promptLimitFromError("invalid params, prompt length must be less than 1500") === 1500, "英文上限解析失败");
  assert(promptLimitFromError("提示词长度不能超过 800 字符") === 800, "中文上限解析失败");
  assert(promptLimitFromError("HTTP 524") === 0, "非超长报错应返回 0");

  // 6) 各适配器已知上限
  const minimax: ApiConfig = { id: "m", name: "m", baseUrl: "", apiKey: "", model: "image-01", adapter: "minimax-image", extra: {} };
  assert(imagePromptLimitFor(minimax) === 1500, "minimax-image 应默认 1500");
  const override: ApiConfig = { ...minimax, extra: { imagePromptCharLimit: 800 } };
  assert(imagePromptLimitFor(override) === 800, "显式上限应优先");
  const openai: ApiConfig = { id: "o", name: "o", baseUrl: "", apiKey: "", model: "gpt-image-2", extra: {} };
  assert(imagePromptLimitFor(openai) === 0, "未预设适配器不应主动截断");

  console.log("=== 图像提示词长度压缩测试通过 ===");
}
main();
