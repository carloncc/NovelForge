/**
 * AI 抠图编排（移植自「抠图」项目 app.js 的推理/合成流程）：
 * 输入 base64 图片 → 选模型推理 mask → 应用透明通道（可选 despill 去色溢）→ 输出透明 PNG base64。
 * 运行时按模型懒加载并复用；onnxruntime-web 首次推理才加载。
 */
import { decontaminatePixels, estimateBackgroundColor } from "./despill";
import { CutoutRuntime, ModelNotInstalledError } from "./runtime";
import { findCutoutModel } from "./models";
import { cutoutModelLocalUrl } from "./download";

export * from "./models";
export * from "./download";
export { ModelNotInstalledError } from "./runtime";

export interface AiCutoutResult {
  dataB64: string;
  method: "ai";
  backend: "webgpu" | "wasm";
  coverage: number;
}

export interface AiCutoutOptions {
  /** 边缘去色（去背景色边），默认 true */
  despill?: boolean;
}

let sharedRuntime: CutoutRuntime | null = null;
let sharedRuntimeModelId: string | null = null;

async function getRuntime(modelId: string): Promise<CutoutRuntime> {
  const model = findCutoutModel(modelId);
  if (sharedRuntime && sharedRuntimeModelId === model.id) return sharedRuntime;
  await sharedRuntime?.dispose();
  const runtime = new CutoutRuntime({ model, modelUrl: cutoutModelLocalUrl(model) });
  sharedRuntime = runtime;
  sharedRuntimeModelId = model.id;
  await runtime.load();
  return runtime;
}

function decodeImage(dataB64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败，请检查文件是否损坏"));
    image.src = `data:image/png;base64,${dataB64}`;
  });
}

/**
 * 用指定模型抠出透明底 PNG。失败抛错（模型未安装 / 识别异常 / 推理失败），
 * 调用方自行降级（如回退色度键）。
 */
export async function aiCutoutImage(
  dataB64: string,
  modelId: string,
  options: AiCutoutOptions = {},
): Promise<AiCutoutResult> {
  const runtime = await getRuntime(modelId);
  const image = await decodeImage(dataB64);
  const result = await runtime.predictMask(image);
  if (result.metrics.empty || result.metrics.full) {
    throw new Error("自动识别结果异常（未识别出主体），请更换图片或模型");
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);

  if (options.despill ?? true) {
    const pixels = context.getImageData(0, 0, width, height);
    const background = estimateBackgroundColor(pixels.data, result.alpha, width, height);
    if (background) {
      decontaminatePixels(pixels.data, result.alpha, width, height, background);
      context.putImageData(pixels, 0, 0);
    }
  }

  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext("2d")!;
  const maskImage = maskContext.createImageData(width, height);
  for (let index = 0; index < result.alpha.length; index += 1) {
    maskImage.data[index * 4] = 255;
    maskImage.data[index * 4 + 1] = 255;
    maskImage.data[index * 4 + 2] = 255;
    maskImage.data[index * 4 + 3] = result.alpha[index];
  }
  maskContext.putImageData(maskImage, 0, 0);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(mask, 0, 0);

  const dataUrl = canvas.toDataURL("image/png");
  return { dataB64: dataUrl.split(",")[1] ?? "", method: "ai", backend: result.backend, coverage: result.metrics.coverage };
}
