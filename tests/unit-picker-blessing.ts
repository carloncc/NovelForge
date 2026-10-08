/**
 * #1520：每个 Tauri 文件/目录选择器都必须登记所选路径所在目录。
 *
 * 为什么这是硬要求：Rust 侧 `resolve_safe_path` 只放行 canonical_roots()，而 roots 只有
 * 三条——工作目录、临时目录、用户家目录（commands.rs 的 allowed_file_roots）。
 * 注释自己就写着「仅靠工作目录/临时目录/家目录三根会把 D 盘等位置的正常项目全部拒绝」，
 * 所以用户在对话框里选完文件后，前端必须调 blessParentDir 把该目录登记进去。
 *
 * 这个 bug 是一类「修复只落在克隆体的一部分」的经典形态：导入页和导出页的保存位置早就补了
 * blessParentDir，而九个同形状的选择器（参考图、参考声音、画风参考图、封面/Logo、视频导入、
 * 输出目录…）没有——于是同一个用户，同样的操作，换个对话框就报「路径不在允许目录内」。
 *
 * 本测试把这条规则变成门禁：任何新增/遗漏的选择器都会在 CI 里被点名，而不是等用户撞上。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");
const SRC = `${ROOT}/src`;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(p);
  }
}

function main(): void {
  const files: string[] = [];
  walk(SRC, files);

  const sites: { file: string; line: number }[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/\bopen\(\s*\{/.test(l) || /\bawait open\(/.test(l)) {
        sites.push({ file: f.slice(SRC.length + 1), line: i + 1 });
      }
    });
  }

  assert(sites.length > 0, "未找到任何文件选择器：扫描规则失效，测试失去意义");

  const missing: string[] = [];
  for (const site of sites) {
    const lines = readFileSync(join(SRC, site.file), "utf8").split(/\r?\n/);
    const win = lines.slice(Math.max(0, site.line - 5), site.line + 25).join("\n");
    if (!/blessParentDir/.test(win)) missing.push(`${site.file}:${site.line}`);
  }

  assert(
    missing.length === 0,
    `以下选择器没有登记所选目录，位于工作目录/临时目录/家目录之外（如 D 盘）的文件会被 resolve_safe_path 拒绝：\n  ${missing.join("\n  ")}`,
  );

  // 同时守住 Rust 侧的口径：白名单根只有三处。将来若放宽了 roots，本测试的必要性下降，
  // 但仍然无害——blessParentDir 只是把用户明示授权的目录加进来，不构成额外放行面。
  const commands = readFileSync(`${ROOT}/src-tauri/src/commands.rs`, "utf8");
  assert(
    /fn allowed_file_roots\(\)[\s\S]*?roots\.push\(cwd\)[\s\S]*?roots\.push\(std::env::temp_dir\(\)\)[\s\S]*?roots\.push\(PathBuf::from\(home\)\)/.test(commands),
    "allowed_file_roots 的口径变了（cwd/temp/home），请复核 #1520 的门禁是否还需要",
  );

  console.log(`=== 文件选择器目录登记测试通过（#1520，${sites.length} 处）===`);
}

main();
