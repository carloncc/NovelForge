/**
 * #1514：随包 start_game.command 的执行位。
 *
 * 为什么测字节而不测函数返回值：执行位最终落在 zip 的 external file attributes 里，
 * 中间隔着「自写 zip 写入器」「fflate 回退路径」「Rust zip」三条独立实现。
 * 只要其中一条忘了写偏移量，macOS 用户双击就没反应——函数返回 Ok 毫无意义。
 * 这里直接解析 central directory 的原始字节。
 */
import { zipStreamScope } from "../src/utils/webRuntime";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface Chunk { type?: string; data?: ArrayBuffer }

/** 把 worker scope 换成同步 mock，收集所有分块 */
function collect(): { scope: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (m: unknown) => void }; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const scope = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage: (m: unknown) => {
      const msg = m as Chunk;
      if (msg.type === "chunk" && msg.data) chunks.push(new Uint8Array(msg.data));
    },
  };
  zipStreamScope(scope);
  return { scope, chunks };
}

async function build(paths: string[]): Promise<Uint8Array> {
  const { scope, chunks } = collect();
  let settled: () => void = () => {};
  const done = new Promise<void>((res) => { settled = res; });
  const realPost = scope.postMessage;
  scope.postMessage = (m: unknown) => {
    const msg = m as { type?: string };
    if (msg.type === "done") settled();
    realPost(m);
  };
  scope.onmessage!({ data: { type: "add", path: paths[0], store: false, data: new TextEncoder().encode("#!/bin/bash\necho hi\n").buffer } });
  for (let i = 1; i < paths.length; i++) {
    scope.onmessage!({ data: { type: "add", path: paths[i], store: true, data: new TextEncoder().encode("plain").buffer } });
  }
  scope.onmessage!({ data: { type: "end" } });
  await done;
  let size = 0;
  for (const c of chunks) size += c.byteLength;
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

interface CdEntry { name: string; madeBy: number; extAttrs: number }

/** 扫描 central directory（EOCD → 逐条 46 字节头） */
function readCentralDirectory(zip: Uint8Array): CdEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert(eocd >= 0, "未找到 EOCD");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const out: CdEntry[] = [];
  for (let k = 0; k < count; k++) {
    assert(dv.getUint32(p, true) === 0x02014b50, "central directory 签名错误 @" + p);
    const nameLen = dv.getUint16(p + 28, true);
    const name = dec.decode(zip.slice(p + 46, p + 46 + nameLen));
    out.push({ name, madeBy: dv.getUint16(p + 4, true), extAttrs: dv.getUint32(p + 38, true) });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  void enc;
  return out;
}

async function main(): Promise<void> {
  const zip = await build(["start_game.command", "game/index.html", "run.sh", "notes.txt"]);
  const cd = readCentralDirectory(zip);
  assert(cd.length === 4, "条目数应为 4，实际 " + cd.length);
  const byName = new Map(cd.map((e) => [e.name, e]));

  // #1514：脚本条目必须是 unix 0755
  for (const name of ["start_game.command", "run.sh"]) {
    const e = byName.get(name);
    assert(!!e, "缺少条目 " + name);
    assert((e.madeBy >> 8) === 3, name + " 的 version-made-by 高字节应为 3(Unix)，实际 " + (e.madeBy >> 8));
    assert(e.extAttrs === (0o755 << 16), name + " 的 external attrs 应为 0o755<<16，实际 0x" + e.extAttrs.toString(16));
  }
  // 非脚本条目必须保持原样，避免把既有解压行为一并改掉
  for (const name of ["game/index.html", "notes.txt"]) {
    const e = byName.get(name);
    assert(!!e, "缺少条目 " + name);
    assert(e.extAttrs === 0, name + " 不应带外部属性，实际 0x" + e.extAttrs.toString(16));
    assert(e.madeBy === 20, name + " 的 made-by 应保持 20，实际 " + e.madeBy);
  }
  console.log("=== zip 执行位测试通过（#1514）===");
}

main().catch((error) => {
  console.error("unit-zip-exec-bit failed:", error);
  process.exit(1);
});
