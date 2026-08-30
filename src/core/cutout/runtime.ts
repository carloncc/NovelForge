/**
 * AI 抠图运行时（移植自「抠图」项目 src/isnet-runtime.js，改用 ESM 引入 onnxruntime-web）。
 * - 默认 WASM 单线程执行（非跨源隔离页面无 SharedArrayBuffer）
 * - 有 WebGPU 时优先 WebGPU；失败自动回退 WASM（wasmUnsafe 模型除外）
 * - onnxruntime-web 采用动态 import：首次推理才加载，避免打进主包
 */
import { containSize, maskMetrics, type MaskMetrics } from "./mask";
import { findCutoutModel, type CutoutModel } from "./models";

export class ModelNotInstalledError extends Error {
  constructor(details = "缺少本地 AI 抠图模型") {
    super(`AI 抠图模型尚未安装：${details}`);
    this.name = "ModelNotInstalledError";
  }
}

function describeError(error: unknown): Record<string, string | undefined> {
  const err = error as Error & { cause?: unknown; code?: unknown };
  const cause = err.cause instanceof Error ? err.cause : undefined;
  return {
    name: err.name,
    message: err.message,
    code: typeof err.code === "string" ? err.code : undefined,
    cause: cause ? `${cause.name}: ${cause.message}` : undefined,
  };
}

function letterboxCanvas(image: HTMLImageElement, size: number): { context: CanvasRenderingContext2D; fit: ReturnType<typeof containSize> } {
  const fit = containSize(image.naturalWidth, image.naturalHeight, size);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, fit.offsetX, fit.offsetY, fit.scaledWidth, fit.scaledHeight);
  return { context, fit };
}

function imageTensor(
  ort: typeof import("onnxruntime-web"),
  context: CanvasRenderingContext2D,
  size: number,
  mean: [number, number, number],
  std: [number, number, number],
) {
  const pixels = context.getImageData(0, 0, size, size).data;
  const values = new Float32Array(3 * size * size);
  for (let index = 0; index < size * size; index += 1) {
    values[index] = (pixels[index * 4] / 255 - mean[0]) / std[0];
    values[size * size + index] = (pixels[index * 4 + 1] / 255 - mean[1]) / std[1];
    values[size * size * 2 + index] = (pixels[index * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return new ort.Tensor("float32", values, [1, 3, size, size]);
}

function minMaxToAlpha(values: Float32Array | number[]): Uint8ClampedArray {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const span = maximum - minimum || 1;
  const alpha = new Uint8ClampedArray(values.length);
  for (let index = 0; index < values.length; index += 1) {
    alpha[index] = Math.round(Math.min(1, Math.max(0, (values[index] - minimum) / span)) * 255);
  }
  return alpha;
}

export interface CutoutMaskResult {
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  metrics: MaskMetrics;
  backend: "webgpu" | "wasm";
}

export interface CutoutRuntimeOptions {
  model?: CutoutModel;
  modelUrl?: string;
}

export class CutoutRuntime {
  readonly model: CutoutModel;
  private readonly modelUrl: string;
  private session: import("onnxruntime-web").InferenceSession | null = null;
  private backend: "webgpu" | "wasm" | null = null;
  private wasmFallbackTried = false;

  constructor({ model, modelUrl }: CutoutRuntimeOptions = {}) {
    this.model = model ?? findCutoutModel("isnet-anime");
    this.modelUrl = modelUrl ?? `/models/${this.model.filename}`;
  }

  get backendName(): string | null {
    return this.backend;
  }

  async load(): Promise<this> {
    if (this.session) return this;
    // 模型资产预检：未安装时给出明确错误（不触发浏览器 404 长等待）
    await this.assertModelAsset();
    const ort = await this.importOrt();
    ort.env.wasm.wasmPaths = "/onnx/";
    // 非跨源隔离页面（默认的 localhost/静态托管都没有 COOP/COEP 头）无法使用
    // SharedArrayBuffer，多线程 WASM 会失败并回退单线程：显式设为 1，避免告警与隐患
    if (typeof window !== "undefined" && !window.crossOriginIsolated) {
      ort.env.wasm.numThreads = 1;
    }
    let backend: "webgpu" | "wasm" = "wasm";
    // wasmUnsafe 模型（如 BiRefNet-Lite）推理内存超过浏览器 WASM 2GB 上限：
    // 不能混用 wasm 执行器（未覆盖算子会掉到 wasm 撑爆 2GB），必须纯 WebGPU 全速执行。
    let providers: ("webgpu" | "wasm")[] = this.model.wasmUnsafe ? ["webgpu"] : ["webgpu", "wasm"];
    let adapterAvailable = false;
    try {
      interface NavigatorWithGpu extends Navigator {
        gpu?: { requestAdapter(): Promise<unknown> };
      }
      const gpuNavigator = navigator as NavigatorWithGpu;
      if (gpuNavigator.gpu) {
        const adapter = await gpuNavigator.gpu.requestAdapter();
        adapterAvailable = Boolean(adapter);
        if (adapter) {
          providers = this.model.wasmUnsafe ? ["webgpu"] : ["webgpu", "wasm"];
          backend = "webgpu";
        }
      }
    } catch {
      adapterAvailable = false;
    }
    if (this.model.wasmUnsafe && !adapterAvailable) {
      throw new Error(
        `模型「${this.model.label}」必须使用 WebGPU 执行（推理内存超出浏览器 WASM 上限）。当前环境未提供 WebGPU，请改用「ISNet 通用」或「ISNet 动漫」模型。`,
      );
    }
    try {
      this.session = await ort.InferenceSession.create(this.modelUrl, { executionProviders: providers });
    } catch (error) {
      if (providers.length > 1) {
        // WebGPU 创建失败 → 回退 WASM
        this.session = await ort.InferenceSession.create(this.modelUrl, { executionProviders: ["wasm"] });
        backend = "wasm";
      } else {
        throw new Error(`模型会话创建失败：${describeError(error).message ?? String(error)}`);
      }
    }
    this.backend = backend;
    return this;
  }

  private async assertModelAsset(): Promise<void> {
    // Tauri model:// 自定义协议由 Rust 端处理：请求会立即失败，无需 HEAD 预检
    if (this.modelUrl.startsWith("model://")) return;
    let response: Response;
    try {
      response = await fetch(this.modelUrl, { method: "HEAD" });
    } catch {
      throw new ModelNotInstalledError(this.modelUrl);
    }
    if (!response.ok) throw new ModelNotInstalledError(this.modelUrl);
  }

  private async importOrt(): Promise<typeof import("onnxruntime-web")> {
    try {
      return await import("onnxruntime-web");
    } catch (error) {
      throw new Error(`onnxruntime-web 加载失败：${describeError(error).message ?? String(error)}`);
    }
  }

  async predictMask(image: HTMLImageElement): Promise<CutoutMaskResult> {
    if (!this.session) throw new ModelNotInstalledError();
    try {
      return await this.runInference(image);
    } catch (error) {
      if (this.backend === "webgpu" && !this.wasmFallbackTried) {
        this.wasmFallbackTried = true;
        if (this.model.wasmUnsafe) {
          throw new Error(
            `模型「${this.model.label}」推理需要约 4GB 内存，当前设备的 WebGPU 无法完成（已禁用 WASM 回退以避免内存溢出）。请改用「ISNet 通用」或「ISNet 动漫」模型。`,
          );
        }
        const ort = await this.importOrt();
        this.session = await ort.InferenceSession.create(this.modelUrl, { executionProviders: ["wasm"] });
        this.backend = "wasm";
        return this.runInference(image);
      }
      throw error;
    }
  }

  private async runInference(image: HTMLImageElement): Promise<CutoutMaskResult> {
    if (!this.session) throw new ModelNotInstalledError();
    const ort = await this.importOrt();
    const { context, fit } = letterboxCanvas(image, this.model.inputSize);
    const inputName = this.session.inputNames[0];
    const tensor = imageTensor(ort, context, this.model.inputSize, this.model.mean, this.model.std);
    const output = await this.session.run({ [inputName]: tensor });
    const maskTensor = output[this.session.outputNames[0]];
    const dims = maskTensor.dims;
    const width = dims[dims.length - 1] ?? 0;
    const height = dims[dims.length - 2] ?? 0;
    const data = maskTensor.data as unknown as Float32Array | number[];
    const raw = typeof (data as Float32Array).subarray === "function"
      ? (data as Float32Array).subarray(0, width * height)
      : (data as number[]).slice(0, width * height);
    const alpha = minMaxToAlpha(raw);
    const maskCanvas = this.maskToAlphaCanvas(alpha, width, height);
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = image.naturalWidth;
    outputCanvas.height = image.naturalHeight;
    const outputContext = outputCanvas.getContext("2d")!;
    outputContext.drawImage(maskCanvas, fit.offsetX, fit.offsetY, fit.scaledWidth, fit.scaledHeight, 0, 0, outputCanvas.width, outputCanvas.height);
    const pixels = outputContext.getImageData(0, 0, outputCanvas.width, outputCanvas.height).data;
    const result = new Uint8ClampedArray(outputCanvas.width * outputCanvas.height);
    for (let index = 0; index < result.length; index += 1) result[index] = pixels[index * 4 + 3];
    return { alpha: result, width: outputCanvas.width, height: outputCanvas.height, metrics: maskMetrics(result), backend: this.backend ?? "wasm" };
  }

  private maskToAlphaCanvas(alpha: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(width, height);
    for (let index = 0; index < alpha.length; index += 1) {
      image.data[index * 4] = 255;
      image.data[index * 4 + 1] = 255;
      image.data[index * 4 + 2] = 255;
      image.data[index * 4 + 3] = alpha[index];
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  async dispose(): Promise<void> {
    await this.session?.release?.();
    this.session = null;
    this.backend = null;
    this.wasmFallbackTried = false;
  }
}
