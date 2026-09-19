/**
 * 打包 zip 专用 Worker：压缩在独立线程完成，避免大项目冻结页面主线程。
 * 由 webRuntime.webBuildZip 调度；数据经结构化克隆传入、结果以 Transferable 传回。
 */
import { zipSync } from "fflate";

interface ZipWorkerRequest {
  entries: Record<string, [Uint8Array, { level: 0 | 6 }]>;
}

self.onmessage = (ev: MessageEvent<ZipWorkerRequest>) => {
  try {
    const zipData = zipSync(ev.data.entries);
    (self as unknown as Worker).postMessage({ data: zipData }, [zipData.buffer as ArrayBuffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
