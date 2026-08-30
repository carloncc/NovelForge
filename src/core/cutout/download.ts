/**
 * 抠图模型下载 / 状态查询。
 * - Tauri 桌面版：Rust 命令下载到应用配置目录 models/，模型文件经 model:// 自定义协议供前端 fetch
 * - 浏览器版：dev/preview server 的 /__novelforge/model 中间件下载到 public/models，经 /__novelforge/model/file 读取
 */
import { isTauri, tauri, type CutoutModelStatus } from "../../utils/tauri";
import { cutoutModelRemoteUrl, type CutoutModel } from "./models";

export type { CutoutModelStatus } from "../../utils/tauri";

export const CUTOUT_MODEL_NOT_INSTALLED: CutoutModelStatus = {
  modelId: "",
  state: "idle",
  bytes: 0,
  total: 0,
  error: null,
  installed: false,
};

/** 当前运行时下模型文件的本地可访问地址（供 onnxruntime-web fetch） */
export function cutoutModelLocalUrl(model: CutoutModel): string {
  if (isTauri()) return `model://localhost/${model.filename}`;
  return `/__novelforge/model/file?model=${encodeURIComponent(model.id)}`;
}

export async function cutoutModelStatus(model: CutoutModel): Promise<CutoutModelStatus> {
  try {
    const status = await tauri.cutoutModelStatus(model.id, model.filename);
    return { ...CUTOUT_MODEL_NOT_INSTALLED, ...status, modelId: model.id };
  } catch {
    return { ...CUTOUT_MODEL_NOT_INSTALLED, modelId: model.id };
  }
}

/** 手动下载模型（不自动确认；下载中请轮询 cutoutModelStatus 展示进度） */
export async function downloadCutoutModel(model: CutoutModel): Promise<void> {
  await tauri.cutoutModelDownload({
    modelId: model.id,
    filename: model.filename,
    url: cutoutModelRemoteUrl(model),
    md5: model.md5 ?? "",
  });
}

export async function removeCutoutModel(model: CutoutModel): Promise<void> {
  await tauri.cutoutModelRemove(model.id, model.filename);
}

/**
 * 下载并等待完成（轮询状态）。onProgress 每轮进度回调（bytes/total 单位字节）。
 * 返回最终状态；下载失败抛错。
 */
export async function downloadCutoutModelAndWait(
  model: CutoutModel,
  onProgress?: (status: CutoutModelStatus) => void,
): Promise<CutoutModelStatus> {
  await downloadCutoutModel(model);
  for (;;) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
    const status = await cutoutModelStatus(model);
    onProgress?.(status);
    if (status.installed && status.state === "done") return status;
    if (status.state === "error") throw new Error(status.error ?? "模型下载失败");
    if (status.state === "idle" && status.installed) return status;
  }
}
