/**
 * 运行全部单元测试（tests/unit-*.ts）：逐个用 tsx 执行，任一失败即非零退出。
 * Windows cmd/PowerShell 不展开 npm script 里的 glob，故用 Node 显式遍历。
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = join(ROOT, "tests");

const files = readdirSync(TESTS_DIR)
  .filter((f) => /^unit-.*\.ts$/.test(f))
  .sort();

const tsxCli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, [tsxCli, join(TESTS_DIR, file)], { stdio: "inherit", cwd: ROOT });
  if (res.status !== 0) {
    console.error(`✗ ${file} (exit ${res.status})`);
    failed++;
  } else {
    console.log(`✓ ${file}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} 通过`);
if (failed > 0) process.exit(1);
