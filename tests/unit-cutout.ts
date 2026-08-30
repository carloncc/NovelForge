/**
 * 移植自「抠图」项目的抠图核心模块单元测试：
 * 模型注册表 / letterbox 几何 / mask 统计 / 边缘去色溢。
 */
import { CUTOUT_MODELS, findCutoutModel, cutoutModelRemoteUrl } from "../src/core/cutout/models";
import { containSize, maskMetrics } from "../src/core/cutout/mask";
import { decontaminatePixels, estimateBackgroundColor } from "../src/core/cutout/despill";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // 模型注册表
  assert(CUTOUT_MODELS.length >= 4, "应包含至少 4 个模型（isnet-anime/isnet-general/birefnet/u2netp）");
  const anime = findCutoutModel("isnet-anime");
  assert(anime.label === "ISNet 动漫", "默认模型应为 ISNet 动漫");
  assert(findCutoutModel("unknown-id").id === CUTOUT_MODELS[0].id, "未知模型应回退默认");
  assert(cutoutModelRemoteUrl(anime).includes(anime.filename), "远程地址应包含文件名");
  assert(anime.inputSize === 1024 && anime.mean.length === 3, "模型预处理参数应齐全");

  // letterbox 几何：宽图
  const fit = containSize(1920, 1080, 1024);
  assert(fit.scaledWidth === 1024 && fit.scaledHeight === 576, "16:9 应缩放为 1024x576");
  assert(fit.offsetX === 0 && fit.offsetY === Math.floor((1024 - 576) / 2), "垂直居中偏移");

  // mask 统计
  assert(maskMetrics([]).empty, "空 mask 应判 empty");
  assert(maskMetrics(new Uint8ClampedArray(100).fill(255)).full, "全不透明应判 full");
  assert(!maskMetrics(new Uint8ClampedArray(100).fill(128)).empty, "半透明不应判 empty");

  // 边缘背景色估计：50% 边缘为纯绿背景（mask 全透明），中心为前景
  const w = 64;
  const h = 64;
  const px = new Uint8ClampedArray(w * h * 4);
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const inside = x > 8 && x < w - 8 && y > 8 && y < h - 8;
      alpha[i] = inside ? 255 : 0;
      if (inside) {
        px[i * 4] = 0; px[i * 4 + 1] = 0; px[i * 4 + 2] = 0; px[i * 4 + 3] = 255;
      } else {
        px[i * 4] = 0; px[i * 4 + 1] = 255; px[i * 4 + 2] = 0; px[i * 4 + 3] = 255;
      }
    }
  }
  const bg = estimateBackgroundColor(px, alpha, w, h);
  assert(bg !== null, "均匀绿色背景应能估计出背景色");
  if (bg) {
    assert(bg[0] < 30 && bg[1] > 200 && bg[2] < 30, "背景色应为纯绿");
  }

  // 去色溢：半透明像素颜色 = 前景 * α + 背景 * (1 - α)，反解后应还原前景
  const testPx = new Uint8ClampedArray(w * h * 4).fill(0);
  const testAlpha = new Uint8ClampedArray(w * h).fill(0);
  const t = 0.5; // α
  const fg = [200, 30, 30] as const;
  const bgc = [0, 255, 0] as const;
  for (let i = 0; i < w * h; i += 1) {
    testAlpha[i] = Math.round(t * 255);
    testPx[i * 4] = Math.round(fg[0] * t + bgc[0] * (1 - t));
    testPx[i * 4 + 1] = Math.round(fg[1] * t + bgc[1] * (1 - t));
    testPx[i * 4 + 2] = Math.round(fg[2] * t + bgc[2] * (1 - t));
    testPx[i * 4 + 3] = 255;
  }
  decontaminatePixels(testPx, testAlpha, w, h, [0, 255, 0]);
  const sample = testPx[0];
  assert(Math.abs(sample - fg[0]) <= 3, `去色溢后红色通道应接近 ${fg[0]}，实际 ${sample}`);
  console.log("=== 抠图核心模块测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
