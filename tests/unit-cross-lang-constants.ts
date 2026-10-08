/**
 * #1566：跨语言常量对的守门。
 *
 * 本会话已多次栽在同一形态上——**口径一致只写在注释里**：
 *   #1548 webRuntime 抠图自称「对齐 Rust」实则三处没对齐；
 *   #1536 目录切分 Web 比 Rust 宽松；
 *   #1565 展示单价与主管线单价是两份独立字面量。
 *
 * 跨语言没法共享常量，所以这里改为**读 Rust 源码求值后比对**：任何一侧被改、另一侧没跟，门禁即红。
 * 目前守的一对：
 *   tauri.ts 的 IMAGE_HEADER_BYTES  <->  commands.rs 的 READ_FILE_HEADER_LIMIT（`64 * 1024`）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_HEADER_BYTES } from "../src/utils/tauri";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 从 Rust 常量定义里取出表达式并求值（支持 `64 * 1024` 这类写法） */
function evalRustConst(src: string, name: string): number {
  const m = new RegExp("const\\s+" + name + "\\s*:\\s*usize\\s*=\\s*([^;]+);").exec(src);
  assert(m, "在 Rust 源码里找不到常量 " + name + "（#1566）");
  const expr = m![1].trim();
  assert(/^[0-9_+*\s()]+$/.test(expr), "常量表达式含无法安全求值的字符：" + expr + "（#1566）");
  const value = Function("\"use strict\"; return (" + expr.replace(/_/g, "") + ");")() as number;
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, "常量求值结果异常：" + String(value) + "（#1566）");
  return value;
}

function main(): void {
  const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "commands.rs"), "utf8");

  // ① 主力断言：图片头部读取上限两侧必须相等
  const rustLimit = evalRustConst(rust, "READ_FILE_HEADER_LIMIT");
  assert(
    IMAGE_HEADER_BYTES === rustLimit,
    "IMAGE_HEADER_BYTES(" + IMAGE_HEADER_BYTES + ") 必须等于 Rust 的 READ_FILE_HEADER_LIMIT(" + rustLimit + ")——" +
      "两侧不一致会让「解析图片尺寸」在 Web 与桌面用不同的头部预算（#1566）",
  );

  // ② 求值器自身要可靠：明确验证它能算对乘法写法（否则 ① 可能是假绿）
  assert(evalRustConst("const X: usize = 64 * 1024;", "X") === 65536, "求值器必须能算 64 * 1024（#1566）");
  assert(evalRustConst("const Y: usize = 1_000;", "Y") === 1000, "求值器必须能处理下划线数字（#1566）");

  // ③ 该常量必须真被用到（导出后若无人引用，守门就失去意义）
  const tauriSrc = readFileSync(join(process.cwd(), "src", "utils", "tauri.ts"), "utf8");
  assert((tauriSrc.match(/IMAGE_HEADER_BYTES/g) || []).length >= 2,
    "IMAGE_HEADER_BYTES 必须仍被实际使用（除定义外至少一处）（#1566）");

  console.log("=== 跨语言常量对一致（#1566：IMAGE_HEADER_BYTES = Rust READ_FILE_HEADER_LIMIT = " + rustLimit + "）===");
}

main();
