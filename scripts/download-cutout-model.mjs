/**
 * 命令行下载 AI 抠图模型（浏览器版路径：写入 public/models/）。
 * 用法：node scripts/download-cutout-model.mjs [modelId]
 * 环境变量：ISNET_MODEL_URL 覆盖下载源（镜像）。
 */
import { installModel } from "./web-model-downloader.mjs";
import { CUTOUT_MODELS, findCutoutModel, cutoutModelRemoteUrl } from "../src/core/cutout/models";

const requested = process.argv[2];
const model = findCutoutModel(requested ?? "");
if (requested && requested !== model.id) {
  console.error(`未知模型：${requested}。可选：${CUTOUT_MODELS.map((item) => item.id).join(", ")}`);
  process.exit(1);
}
if (!requested) {
  console.log(`未指定模型，默认使用 ${model.id}。可选：${CUTOUT_MODELS.map((item) => item.id).join(", ")}`);
}

console.log(`[download-cutout-model] 开始下载模型 ${model.id}（${model.filename}，约 ${model.sizeMB} MB）`);

try {
  const startedAt = Date.now();
  const { destination } = await installModel({
    filename: model.filename,
    url: cutoutModelRemoteUrl(model),
    md5: model.md5 ?? "",
  });
  console.log(`\n下载完成。已保存到 ${destination}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} s）`);
} catch (error) {
  console.error(`\n下载失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
