/**
 * #1143 / #1144：流式 zip 打包（内存峰值 ≈ 单文件 + 已压缩输出，不再全量驻留）。
 * - zipStreamScope：用假 scope 驱动，逐文件 add → done，拼出的字节可用 fflate 解开且内容一致；
 * - vfsCollectFilesBatched：一次键事务 + 分批读取事务，onBatch 逐批交付且总数一致。
 */
import "fake-indexeddb/auto";
import { unzipSync } from "fflate";
import { zipStreamScope } from "../src/utils/webRuntime";
import { vfsCollectFilesBatched, vfsWriteTextFile } from "../src/utils/vfsWeb";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface FakeMessage {
  type?: string;
  path?: string;
  store?: boolean;
  data?: ArrayBuffer;
  fileCount?: number;
  sizeBytes?: number;
  message?: string;
}

function driveZip(files: { path: string; data: Uint8Array; store: boolean }[]): Promise<{ chunks: Uint8Array[]; fileCount: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const scope = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => {
        const msg = message as FakeMessage & { data?: ArrayBuffer };
        if (msg.type === "chunk" && msg.data) chunks.push(new Uint8Array(msg.data));
        else if (msg.type === "added") {
          void pending.shift()?.();
        } else if (msg.type === "done") {
          resolve({ chunks, fileCount: msg.fileCount ?? 0 });
        } else if (msg.type === "error") {
          reject(new Error(msg.message || "zip worker 执行失败"));
        }
      },
    };
    const pending: Array<() => void> = [];
    zipStreamScope(scope);
    (async () => {
      for (const f of files) {
        const buf = f.data.byteOffset === 0 && f.data.byteLength === f.data.buffer.byteLength
          ? f.data.buffer as ArrayBuffer
          : f.data.slice().buffer as ArrayBuffer;
        await new Promise<void>((done) => {
          pending.push(done);
          scope.onmessage!({ data: { type: "add", path: f.path, store: f.store, data: buf } });
        });
      }
      scope.onmessage!({ data: { type: "end" } });
    })().catch(reject);
  });
}

async function main(): Promise<void> {
  // #1143：流式产出是合法 zip（文本走压缩、媒体走直存），内容逐字节一致
  const text = new TextEncoder().encode("林澈:你好，世界！".repeat(20));
  const media = new Uint8Array(4096).map((_, i) => i % 251);
  const { chunks, fileCount } = await driveZip([
    { path: "game/scene/ch1.txt", data: text, store: false },
    { path: "game/background/bg.png", data: media, store: true },
  ]);
  assert(fileCount === 2, `fileCount 应为 2，实际 ${fileCount}`);
  assert(chunks.length > 2, "应分块回传（头/数据/描述符/中央目录分离）");
  let size = 0;
  for (const c of chunks) size += c.byteLength;
  const zip = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    zip.set(c, off);
    off += c.byteLength;
  }
  const unzipped = unzipSync(zip);
  assert(new TextDecoder().decode(unzipped["game/scene/ch1.txt"]) === new TextDecoder().decode(text), "文本内容不一致");
  assert(unzipped["game/background/bg.png"].length === media.length, "媒体长度不一致");
  assert(unzipped["game/background/bg.png"].every((v, i) => v === media[i]), "媒体字节不一致");

  // #1144：分批收集（batchSize=2，每批一次事务），总数与进度一致
  const root = "/app/zip-batch-test";
  for (let i = 0; i < 5; i++) await vfsWriteTextFile(`${root}/f${i}.txt`, `内容${i}`);
  await vfsWriteTextFile(`${root}/.novel2vn/meta.json`, "{}");
  const seen: string[] = [];
  const progress: { done: number; total: number }[] = [];
  const count = await vfsCollectFilesBatched(
    root,
    [".novel2vn"],
    (files, p) => {
      seen.push(...files.map((f) => f.path));
      progress.push({ ...p });
    },
    2,
  );
  assert(count === 5, `应收集 5 个文件，实际 ${count}`);
  assert(seen.length === 5 && new Set(seen).size === 5, `分批交付应覆盖 5 个唯一文件: ${seen}`);
  assert(!seen.some((p) => p.startsWith(".novel2vn")), "排除目录不应被收集");
  assert(progress.length === 3, `5 文件 / batch=2 应回调 3 次，实际 ${progress.length}`);
  assert(progress[progress.length - 1].done === 5, "末次进度 done 应为 5");

  console.log("=== 流式 zip 打包（#1143/#1144）测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
