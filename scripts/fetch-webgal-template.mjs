#!/usr/bin/env node
/**
 * 获取 WebGAL 引擎模板（构建/运行所需）。
 * 用法：pnpm prepare:template
 * 下载官方 WebGAL 网页版包 → 校验 sha256 → 解压 → 裁剪 demo 内容 → src-tauri/templates/webgal
 * 同时把上游 LICENSE（MPL-2.0）放进模板根目录：模板被 include_dir! 编进二进制、并随
 * bundle.resources 分发，且本脚本会改写引擎产物（见 THIRD_PARTY_MODIFICATIONS.md），
 * 因此随包必须带许可证副本。
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
const VERSION = "4.6.6";

/**
 * #1310 供应链校验（2026-10-13 修复：默认值钉在代码里，缺失/不匹配一律中断构建）。
 *
 * 旧实现只从 WEBGAL_TEMPLATE_SHA256 取期望哈希，未设置时**仅告警后 return** —— 于是
 * 「本机开发者 + 新检出 + CI 两个 job」走的都是「无校验」路径，而第二下载源还是第三方
 * 加速镜像。注释承诺的防护等级与默认行为完全不符。
 *
 * 现在：官方资产摘要写在代码里作为默认值（来源 GitHub Releases API 的 assets[].digest，
 * 4.6.6 实测），环境变量只作为显式覆盖口；两者都缺失 → 直接抛错，不再静默放行。
 * 升级 VERSION 时必须同步更新本表（缺失会立刻中断构建，不会静默跳过）。
 */
const OFFICIAL_RELEASE_DIGESTS = {
  "4.6.6": {
    asset: "WebGAL-4.6.6-web.zip",
    size: 52837011,
    sha256: "d8011933005f62397b3d1ea6cd14b8a7f58ce34a390000afa48f12a2d8f0349a",
  },
};

/** 上游 LICENSE（MPL-2.0）的 sha256：GitHub contents API 在 tag 4.6.6 / commit 15173bc 上实测一致 */
const WEBGAL_LICENSE_SHA256 = "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5";
const WEBGAL_LICENSE_SOURCES = [
  `https://raw.githubusercontent.com/OpenWebGAL/WebGAL/${VERSION}/LICENSE`,
  `https://api.github.com/repos/OpenWebGAL/WebGAL/contents/LICENSE?ref=${VERSION}`,
];

const OVERRIDE_SHA256 = (process.env.WEBGAL_TEMPLATE_SHA256 ?? "").trim().toLowerCase();
// 下载超时：官方源在部分网络下极慢（实测 52MB 超过 5 分钟），超时会留下"删了旧模板又下不到新的"
// 的半途状态。允许用环境变量放宽（CI 可设 600000），默认仍为 5 分钟。
const DOWNLOAD_TIMEOUT_MS = Number(process.env.NF_TEMPLATE_TIMEOUT_MS ?? 300_000);

/** 解析期望摘要：代码内常量优先，env 仅作显式覆盖；都缺失即中断（不再默认放行） */
function resolveExpectedDigest() {
  const pinned = OFFICIAL_RELEASE_DIGESTS[VERSION];
  if (OVERRIDE_SHA256) {
    if (OVERRIDE_SHA256 === "skip") {
      // 显式选择不校验：必须自带该字样，避免"忘了设变量"退化成无校验
      console.warn("[novelforge] 警告: WEBGAL_TEMPLATE_SHA256=skip —— 已按显式要求跳过 zip 哈希校验（仅用于本地排障）");
      return { sha256: "", size: pinned?.size ?? 0, source: "env:skip" };
    }
    return { sha256: OVERRIDE_SHA256, size: pinned?.size ?? 0, source: "env:WEBGAL_TEMPLATE_SHA256" };
  }
  if (!pinned) {
    throw new Error(
      `未为 WebGAL ${VERSION} 钉住官方资产摘要：请在 scripts/fetch-webgal-template.mjs 的 ` +
        `OFFICIAL_RELEASE_DIGESTS 中补上 ${VERSION} 的 sha256（取自 GitHub Releases API 的 assets[].digest），` +
        `或用 WEBGAL_TEMPLATE_SHA256=<sha256> 显式覆盖后重跑。拒绝在无校验的情况下下载模板。`,
    );
  }
  return { sha256: pinned.sha256, size: pinned.size, source: "pinned" };
}

const OFFICIAL_ZIP_URL = `https://github.com/OpenWebGAL/WebGAL/releases/download/${VERSION}/WebGAL-${VERSION}-web.zip`;
// 第三方加速镜像只作**官方源失败后的兜底**，且下载后照样走同一个 sha256 校验（校验是防镜像
// 污染的正确手段；旧实现把它排在第二位且默认不校验，等于把供应链交给镜像）。
const MIRROR_ZIP_URL = `https://ghfast.top/${OFFICIAL_ZIP_URL}`;

// 裁剪：引擎运行时不需要的演示内容（字体等保留）
const REMOVE = [
  "game/vocal",
  "game/bgm",
  "game/video",
  "game/scene",
  "game/background",
  "game/figure",
];

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex").toLowerCase();
}

/** 带超时的网络请求（UA 必填：GitHub API 对无 UA 请求返回 403） */
async function fetchWithTimeout(url, { timeoutMs = 60_000, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "user-agent": "NovelForge-build" };
    if (accept) headers.accept = accept;
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

async function download(url, dest, expected) {
  // 超时必须覆盖**整个流**（含 body）：只在 fetch() 期间计时会在 body 卡住时永远挂起
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "NovelForge-build" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(dest));
  } catch (e) {
    // 中断/超时/连接重置都会在半截文件上失败：verifyZipHash 只在完整流之后才会跑，
    // 所以半截文件永远不会被校验、也永远不会被识别为坏文件，却会一直占着
    // .template-cache/ 的磁盘（120MB 的包传到 60MB 就断是常见情况）。
    // 失败即清掉，绝不把残留文件留给下一次运行。
    await rm(dest, { force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  await verifyZipHash(dest, expected);
}

/** #1310：zip 哈希校验（期望值来自代码内常量或 env 覆盖；缺失/不匹配一律中断构建） */
async function verifyZipHash(zipPath, expected) {
  // 大小检查独立于哈希：即使哈希被 env 覆盖成空（显式 skip），大小仍要对照钉住值
  if (expected.size) {
    const { size } = await stat(zipPath);
    if (size !== expected.size) {
      throw new Error(`模板 zip 大小不匹配：期望 ${expected.size} 字节，实际 ${size} 字节（已中断）`);
    }
  }
  if (!expected.sha256) return;
  const actual = sha256Hex(await readFile(zipPath));
  if (actual !== expected.sha256) {
    throw new Error(
      `模板 zip 哈希不匹配：期望 ${expected.sha256}（来源 ${expected.source}），实际 ${actual}（可能镜像被污染，已中断）`,
    );
  }
  console.log(`模板 zip 哈希校验通过（sha256 ${actual.slice(0, 12)}…，来源 ${expected.source}）`);
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
 * 注意：这是对 MPL-2.0 覆盖代码（引擎压缩产物）的修改，已在 THIRD_PARTY_MODIFICATIONS.md 记录。
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

// file:// 协议探测（#1451）：模板 index.html 是 ES module 入口，file:// 下文档 origin 为不透明 null，
// 浏览器直接拦截模块加载，引擎不执行、页面卡在空白开始页。这里在 </body> 前注入一段探测脚本：
// file:// 打开时直接替换标题区文案，告诉用户用随包启动脚本 / http.server 打开。
// 幂等：已含标记（无法直接双击打开本游戏）则跳过；找不到 </body> 时显式警告（模板结构变化时要跟着调整）。
// 注入体见 scripts/file-protocol-probe.html（与代码分离，避免转义/编码问题）。
// 注意：这是对 MPL-2.0 覆盖代码（index.html）的修改，已在 THIRD_PARTY_MODIFICATIONS.md 记录。
const FILE_PROTOCOL_PROBE_MARKER = "无法直接双击打开本游戏";
async function ensureFileProtocolProbe() {
  const index = join(TARGET, "index.html");
  let text;
  try {
    text = await readFile(index, "utf8");
  } catch {
    console.warn("[novelforge] 警告: 模板缺少 index.html，跳过 file:// 协议探测注入");
    return;
  }
  if (text.includes(FILE_PROTOCOL_PROBE_MARKER)) return;
  let probe;
  try {
    probe = await readFile(join(ROOT, "scripts", "file-protocol-probe.html"), "utf8");
  } catch {
    console.warn("[novelforge] 警告: 缺少 scripts/file-protocol-probe.html，跳过 file:// 协议探测注入");
    return;
  }
  const closeBody = text.lastIndexOf("</body>");
  if (closeBody < 0) {
    console.warn("[novelforge] 警告: index.html 没有 </body>，跳过 file:// 协议探测注入（模板结构可能已变化）");
    return;
  }
  text = text.slice(0, closeBody) + probe + "\n" + text.slice(closeBody);
  await writeFile(index, text, "utf8");
  console.log("file:// 协议探测已注入 index.html");
}

/** 解码 GitHub contents API 的 base64（带换行）正文 */
function decodeApiContent(content) {
  return Buffer.from(String(content).replace(/\s+/g, ""), "base64").toString("utf8");
}

/**
 * 随包 LICENSE（MPL-2.0）：WebGAL 的许可证要求分发时随附许可证文本（§3.4），而模板根目录
 * 在上游 web 包里没有 LICENSE。这里从上游取一份放进模板根目录，并校验 sha256 与 MPL 正文特征。
 * 取不到就**明确告警并给出补救指令**（不静默通过）。
 */
async function ensureWebgalLicense() {
  const dest = join(TARGET, "LICENSE");
  const existing = await readFile(dest).catch(() => null);
  if (existing && sha256Hex(existing) === WEBGAL_LICENSE_SHA256) return;

  const errors = [];
  for (const url of WEBGAL_LICENSE_SOURCES) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 60_000, accept: "application/vnd.github.raw" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text = await res.text();
      if (text.trimStart().startsWith("{")) {
        // contents API 在非 raw Accept 下返回 JSON 信封
        const json = JSON.parse(text);
        text = json.content ? decodeApiContent(json.content) : text;
      }
      const buf = Buffer.from(text, "utf8");
      const hash = sha256Hex(buf);
      if (hash !== WEBGAL_LICENSE_SHA256) {
        throw new Error(`内容 sha256 ${hash} 与钉住的 ${WEBGAL_LICENSE_SHA256} 不一致`);
      }
      if (!/Mozilla Public License Version 2\.0/.test(text)) {
        throw new Error("内容不含 Mozilla Public License Version 2.0 正文");
      }
      await writeFile(dest, buf);
      console.log(`WebGAL 许可证已随包：${dest}（MPL-2.0，sha256 ${hash.slice(0, 12)}…，来源 ${url}）`);
      return;
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  console.warn(
    "[novelforge] 警告: 未能随包 WebGAL 的 LICENSE（MPL-2.0）。模板会被 include_dir! 编进二进制并随包分发，" +
      `且本脚本改写过引擎产物，随包缺许可证副本属已知合规缺口。\n  失败原因：\n  - ${errors.join("\n  - ")}\n` +
      "  补救：手动把 https://github.com/OpenWebGAL/WebGAL 的 LICENSE 放到 " +
      `${join("src-tauri", "templates", "webgal", "LICENSE")}（期望 sha256 ${WEBGAL_LICENSE_SHA256}），` +
      "或联网后重跑 pnpm prepare:template。",
  );
}

async function main() {
  const index = join(TARGET, "index.html");
  // 版本守卫：只判「目录存在」会让升级变成空操作 —— 本机/CI 上已有旧版模板时，
  // 改了 VERSION 却仍打补丁到旧产物上，`webgal-engine.json` 与 SUPPORTED_WEBGAL_VERSION
  // 长期不一致（单测会红，但人容易误判成"模板没问题"）。版本不符就整目录重建。
  if (await exists(index)) {
    const engineJson = join(TARGET, "webgal-engine.json");
    let installed = "";
    try {
      const parsed = JSON.parse(await readFile(engineJson, "utf8"));
      installed = parsed && typeof parsed === "object" ? String(parsed.version ?? "") : "";
    } catch {
      installed = "";
    }
    if (installed !== VERSION) {
      console.log(`引擎模板版本不符（已装 ${installed || "未知"}，期望 ${VERSION}）：删除旧模板并重新下载…`);
      assertInsideRoot(TARGET, "模板目标目录");
      await rm(TARGET, { recursive: true, force: true });
    }
  }
  if (await exists(index)) {
    await ensureAppreciation();
    await ensureGameUi();
    await ensureBuiltinSe();
    await ensureVoiceInterruptionPatch();
    await ensureFileProtocolProbe();
    await ensureWebgalLicense();
    console.log(`引擎模板已存在：${TARGET}`);
    return;
  }

  // 期望摘要先解析：没有钉住摘要就直接中断，不进入下载（旧实现是下完才"跳过校验"）
  const expected = resolveExpectedDigest();

  const zip = join(ROOT, ".template-cache", `WebGAL-${VERSION}-web.zip`);
  await mkdir(dirname(zip), { recursive: true });

  let lastErr;
  // 复用已校验的缓存 zip：官方源在部分网络下不可达/极慢，重复执行本脚本时没必要每次重下 52MB。
  // 命中条件必须是「大小 + sha256 与钉住的官方摘要完全一致」——校验不过的缓存一律丢弃重下。
  let reuseCache = false;
  if (await exists(zip)) {
    try {
      await verifyZipHash(zip, expected);
      console.log(`复用已校验的模板缓存：${zip}`);
      reuseCache = true;
    } catch (e) {
      console.warn(`模板缓存校验失败（${e.message}），丢弃并重新下载`);
      await rm(zip, { force: true }).catch(() => {});
    }
  }
  if (!reuseCache) {
    for (const url of [OFFICIAL_ZIP_URL, MIRROR_ZIP_URL]) {
      try {
        console.log(`下载引擎模板：${url}`);
        await download(url, zip, expected);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`下载失败（${e.message}），尝试下一个源…`);
      }
    }
  }
  if (!reuseCache && lastErr) throw lastErr;

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
  await ensureFileProtocolProbe();
  await ensureWebgalLicense();
  console.log(`引擎模板就绪：${TARGET}`);
}

main().catch((e) => {
  console.error("获取引擎模板失败：", e.message);
  process.exit(1);
});
