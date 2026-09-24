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
  // #1310 回归修复：`import.meta.resolve("tsx")` 返回的是 `tsx/dist/loader.mjs`（ESM 加载器，
  // 不是 CLI）——用它当入口执行 `node loader.mjs test.ts` 会静默退出 0、一个用例都不跑，
  // runner 变成"永远全绿"的假门禁。解析顺序改为：已知 CLI 路径 → .bin/tsx → 最后才 import.meta.resolve
  // （且必须命中 cli 入口，命中 loader 一律判无效）。
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const dir = join(ROOT, "node_modules", "tsx", "dist");
  // Node 18+ 可直接跑 ESM CLI；所有受支持版本下 cli.mjs 都是有效入口
  if (nodeMajor >= 18 && existsSync(join(dir, "cli.mjs"))) return join(dir, "cli.mjs");
  const binTsx = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (existsSync(binTsx)) return binTsx;
  try {
    const resolved = import.meta.resolve?.("tsx/cli");
    if (resolved) return fileURLToPath(resolved);
  } catch { /* 继续回退 */ }
  try {
    const resolved = import.meta.resolve?.("tsx");
    if (resolved) {
      const p = fileURLToPath(resolved);
      // loader.mjs / index.mjs 均非 CLI，命中即判无效，避免假绿
      if (!/(loader|index)\.mjs$/.test(p)) return p;
    }
  } catch { /* 继续回退 */ }
  return join(dir, "cli.mjs");
}

const tsxCli = resolveTsxCli();
const isBin = tsxCli.endsWith("tsx") || tsxCli.endsWith("tsx.cmd");

let failed = 0;
for (const file of files) {
  const args = isBin
    ? [join(TESTS_DIR, file)]
    : [tsxCli, join(TESTS_DIR, file)];
  const bin = isBin ? tsxCli : process.execPath;
  // Windows 下 .cmd 不经 shell 无法直接 spawn（会 EINVAL/ENOENT）——按需开启 shell
  const useShell = isBin && process.platform === "win32";
  const res = spawnSync(bin, args, { stdio: "inherit", cwd: ROOT, timeout: PER_FILE_TIMEOUT_MS, shell: useShell });
  if (res.status !== 0) {
    const reason = res.error
      ? `spawn-error ${res.error.code ?? res.error.message}`
      : res.signal
        ? `signal ${res.signal}`
        : `exit ${res.status}`;
    console.error(`✗ ${file} (${reason})`);
    failed++;
  } else {
    console.log(`✓ ${file}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} 通过`);
if (failed > 0) process.exit(1);
