/**
 * 测试执行器（分层）。
 *
 * 背景：旧版只匹配 `unit-*.ts`，于是 tests/ 下 9 个测试文件从不执行 ——
 * 其中包含最大的 stage-runner.ts(24KB) 和全部 e2e/验收测试。这构成「假门禁」：
 * CI 显示全绿，而最有价值的集成/端到端覆盖从未跑过。
 *
 * 分层（按依赖递增）：
 *   1. unit      unit-*.ts              纯逻辑，无外部依赖，必跑
 *   2. e2e       e2e-*.ts               离线端到端（示例小说全流程），必跑
 *   3. browser   *.mjs 中的浏览器用例     需要 Playwright 浏览器 + dev server，
 *                                          设 NF_E2E=1 才跑；否则**显式跳过并打印**
 *   4. manual    需要 API 密钥/外部目录    永不自动跑，但列出以免被遗忘
 *
 * 关键原则：跳过的测试必须**打印出来**。静默跳过等于假绿。
 *
 * 用法：
 *   node scripts/run-tests.mjs              # unit + e2e
 *   node scripts/run-tests.mjs --e2e        # 追加 browser 层（需先 pnpm exec playwright install）
 *   node scripts/run-tests.mjs --all        # 全部（含 browser）
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = join(ROOT, "tests");
// #1310：单文件超时（挂起不再烧完整 runner），默认 120s
const PER_FILE_TIMEOUT_MS = Number(process.env.NF_TEST_TIMEOUT_MS ?? 120_000);
const E2E_FILE_TIMEOUT_MS = Number(process.env.NF_E2E_TIMEOUT_MS ?? 600_000);

const argv = new Set(process.argv.slice(2));
const RUN_BROWSER = argv.has("--all") || argv.has("--e2e") || process.env.NF_E2E === "1";

const all = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));
const isProbe = (f) => f.startsWith("_") || f === "screenshot.ts";

/** 需要 API 密钥 / 外部目录 / LLM 额度的人工用例（永不自动执行） */
const MANUAL = new Set(["stage-runner.ts", "engine-check.ts"]);
/** 需要 Playwright 浏览器 + dev server 的浏览器端用例 */
const BROWSER = new Set(["web-smoke.mjs", "web-i18n-smoke.mjs", "visual-bible-acceptance.mjs", "lazy-thumb-acceptance.mjs"]);

const unit = all.filter((f) => /^unit-.*\.ts$/.test(f)).sort();
const e2e = all.filter((f) => /^e2e-.*\.ts$/.test(f) && !MANUAL.has(f)).sort();
const browser = all.filter((f) => BROWSER.has(f)).sort();
const manual = all.filter((f) => MANUAL.has(f) || isProbe(f)).sort();

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

/** Playwright 浏览器是否已安装（未装时必须显式说明为什么跳过） */
function playwrightBrowsersReady() {
  if (process.platform !== "win32") return null; // 非 Windows 不做探测，由运行失败暴露
  const probe = process.env.LOCALAPPDATA ?? "";
  if (!probe) return false;
  return existsSync(join(probe, "ms-playwright"));
}

let failed = 0;
let passed = 0;
const failures = [];

function runOne(file, timeout) {
  const abs = join(TESTS_DIR, file);
  const args = isBin ? [abs] : [tsxCli, abs];
  const bin = isBin ? tsxCli : process.execPath;
  // Windows 下 .cmd 不经 shell 无法直接 spawn（会 EINVAL/ENOENT）——按需开启 shell
  const useShell = isBin && process.platform === "win32";
  const res = spawnSync(bin, args, { stdio: "inherit", cwd: ROOT, timeout, shell: useShell });
  if (res.status !== 0) {
    const reason = res.error
      ? `spawn-error ${res.error.code ?? res.error.message}`
      : res.signal
        ? `signal ${res.signal}`
        : `exit ${res.status}`;
    console.error(`✗ ${file} (${reason})`);
    failed++;
    failures.push(file);
  } else {
    passed++;
    console.log(`✓ ${file}`);
  }
}

function section(name, files, timeout) {
  if (!files.length) return;
  console.log(`\n── ${name} (${files.length}) ──`);
  for (const f of files) runOne(f, timeout);
}

console.log(`测试执行器：unit ${unit.length} · e2e ${e2e.length} · browser ${browser.length}（${RUN_BROWSER ? "启用" : "未启用"}）`);

section("单元测试 (unit)", unit, PER_FILE_TIMEOUT_MS);
section("端到端 · 离线 (e2e)", e2e, E2E_FILE_TIMEOUT_MS);

if (browser.length) {
  if (!RUN_BROWSER) {
    console.log(`\n⏭ 浏览器端到端测试 已跳过（${browser.length} 个）：需 Playwright 浏览器 + dev server。`);
    console.log(`   启用方式：pnpm exec playwright install && node scripts/run-tests.mjs --e2e`);
    console.log(`   涉及：${browser.join(", ")}`);
  } else if (playwrightBrowsersReady() === false) {
    console.log(`\n⏭ 浏览器端到端测试 已跳过：未检测到 Playwright 浏览器（${process.env.LOCALAPPDATA}\\ms-playwright 不存在）。`);
    console.log(`   请先执行：pnpm exec playwright install`);
  } else {
    section("端到端 · 浏览器 (browser e2e)", browser, E2E_FILE_TIMEOUT_MS);
  }
}

if (manual.length) {
  console.log(`\nℹ 人工/探针用例 ${manual.length} 个，需外部条件（API 密钥 / 已生成的游戏目录 / 人工观察），不参与自动门禁：`);
  console.log(`   ${manual.join(", ")}`);
}

console.log(`\n${passed} 通过${failed ? `，${failed} 失败` : ""}`);
if (failures.length) {
  console.log(`失败清单：\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
