/**
 * 运行全部单元测试（tests/unit-*.ts）：逐个用 tsx 执行，任一失败即非零退出。
 * Windows cmd/PowerShell 不展开 npm script 里的 glob，故用 Node 显式遍历。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = join(ROOT, "tests");
// #1310：单文件超时（挂起不再烧完整 runner），默认 120s
const PER_FILE_TIMEOUT_MS = Number(process.env.NF_TEST_TIMEOUT_MS ?? 120_000);

const files = readdirSync(TESTS_DIR)
  .filter((f) => /^unit-.*\.ts$/.test(f))
  .sort();

function resolveTsxCli() {
  // #1310：不再硬编码 node_modules/tsx/dist/cli.mjs（pnpm 布局/版本升级即断）；
  // 优先 import.meta.resolve，其次 .bin/tsx，最后回退硬编码路径
  try {
    const resolved = import.meta.resolve?.("tsx");
    if (resolved) return fileURLToPath(resolved);
  } catch { /* 继续回退 */ }
  const binTsx = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (existsSync(binTsx)) return binTsx;
  return join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
}

const tsxCli = resolveTsxCli();
const isBin = tsxCli.endsWith("tsx") || tsxCli.endsWith("tsx.cmd");

let failed = 0;
for (const file of files) {
  const args = isBin
    ? [join(TESTS_DIR, file)]
    : [tsxCli, join(TESTS_DIR, file)];
  const bin = isBin ? tsxCli : process.execPath;
  const res = spawnSync(bin, args, { stdio: "inherit", cwd: ROOT, timeout: PER_FILE_TIMEOUT_MS });
  if (res.status !== 0) {
    const reason = res.error?.code === "ETIMEDOUT" ? "timeout" : `exit ${res.status}`;
    console.error(`✗ ${file} (${reason})`);
    failed++;
  } else {
    console.log(`✓ ${file}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} 通过`);
if (failed > 0) process.exit(1);
