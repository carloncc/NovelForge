/** web-model-downloader.mjs 的类型声明（供 vite.config.ts / CLI 使用） */
export interface ModelDownloadProgress {
  bytes: number;
  total: number;
}

export interface ModelInstallInput {
  filename: string;
  url: string;
  md5?: string;
}

export declare function modelDir(): string;
export declare function modelPath(filename: string): string;
export declare function installedModelFile(filename: string): boolean;
export declare function installModel(
  input: ModelInstallInput,
  options?: { onProgress?: (progress: ModelDownloadProgress) => void },
): Promise<{ destination: string }>;
