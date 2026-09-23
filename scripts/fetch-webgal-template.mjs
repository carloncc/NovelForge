#!/usr/bin/env node
/**
 * 获取 WebGAL 引擎模板（构建/运行所需）。
 * 用法：pnpm prepare:template
 * 下载官方 WebGAL 网页版包 → 解压 → 裁剪 demo 内容 → src-tauri/templates/webgal
 */
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src-tauri", "templates", "webgal");
const VERSION = "4.6.3";
// #1310：模板 zip 钉 hash（防镜像 compromised 下发恶意包）。
// 哈希由 WEBGAL_TEMPLATE_SHA256 注入（CI secret/变量）；缺失时只告警不断链，
// 存在即强制校验，不匹配直接抛错中断构建。
const EXPECTED_SHA256 = (process.env.WEBGAL_TEMPLATE_SHA256 ?? "").trim().toLowerCase();
const URLS = [
  `https://github.com/OpenWebGAL/WebGAL/releases/download/${VERSION}/WebGAL-${VERSION}-web.zip`,
  `https://ghfast.top/https://github.com/OpenWebGAL/WebGAL/releases/download/${VERSION}/WebGAL-${VERSION}-web.zip`,
];
const DOWNLOAD_TIMEOUT_MS = 300_000;

// 裁剪：引擎运行时不需要的演示内容（字体等保留）
const REMOVE = [
  "game/vocal",
  "game/bgm",
  "game/video",
  "game/scene",
  "game/background",
  "game/figure",
];

async function download(url, dest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
  await verifyZipHash(dest);
}

/** #1310：zip 哈希校验（钉 hash，无 hash 时告警） */
async function verifyZipHash(zipPath) {
  if (!EXPECTED_SHA256) {
    console.warn("[novelforge] 警告: 未设置 WEBGAL_TEMPLATE_SHA256，跳过模板 zip 哈希校验（建议在 CI 中钉住）");
    return;
  }
  const hash = createHash("sha256");
  const data = await readFile(zipPath);
  hash.update(data);
  const actual = hash.digest("hex").toLowerCase();
  if (actual !== EXPECTED_SHA256) {
    throw new Error(`模板 zip 哈希不匹配：期望 ${EXPECTED_SHA256}，实际 ${actual}（可能镜像被污染，已中断）`);
  }
  console.log("模板 zip 哈希校验通过");
}

/** #1310：路径必须落在项目根内，防止 zip/TARGET 被意外指向系统目录后 rm -rf */
function assertInsideRoot(p, label) {
  const abs = resolve(p);
  const root = resolve(ROOT);
  if (abs !== root && !abs.startsWith(root + "\\") && !abs.startsWith(root + "/")) {
    throw new Error(`${label} 越界：${p} 不在项目根内，已拒绝`);
  }
}

/** #1310：PowerShell 单引号转义（''），配合 -LiteralPath 避免路径注入 */
function psQuote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 内容一致判断：先比大小，再比字节内容。
 * 旧的 mtime 相等判断不可靠——copyFile 之后目标 mtime 是新写入时间，与源永远不同，
 * 导致每次构建都重拷；而仅比较 mtime 也可能漏掉"内容变了但时间戳恰好一致"的情况。
 */
async function sameContent(a, b) {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
  return ba.equals(bb);
}

/** 幂等同步：目标缺失或内容不一致时才 copyFile */
async function syncFile(src, dest, label) {
  if (!(await exists(dest)) || !(await sameContent(src, dest))) {
    await copyFile(src, dest);
    console.log(label);
  }
}

/** 鉴赏室页面随模板一起分发（web 模式 / include_dir 内嵌共用这一份），幂等确保存在 */
async function ensureAppreciation() {
  const src = join(ROOT, "src", "gameExtra", "appreciation.html");
  const dest = join(TARGET, "appreciation.html");
  if (await exists(src)) {
    await syncFile(src, dest, "鉴赏室页面已同步：appreciation.html");
  }
}

/**
 * 游戏界面定制（标题画面 / 文本框 / 选项 / 全局主题）随模板一起分发。
 * 源文件位于 src/gameExtra/game-ui/，保证模板重下载后定制不丢失。
 */
const GAME_UI_COPIES = [
  ["src/gameExtra/game-ui/userStyleSheet.css", "game/userStyleSheet.css"],
  ["src/gameExtra/game-ui/UI/Title/title.scss", "game/template/UI/Title/title.scss"],
  ["src/gameExtra/game-ui/Stage/TextBox/textbox.scss", "game/template/Stage/TextBox/textbox.scss"],
  ["src/gameExtra/game-ui/Stage/Choose/choose.scss", "game/template/Stage/Choose/choose.scss"],
];

async function ensureGameUi() {
  for (const [relSrc, relDest] of GAME_UI_COPIES) {
    const src = join(ROOT, relSrc);
    const dest = join(TARGET, relDest);
    if (!(await exists(src))) continue;
    await mkdir(dirname(dest), { recursive: true });
    await syncFile(src, dest, `游戏界面定制已同步：${relDest}`);
  }
}

/**
 * 内置音效（SE）随模板分发：组装时 project.ts 会从模板 game/vocal 复制 se_*.wav，
 * 而下载包里的 game/vocal 已被 REMOVE 裁掉，必须从 src/gameExtra/se 回填。
 * 否则全新检出 / CI 构建出的发布包开启 SE 后会出现 playEffect 指向不存在的音频。
 */
async function ensureBuiltinSe() {
  const srcDir = join(ROOT, "src", "gameExtra", "se");
  if (!(await exists(srcDir))) return;
  const destDir = join(TARGET, "game", "vocal");
  await mkdir(destDir, { recursive: true });
  for (const name of await readdir(srcDir)) {
    if (!name.endsWith(".wav")) continue;
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    await syncFile(src, dest, `内置音效已同步：game/vocal/${name}`);
  }
}

/**
 * 配音中断定制：WebGAL 引擎默认 voiceInterruption=no，导致快进/跳句时旧语音完整播完、不中断。
 * 这里把默认值改为 yes（新句开始即中断上一句语音），让生成的游戏更符合 galgame 习惯。
 * 幂等：仅当文件中仍为 ud.no 时替换，重下载模板后自动重新应用。
 */
async function ensureVoiceInterruptionPatch() {
  const assetsDir = join(TARGET, "assets");
  if (!(await exists(assetsDir))) {
    console.warn("[novelforge] 警告: 模板缺少 assets 目录，跳过配音中断定制");
    return;
  }
  // 引擎入口 JS 带内容哈希（index-<hash>.js），不能硬编码；用目录扫描定位，
  // 找不到时显式警告（WebGAL 升级改了产物结构时这里要跟着调整）
  const entryName = (await readdir(assetsDir)).find((name) => /^index-.*\.js$/.test(name));
  if (!entryName) {
    console.warn("[novelforge] 警告: 未找到 assets/index-*.js，跳过配音中断定制（引擎包结构可能已变化）");
    return;
  }
  const entry = join(assetsDir, entryName);
  let text = await readFile(entry, "utf8");
  if (text.includes("voiceInterruption:ud.no")) {
    text = text.replaceAll("voiceInterruption:ud.no", "voiceInterruption:ud.yes");
    await writeFile(entry, text, "utf8");
    console.log(`配音中断定制已应用(${entryName})：voiceInterruption 默认 -> yes（快进时语音会被中断）`);
  }
}

async function main() {
  const index = join(TARGET, "index.html");
  if (await exists(index)) {
    await ensureAppreciation();
    await ensureGameUi();
    await ensureBuiltinSe();
    await ensureVoiceInterruptionPatch();
    console.log(`引擎模板已存在：${TARGET}`);
    return;
  }

  const zip = join(ROOT, ".template-cache", `WebGAL-${VERSION}-web.zip`);
  await mkdir(dirname(zip), { recursive: true });

  let lastErr;
  for (const url of URLS) {
    try {
      console.log(`下载引擎模板：${url}`);
      await download(url, zip);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`下载失败（${e.message}），尝试下一个源…`);
    }
  }
  if (lastErr) throw lastErr;

  console.log("解压中…");
  assertInsideRoot(TARGET, "模板目标目录");
  assertInsideRoot(zip, "模板 zip");
  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });
  const unzip = spawnSync("unzip", ["-o", zip, "-d", TARGET], { stdio: "ignore" });
  if (unzip.status !== 0) {
    // Windows runner：尝试 PowerShell Expand-Archive（路径走转义后的字面量，不拼 shell）
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(TARGET)} -Force`],
      { stdio: "ignore" },
    );
    if (ps.status !== 0) {
      // 通用兜底：python3 / python（路径走 argv，不拼进 -c 代码字符串）
      let pyOk = false;
      for (const py of ["python3", "python"]) {
        const r = spawnSync(
          py,
          ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zip, TARGET],
          { stdio: "ignore" },
        );
        if (r.status === 0) {
          pyOk = true;
          break;
        }
      }
      if (!pyOk) {
        throw new Error("解压失败：需要 unzip / powershell / python 之一");
      }
    }
  }

  console.log("裁剪演示内容…");
  for (const p of REMOVE) {
    await rm(join(TARGET, p), { recursive: true, force: true });
  }
  // 清理无用的 .gz 预压缩副本（本地服务器不使用）
  for (const f of await readdir(join(TARGET, "assets"))) {
    if (f.endsWith(".gz")) {
      await rm(join(TARGET, "assets", f), { force: true });
    }
  }
  await rm(zip, { force: true });

  await ensureAppreciation();
  await ensureGameUi();
  await ensureBuiltinSe();
  await ensureVoiceInterruptionPatch();
  console.log(`引擎模板就绪：${TARGET}`);
}

main().catch((e) => {
  console.error("获取引擎模板失败：", e.message);
  process.exit(1);
});
