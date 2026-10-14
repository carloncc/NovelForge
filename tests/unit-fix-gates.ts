/**
 * 门禁自身的回归测试（tests/unit-fix-gates.ts）。
 *
 * 为什么需要：本轮修的三个问题都出在「测试基础设施」上，而基础设施的 bug 不会让任何
 * 业务单测变红 —— 它们只会让门禁**看起来是绿的**：
 *   ① e2e-demo 每次残留 ~40MB 临时游戏目录（本机实测 196 个 / 7.68GB）；
 *   ② 浏览器就绪探测只看 `%LOCALAPPDATA%\ms-playwright` 目录存在 → 目录里只剩 .links 残留时
 *      判为"就绪"，`pnpm test:e2e` 真跑并假红；
 *   ③ engine-check.ts（唯一验证"成品真能在引擎里跑"的用例）被列进 MANUAL，永不自动执行。
 *
 * 验证方式：runner 是 .mjs（tsconfig.tests.json 未开 allowJs，import 会 TS7016），
 * 所以这里不 import 它，而是
 *   (a) 用 `node scripts/run-tests.mjs --selfcheck` 在子进程里跑**真实现**的判据并断言其输出；
 *   (b) 对 runner 源码做契约断言（MANUAL/BROWSER 集合、engine-check 传参）；
 *   (c) 用本文件内的同逻辑副本验证清扫的边界行为（真实清扫已由 (a)+(b) 覆盖）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOUR = 3_600_000;

// ── ① runner 真实现探针：浏览器就绪判据 + 组装目录解析 ──
// 若 run-tests.mjs 在模块顶层无条件跑主流程，这条会变成"递归跑全套测试"，所以 --selfcheck 必须短路。
const probe = spawnSync(process.execPath, [join(ROOT, "scripts", "run-tests.mjs"), "--selfcheck"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 120_000,
});
assert(probe.status === 0, `runner --selfcheck 必须成功退出，实际 exit=${String(probe.status)} stderr=${probe.stderr?.slice(0, 300)}`);
const out = probe.stdout ?? "";
const field = (name: string): string => {
  const m = new RegExp(`^SELFCHECK ${name}=(.*)$`, "m").exec(out);
  // 取不到就返回空串：调用方的断言会带着完整 stdout 失败，比这里抛错更好排查
  return m ? m[1] : "";
};
/** 取一个 JSON 字段；缺失时用带完整输出的断言拦住（避免 JSON.parse("") 抛难懂的错） */
const jsonField = (name: string): string[] => {
  const raw = field(name);
  assert(raw.startsWith("["), `--selfcheck 输出缺少 ${name}（或格式不是数组）：\n${out}`);
  return JSON.parse(raw) as string[];
};

// 浏览器就绪判据必须与「可执行文件存在」同口径，而不是「ms-playwright 目录存在」。
const exe = chromium.executablePath();
const exeExists = Boolean(exe) && existsSync(exe);
assert(field("browserExecutable") === JSON.stringify(exe), "--selfcheck 报告的浏览器路径必须与 chromium.executablePath() 一致");
assert(field("browserExecutableExists") === String(exeExists), "--selfcheck 的可执行文件存在性必须与 existsSync(executablePath()) 一致");
assert(field("browserReady") === String(exeExists), "playwrightBrowsersReady() 必须与 existsSync(chromium.executablePath()) 同口径（否则 --e2e 假红/假绿）");
// 旧判据（只看目录）在浏览器被清掉、目录残留时为 true —— 这正是"假就绪"的来源。
// 不硬断言 false（CI 装了浏览器），只断言：目录存在时**不允许**无条件判定就绪。
if (field("playwrightDirExists") === "true" && !exeExists) {
  assert(field("browserReady") === "false", "ms-playwright 目录存在但 chromium 可执行文件缺失时，必须判为未就绪（否则 --e2e 假红）");
}

// 组装目录解析：engine-check 的入参全靠它
const probePath = String.raw`C:\Users\x\AppData\Local\Temp\novelforge-e2e-Probe1`;
assert(field("parsed") === JSON.stringify(probePath), "runner 必须能从 e2e-demo 输出里解析出组装目录（含 Windows 反斜杠路径）");
assert(field("parsedMissing") === "null", "没有「[5] 组装完成」行时必须返回 null（不能瞎猜目录）");

// ── ② runner 与 e2e-demo 的输出契约：[5] 组装完成: <path> ──
// runner 用这个正则从 stdout 里取目录，再作为 engine-check 的入参；格式一变，engine-check 就没输入了。
const e2eSrc = readFileSync(join(ROOT, "tests", "e2e-demo.ts"), "utf8");
assert(e2eSrc.includes("[5] 组装完成: "), "e2e-demo 必须保持 `[5] 组装完成: <path>` 这一行（runner 靠它取 engine-check 入参）");
assert(e2eSrc.includes("NF_KEEP_E2E_DIR"), "e2e-demo 必须支持 NF_KEEP_E2E_DIR=1 保留目录（engine-check 要用它）");
assert(/tauri\.removePath\(tmpRoot\)/.test(e2eSrc), "e2e-demo 成功路径必须递归删除临时根目录（否则每次残留 ~40MB）");
assert(/process\.exitCode = 1/.test(e2eSrc), "e2e-demo 失败路径必须置非零退出码（否则失败会被当成通过）");
assert(/\[保留现场\]/.test(e2eSrc), "e2e-demo 失败时必须打印保留的现场路径（便于排查）");

// ── ③ engine-check 必须已从 MANUAL 移入 browser 层，且由 runner 传入组装目录 ──
const runnerSrc = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
const manual = jsonField("manual");
const browser = jsonField("browser");
assert(!manual.includes("engine-check.ts"), "engine-check.ts 不能留在 MANUAL 里（那样它永不自动执行 = 假门禁）");
assert(browser.includes("engine-check.ts"), "engine-check.ts 必须进入 BROWSER 层（--e2e / CI 才跑）");
assert(manual.includes("stage-runner.ts"), "stage-runner.ts 仍需留在 MANUAL（要 API 密钥）");
assert(/ASSEMBLY_PRODUCER = "e2e-demo\.ts"/.test(runnerSrc), "runner 必须声明产出组装目录的用例是 e2e-demo.ts");
assert(/NF_KEEP_E2E_DIR: "1"/.test(runnerSrc), "runner 跑 e2e-demo 时必须置 NF_KEEP_E2E_DIR=1，否则 engine-check 拿到的是已删除的目录");
assert(/args: file === "engine-check\.ts" \? \[assembledDir\]/.test(runnerSrc), "runner 必须把 e2e-demo 的组装目录作为参数传给 engine-check");

// engine-check.ts 不在本卡可改文件内：它读 process.argv[2] 作为待检查目录，
// 所以 runner 只能"传参"，不能"改它"。若它未来改成别的参数形式，这条断言会先红。
const engineSrc = readFileSync(join(ROOT, "tests", "engine-check.ts"), "utf8");
assert(/process\.argv\[2\]/.test(engineSrc), "engine-check 必须以 process.argv[2] 接收游戏目录（runner 依赖该约定传参）");
assert(/if \(!ROOT\) throw/.test(engineSrc), "engine-check 缺参数时必须报错，而不是静默跳过");

// ── ④ 孤儿清扫的边界行为 ──
// 与 runner 中 sweepOrphanE2eDirs 同逻辑的副本：只删「前缀命中 + 目录年龄超阈值」的目录。
// 为什么必须有年龄门槛：并行的其它用例可能正在写自己的临时目录，按名字删会把它连根拔掉。
const PREFIXES = ["novelforge-e2e-", "novelforge-engine-check-"];
function sweepReplica(dir: string, minAgeMs: number): string[] {
  const removed: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!PREFIXES.some((p) => e.name.startsWith(p))) continue;
    const full = join(dir, e.name);
    try {
      if (now - statSync(full).mtimeMs < minAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      /* 单个目录删不掉不影响其它 */
    }
  }
  return removed;
}

const sweepRoot = mkdtempSync(join(tmpdir(), "novelforge-sweep-fixture-"));
try {
  const oldE2e = join(sweepRoot, "novelforge-e2e-OLD001");
  const newE2e = join(sweepRoot, "novelforge-e2e-NEW001");
  const oldEngine = join(sweepRoot, "novelforge-engine-check-OLD001");
  const otherPrefix = join(sweepRoot, "novelforge-cache-test-OLD001"); // 别人管的目录，不该被扫
  const unrelated = join(sweepRoot, "unrelated-dir");
  for (const d of [oldE2e, newE2e, oldEngine, otherPrefix, unrelated]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "payload.bin"), "x"); // 必须有内容，才能证明是"递归删除"
  }
  const stale = new Date(Date.now() - 72 * HOUR);
  for (const d of [oldE2e, oldEngine, otherPrefix, unrelated]) utimesSync(d, stale, stale);

  const removed = sweepReplica(sweepRoot, 48 * HOUR);
  assert(removed.length === 2, `应只删 2 个孤儿目录，实际删了 ${removed.length} 个：${removed.join(", ")}`);
  assert(!existsSync(oldE2e), "超过阈值且前缀命中的 e2e 目录必须被递归删除");
  assert(!existsSync(oldEngine), "engine-check 的截图产物目录也必须被回收（它自己不做清理）");
  assert(existsSync(newE2e), "未超过阈值的目录必须保留 —— 可能正有并行用例在跑");
  assert(existsSync(otherPrefix), "前缀不匹配的目录必须保留（各测试文件各管各的临时目录）");
  assert(existsSync(unrelated), "无关目录必须保留");

  // runner 里必须真的接上了这个清扫，且留了关闭开关（保留现场排查用）
  assert(/sweepOrphanE2eDirs\(/.test(runnerSrc), "runner 启动时必须调用孤儿清扫");
  assert(/NF_TMP_SWEEP === "0"/.test(runnerSrc), "孤儿清扫必须有 NF_TMP_SWEEP=0 关闭开关");
  assert(/ORPHAN_PREFIXES = \["novelforge-e2e-", "novelforge-engine-check-"\]/.test(runnerSrc), "清扫前缀必须限定为 e2e / engine-check 两类临时目录");
} finally {
  rmSync(sweepRoot, { recursive: true, force: true });
}

// 自检：本文件确实是被 tsx/node 直接执行的（防止有人把它改名后不再被 unit 层收集）
assert(import.meta.url === pathToFileURL(process.argv[1] ?? "").href, "unit-fix-gates.ts 应由 runner 直接执行");

console.log("✓ 门禁自测通过：浏览器探测同口径 / 组装目录解析 / 孤儿清扫 / engine-check 接入");
