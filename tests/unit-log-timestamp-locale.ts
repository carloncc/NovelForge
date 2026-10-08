/**
 * #1525：日志时间戳必须按界面语言本地化，且全仓只允许一个实现。
 *
 * 背景：UI15 把界面日志面板改成了跟随界面语言，但三处日志导出（落盘 run-*.log、
 * 复制到剪贴板、保存诊断日志）是同一段表达式的克隆体，没跟上——它们用的是
 * toLocaleTimeString() 的无参形式，走浏览器/系统默认语言。界面语言与系统语言不一致时，
 * 用户复制出去发给别人的日志时间戳与屏幕上的对不上。
 *
 * 本测试守住两件事：
 * ① 全仓（去掉注释后）不得再出现无参 toLocaleTimeString()；
 * ② 唯一实现 i18n/index.ts 的 formatLogTime 必须真的传了 locale。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "target", ".git", "dist"].includes(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(p);
  }
}

/** 去掉块注释与行注释（行注释只认前面是空白的 //，避免砍掉 https:// ） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const m = /(^|\s)\/\//.exec(line);
      return m ? line.slice(0, m.index + (m[1] ? m[1].length : 0)) : line;
    })
    .join("\n");
}

function main(): void {
  const files: string[] = [];
  walk(`${ROOT}/src`, files);
  assert(files.length > 0, "src 目录为空，扫描规则失效");

  const offenders: string[] = [];
  for (const f of files) {
    stripComments(readFileSync(f, "utf8")).split(/\r?\n/).forEach((line, i) => {
      if (/toLocaleTimeString\(\s*\)/.test(line)) offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
    });
  }
  assert(
    offenders.length === 0,
    `出现无参 toLocaleTimeString()（走系统默认语言而非界面语言）：${offenders.join(", ")}（#1525）`,
  );

  // 唯一实现：必须传 locale
  const i18n = stripComments(readFileSync(`${ROOT}/src/i18n/index.ts`, "utf8"));
  const fn = /export function formatLogTime\([^)]*\):\s*string\s*\{[\s\S]*?\n\}/.exec(i18n)?.[0] ?? "";
  assert(fn.length > 0, "未找到 i18n 层唯一实现 formatLogTime（扫描规则失效）");
  assert(
    /toLocaleTimeString\(/.test(fn) && !/toLocaleTimeString\(\s*\)/.test(fn),
    "formatLogTime 必须传 locale，不能用无参形式",
  );

  // 六个调用点都要收敛到它
  const store = stripComments(readFileSync(`${ROOT}/src/stores/generate.ts`, "utf8"));
  const uses = (store.match(/formatLogTime\(/g) ?? []).length;
  assert(uses === 3, `generate.ts 应有 3 处日志导出时间戳，实际 ${uses} 处（#1525）`);

  console.log(`=== 日志时间戳口径测试通过（#1525，${files.length} 个源文件无无参调用）===`);
}

main();
