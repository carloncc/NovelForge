/**
 * #1523：Web 端抠图入口的输入上限必须与 Rust cutout.rs 同口径。
 *
 * #1471 已在桌面端把两个上限抽成 decode_guarded 单一入口，但 Web 端两个姊妹实现
 * （webCutoutImage / webHasTransparency，共用 loadImage）完全没有这道闸门：一张超大图会依次
 * 触发 data: URL 解码 → 全尺寸 canvas → getImageData 再拷一份 RGBA → visited 缓冲。
 *
 * 本测试做两件事：
 * ① 数值口径对齐——直接读 Rust 源文件里的常量，改一边另一边就会红；
 * ② 结构对齐——loadImage 必须真的在解码前调这道闸门，防止将来重构时被顺手删掉。
 */
import { readFileSync } from "node:fs";
import { CUTOUT_MAX_INPUT_B64_BYTES, CUTOUT_MAX_INPUT_PIXELS } from "../src/utils/webRuntime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");
function readNormalized(rel: string): string {
  return readFileSync(ROOT + rel, "utf8").replace(/\r\n/g, "\n");
}

function main(): void {
  const rust = readNormalized("/src-tauri/src/cutout.rs");

  const b64 = /MAX_INPUT_B64_BYTES:\s*usize\s*=\s*([\d_\s*]+);/.exec(rust);
  assert(b64, "未在 cutout.rs 里找到 MAX_INPUT_B64_BYTES，解析规则失效");
  const px = /MAX_INPUT_PIXELS:\s*u64\s*=\s*([\d_\s*]+);/.exec(rust);
  assert(px, "未在 cutout.rs 里找到 MAX_INPUT_PIXELS，解析规则失效");

  const evalRust = (expr: string): number =>
    expr.split("*").map((s) => Number(s.trim().replace(/_/g, ""))).reduce((a, b) => a * b, 1);
  const rustB64 = evalRust(b64[1]);
  const rustPx = evalRust(px[1]);

  assert(
    CUTOUT_MAX_INPUT_B64_BYTES === rustB64,
    `Web 端 base64 上限 ${CUTOUT_MAX_INPUT_B64_BYTES} 与 Rust 的 ${rustB64} 不一致（两侧必须同口径）`,
  );
  assert(
    CUTOUT_MAX_INPUT_PIXELS === rustPx,
    `Web 端像素上限 ${CUTOUT_MAX_INPUT_PIXELS} 与 Rust 的 ${rustPx} 不一致（两侧必须同口径）`,
  );

  // 结构对齐：闸门挂在唯一的解码入口上，且早于解码
  const src = readNormalized("/src/utils/webRuntime.ts");
  const body = /async function loadImage\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
  assert(body.length > 0, "未找到 loadImage，扫描规则失效");
  assert(
    body.includes("CUTOUT_MAX_INPUT_B64_BYTES") && body.includes("CUTOUT_MAX_INPUT_PIXELS"),
    "loadImage 必须同时执行 base64 与像素两道闸门",
  );
  const guardAt = body.indexOf("CUTOUT_MAX_INPUT_B64_BYTES");
  const decodeAt = body.indexOf("el.src");
  assert(decodeAt >= 0, "未找到 el.src 赋值（扫描规则失效）");
  assert(guardAt >= 0 && guardAt < decodeAt, "闸门必须早于图片解码（el.src 赋值）");

  console.log(`=== 抠图输入上限口径测试通过（#1523，${CUTOUT_MAX_INPUT_B64_BYTES} 字节 / ${CUTOUT_MAX_INPUT_PIXELS} 像素）===`);
}

main();
