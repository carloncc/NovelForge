/**
 * 抠图模型注册表（移植自「抠图」项目 src/model-registry.js）。
 * 模型来自 rembg 官方 release，浏览器端用 onnxruntime-web 推理。
 */

export const MODEL_RELEASES_BASE = "https://github.com/danielgatis/rembg/releases/download/v0.0.0";

export interface CutoutModel {
  id: string;
  label: string;
  description: string;
  filename: string;
  sizeMB: number;
  inputSize: number;
  mean: [number, number, number];
  std: [number, number, number];
  md5?: string;
  /** 推理峰值内存超过浏览器 WASM 2GB 上限（如 BiRefNet-Lite），必须 WebGPU 执行，失败不回退 WASM */
  wasmUnsafe?: boolean;
}

export const CUTOUT_MODELS: CutoutModel[] = [
  {
    id: "isnet-anime",
    label: "ISNet 动漫",
    description: "动漫角色 / 立绘抠图，默认推荐",
    filename: "isnet-anime.onnx",
    sizeMB: 168,
    inputSize: 1024,
    mean: [0.485, 0.456, 0.406],
    std: [1, 1, 1],
    md5: "6f184e756bb3bd901c8849220a83e38e",
  },
  {
    id: "isnet-general",
    label: "ISNet 通用",
    description: "人像 / 通用前景（内存占用小，WASM 也能流畅跑）",
    filename: "isnet-general-use.onnx",
    sizeMB: 170,
    inputSize: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    md5: "fc16ebd8b0c10d971d3513d564d01e29",
  },
  {
    id: "birefnet-general-lite",
    label: "BiRefNet 通用轻量",
    description: "BiRefNet-Lite 通用抠图（人像/物体通吃），边缘质量更高；需 WebGPU 且显存充足",
    filename: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    sizeMB: 214,
    inputSize: 1024,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    md5: "4fab47adc4ff364be1713e97b7e66334",
    wasmUnsafe: true,
  },
  {
    id: "u2netp",
    label: "U2-Net 轻量",
    description: "速度快、体积小，适合快速预览",
    filename: "u2netp.onnx",
    sizeMB: 5,
    inputSize: 320,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    md5: "8e83ca70e441ab06c318d82300c84806",
  },
];

export function findCutoutModel(id: string): CutoutModel {
  return CUTOUT_MODELS.find((model) => model.id === id) ?? CUTOUT_MODELS[0];
}

/** 模型远程下载地址（GitHub release） */
export function cutoutModelRemoteUrl(model: CutoutModel): string {
  return `${MODEL_RELEASES_BASE}/${model.filename}`;
}
