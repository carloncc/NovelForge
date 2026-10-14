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
 *                + engine-check.ts       设 NF_E2E=1 才跑；否则**显式跳过并打印**
 *   4. manual    需要 API 密钥/外部目录    永不自动跑，但列出以免被遗忘
 *
 * 关键原则：跳过的测试必须**打印出来**。静默跳过等于假绿。
 *
 * 用法：
 *   node scripts/run-tests.mjs              # unit + e2e
 *   node scripts/run-tests.mjs --e2e        # 追加 browser 层（需先 pnpm exec playwright install）
 *   node scripts/run-tests.mjs --all        # 全部（含 browser）
 *   node scripts/run-tests.mjs --selfcheck  # 只打印判据探针（供 tests/unit-fix-gates.ts 断言）
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = join(ROOT, "tests");
// #1310：单文件超时（挂起不再烧完整 runner），默认 120s
const PER_FILE_TIMEOUT_MS = Number(process.env.NF_TEST_TIMEOUT_MS ?? 120_000);
const E2E_FILE_TIMEOUT_MS = Number(process.env.NF_E2E_TIMEOUT_MS ?? 600_000);

/** 临时目录孤儿清扫：默认 48 小时前的才删，绝不碰正在跑的那一份 */
const ORPHAN_MIN_AGE_MS = Number(process.env.NF_TMP_SWEEP_HOURS ?? 48) * 3_600_000;
const ORPHAN_PREFIXES = ["novelforge-e2e-", "novelforge-engine-check-"];

const argv = new Set(process.argv.slice(2));
const RUN_BROWSER = argv.has("--all") || argv.has("--e2e") || process.env.NF_E2E === "1";
// --selfcheck：只做门禁自身的探针并退出，不跑任何用例。
// 为什么需要：tests/unit-fix-gates.ts 想验证「浏览器就绪判据 / 孤儿清扫 / 输出解析」的真实实现，
// 但它无法 import 本文件（tsconfig.tests.json 未开 allowJs，.mjs 无声明文件 → TS7016），
// 于是改为在子进程里跑本探针，断言其 stdout。这样探针用的就是真实现，不是测试里的副本。
const SELFCHECK = argv.has("--selfcheck");

const all = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));
const isProbe = (f) => f.startsWith("_") || f === "screenshot.ts";

/** 需要 API 密钥 / 外部目录 / LLM 额度的人工用例（永不自动执行） */
const MANUAL = new Set(["stage-runner.ts"]);
/** 需要 Playwright 浏览器 + dev server 的浏览器端用例 */
const BROWSER = new Set(["web-smoke.mjs", "web-i18n-smoke.mjs", "visual-bible-acceptance.mjs", "lazy-thumb-acceptance.mjs", "engine-check.ts"]);

/** 产出「成品游戏目录」的离线 e2e：其 stdout 里的 [5] 组装完成行是 engine-check 的输入 */
const ASSEMBLY_PRODUCER = "e2e-demo.ts";

const unit = all.filter((f) => /^unit-.*\.ts$/.test(f)).sort();
const e2e = all.filter((f) => /^e2e-.*\.ts$/.test(f) && !MANUAL.has(f)).sort();
const browser = all.filter((f) => BROWSER.has(f)).sort();
const manual = all.filter((f) => MANUAL.has(f) || isProbe(f)).sort();

/** Playwright 浏览器是否已安装（未装时必须显式说明为什么跳过）
 *
 *  判据必须是「可执行文件存在」，不能是「%LOCALAPPDATA%\\ms-playwright 目录存在」：
 *  该目录可能只剩 .links / __dirlock 之类的残留（浏览器已被清掉），
 *  此时旧判据返回 true → 浏览器层照跑 → 全部假红。 */
export async function playwrightBrowsersReady() {
  try {
    // 动态 import：playwright 未安装时不能让整个 runner 崩掉
    const { chromium } = await import("playwright");
    // 未安装浏览器时 executablePath() 返回的是「将要去装」的路径，所以必须再 existsSync 一次
    const exe = chromium.executablePath();
    return Boolean(exe) && existsSync(exe);
  } catch {
    return null; // 探测失败 → 交给运行失败暴露，不静默跳过
  }
}

/** 解析 e2e-demo 的 stdout，取出组装目录（engine-check 的入参） */
export function parseAssembledDir(stdout) {
  const m = /^\[5\] 组装完成:\s*(.+)$/m.exec(String(stdout ?? ""));
  return m ? m[1].trim() : null;
}

/**
 * --selfcheck 探针：用**真实现**打印判据，供 tests/unit-fix-gates.ts 在子进程里断言。
 * 只读不写（除清扫探针自己造的 fixture），不跑任何用例。
 */
async function selfcheck() {
  const probe = "C:\\Users\\x\\AppData\\Local\\Temp\\novelforge-e2e-Probe1";
  const dirOnly = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  // 与 playwrightBrowsersReady() 同口径地算出「可执行文件路径」，单独打出来供测试对比
  let exe = "";
  try {
    exe = (await import("playwright")).chromium.executablePath();
  } catch {
    exe = "";
  }
  console.log("SELFCHECK version=1");
  console.log(`SELFCHECK playwrightDirExists=${existsSync(dirOnly)}`);
  console.log(`SELFCHECK browserExecutable=${JSON.stringify(exe)}`);
  console.log(`SELFCHECK browserExecutableExists=${Boolean(exe) && existsSync(exe)}`);
  console.log(`SELFCHECK browserReady=${String(await playwrightBrowsersReady())}`);
  console.log(`SELFCHECK parsed=${JSON.stringify(parseAssembledDir(`[4] x\n[5] 组装完成: ${probe}\n    meta: {}`))}`);
  console.log(`SELFCHECK parsedMissing=${JSON.stringify(parseAssembledDir("[1] 章节切分: 3 章"))}`);
  console.log(`SELFCHECK manual=${JSON.stringify([...MANUAL])}`);
  console.log(`SELFCHECK browser=${JSON.stringify([...BROWSER])}`);
}

/**
 * 清扫历史遗留的临时目录（孤儿）。
 * 为什么需要：e2e 失败时**故意保留现场**、以及 runner 为 engine-check 置 NF_KEEP_E2E_DIR=1
 * 时都会留下几十 MB 的目录；没有回收就会无限堆积（本机实测 196 个 / 7.68GB）。
 * 只删「前缀命中 + 目录自身 mtime 早于阈值」的目录：正在跑的用例刚写过目录内容，mtime 必然很新。
 */
export function sweepOrphanE2eDirs(dir, minAgeMs = ORPHAN_MIN_AGE_MS, prefixes = ORPHAN_PREFIXES, log = console.log) {
  const removed = [];
  if (process.env.NF_TMP_SWEEP === "0") return removed;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed; // 读不到就不管（权限/不存在都不该让 runner 失败）
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!prefixes.some((p) => e.name.startsWith(p))) continue;
    const full = join(dir, e.name);
    try {
      if (now - statSync(full).mtimeMs < minAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      /* 单个目录删不掉不影响其它 */
    }
  }
  if (removed.length) log(`🧹 清理历史遗留临时目录 ${removed.length} 个（超过 ${Math.round(minAgeMs / 3_600_000)} 小时）`);
  return removed;
}

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
let passed = 0;
const failures = [];

function runOne(file, timeout, opts = {}) {
  const abs = join(TESTS_DIR, file);
  const extraArgs = opts.args ?? [];
  const args = isBin ? [abs, ...extraArgs] : [tsxCli, abs, ...extraArgs];
  const bin = isBin ? tsxCli : process.execPath;
  // Windows 下 .cmd 不经 shell 无法直接 spawn（会 EINVAL/ENOENT）——按需开启 shell。
  // 注意：走 shell 时 spawnSync 会把数组参数交给 cmd.exe 拼行，含空格的参数（例如带空格的
  // 临时目录路径）可能被拆开；本机/CI 的 Node 18+ 走的是 `node cli.mjs` 分支（isBin=false），
  // 不经 shell，因此 engine-check 的路径入参不受影响。
  const useShell = isBin && process.platform === "win32";
  const env = { ...process.env, ...(opts.env ?? {}) };
  const res = spawnSync(bin, args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", cwd: ROOT, timeout, shell: useShell, env });
  if (opts.capture) {
    // 子进程输出改由调用方打印（不丢日志），stdout 同时留给调用方解析
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    opts.stdout = res.stdout ?? "";
  }
  if (res.error || res.signal || res.status !== 0) {
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
  return { ok: !res.error && !res.signal && res.status === 0, stdout: res.stdout ?? "" };
}

function section(name, specs, timeout) {
  if (!specs.length) return;
  console.log(`\n── ${name} (${specs.length}) ──`);
  for (const s of specs) runOne(s.file, timeout, s);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
// 只在被直接执行时跑：被 import 时不产生副作用，--selfcheck 则只跑判据探针（见文件头用法）。
async function main() {
  sweepOrphanE2eDirs(process.env.TEMP ?? process.env.TMP ?? "/tmp");

  console.log(`测试执行器：unit ${unit.length} · e2e ${e2e.length} · browser ${browser.length}（${RUN_BROWSER ? "启用" : "未启用"}）`);

  section("单元测试 (unit)", unit.map((file) => ({ file })), PER_FILE_TIMEOUT_MS);

  // e2e-demo 的产物就是 engine-check 的输入，所以先跑它、捕获 stdout、并置 NF_KEEP_E2E_DIR=1 留下目录
  let assembledDir = null;
  const e2eSpecs = e2e.map((file) => ({
    file,
    capture: file === ASSEMBLY_PRODUCER,
    env: file === ASSEMBLY_PRODUCER ? { NF_KEEP_E2E_DIR: "1" } : undefined,
    stdout: "",
  }));
  section("端到端 · 离线 (e2e)", e2eSpecs, E2E_FILE_TIMEOUT_MS);
  for (const spec of e2eSpecs) {
    if (spec.file !== ASSEMBLY_PRODUCER) continue;
    assembledDir = parseAssembledDir(spec.stdout);
    console.log(assembledDir ? `   ↳ 组装目录（engine-check 输入）: ${assembledDir}` : "   ↳ 未解析到组装目录");
  }

  if (browser.length) {
    if (!RUN_BROWSER) {
      console.log(`\n⏭ 浏览器端到端测试 已跳过（${browser.length} 个）：需 Playwright 浏览器 + dev server。`);
      console.log(`   启用方式：pnpm exec playwright install && node scripts/run-tests.mjs --e2e`);
      console.log(`   涉及：${browser.join(", ")}`);
    } else if ((await playwrightBrowsersReady()) === false) {
      // 真实失败，不是跳过：--e2e / CI 场景下浏览器是前置条件，假红比假绿更该被看见
      console.log("\n✗ 浏览器端到端测试 无法执行：未检测到 Playwright 浏览器可执行文件。");
      console.log("   请先执行：pnpm exec playwright install");
      failed += browser.length;
      failures.push(...browser);
    } else if (!assembledDir) {
      console.error(`\n✗ 浏览器端到端测试 无法执行：${ASSEMBLY_PRODUCER} 未产出组装目录（engine-check 的输入缺失）。`);
      failed += browser.length;
      failures.push(...browser);
    } else {
      section("端到端 · 浏览器 (browser e2e)", browser.map((file) => ({
        file,
        args: file === "engine-check.ts" ? [assembledDir] : undefined,
      })), E2E_FILE_TIMEOUT_MS);
    }
  }
  finish();
}

function finish() {
  if (manual.length) {
    console.log(`\nℹ 人工/探针用例 ${manual.length} 个，需外部条件（API 密钥 / 已生成的游戏目录 / 人工观察），不参与自动门禁：`);
    console.log(`   ${manual.join(", ")}`);
  }
  console.log(`\n${passed} 通过${failed ? `，${failed} 失败` : ""}`);
  if (failures.length) {
    console.log(`失败清单：\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
}

/** 是否被直接执行（被 import 时不跑主流程，供 tests/unit-fix-gates.ts 复用纯函数） */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(entry).toLowerCase();
}

if (isMainModule()) {
  if (SELFCHECK) {
    selfcheck().catch((e) => {
      console.error("自检失败:", e);
      process.exit(1);
    });
  } else {
    main().catch((e) => {
      console.error("测试执行器异常:", e);
      process.exit(1);
    });
  }
}
