/**
 * #1568：multipart 名称转义**只允许有一份实现**，且必须挡住注入。
 *
 * 该函数拼进 Content-Disposition 的 name/filename，注释写明目的是「拦引号与 CRLF 注入」。
 * 原先 imageEdits.ts 与 universal.ts 各有一份（实测逐字相同，故无故障），但这是本会话反复吃的形态：
 *   #1565 展示单价两份字面量、#1558 两个同名 stableHash、#1562 两份审查阶梯。
 * 一处改了另一处漏改，注入防护就出现缺口。现已合并为 universal.ts 里的唯一实现。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { escapeDispositionName } from "../src/api/universal";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function srcFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "target", ".git", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, acc);
    else if (/\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function main(): void {
  // ① 注入防护本身：引号、反斜杠、CRLF 都必须被消解
  const cases: Array<[string, (out: string) => boolean, string]> = [
    ["a\"b", (o) => !/(^|[^\\])"/.test(o), "未转义的引号会提前闭合 part 头"],
    ["a\r\nb", (o) => !/[\r\n]/.test(o), "CRLF 注入可以伪造额外的 part 头"],
    ["a\\b", (o) => o.includes("\\\\"), "反斜杠必须转义（否则可构造转义逃逸）"],
  ];
  for (const [input, ok, why] of cases) {
    const out = escapeDispositionName(input);
    assert(ok(out), "转义不足：" + JSON.stringify(input) + " -> " + JSON.stringify(out) + "（" + why + "）（#1568）");
  }

  // ② 长度封顶（历史行为，别在合并时丢掉）
  assert(escapeDispositionName("x".repeat(500)).length === 200, "必须仍封顶到 200 字符（#1568）");
  // ③ 空值/undefined 不得崩（原先的 `name ?? ""`）
  assert(escapeDispositionName(undefined as unknown as string) === "", "undefined 应得空串（#1568）");
  assert(escapeDispositionName("") === "", "空串应得空串（#1568）");

  // ④ 源码契约：全仓只允许一处定义
  const defs: string[] = [];
  for (const f of srcFiles(join(process.cwd(), "src"))) {
    const src = readFileSync(f, "utf8");
    if (/function\s+escapeDispositionName\s*\(/.test(src)) defs.push(f.slice(process.cwd().length + 1));
  }
  assert(defs.length === 1,
    "escapeDispositionName 只允许一处定义，实际 " + defs.length + " 处：" + defs.join("、") + "（多份实现会各自漂移）（#1568）");

  console.log("=== multipart 转义唯一实现 + 注入防护通过（#1568：定义处 " + defs[0] + "）===");
}

main();
