/**
 * #1517：渲染器已核实的引擎版本必须与随包模板一致。
 *
 * 渲染产物语法（config.txt 的键集合、Max_line 的真实容量、setFilter 与
 * setTransform 的语义差异）只对 SUPPORTED_WEBGAL_VERSION 成立；模板却由
 * scripts/fetch-webgal-template.mjs 独立升级。两者一旦漂移，游戏「能生成、
 * 但行为不对」，且没有任何线索可查。这里把它变成 CI 断言：升级模板但忘了
 * 同步渲染器结论时，门禁立刻失败，而不是等用户发现游戏不对劲。
 *
 * 2026-10-13 补充（供应链）：断言里**不写死版本号**，一律以「渲染器支持的版本」
 * 为基准逐处比对（模板 webgal-engine.json 的 version/webgalVersion、
 * game/template/template.json 的 webgal-version、fetch 脚本的 VERSION）。
 * 另外校验 fetch 脚本为该版本钉住了官方资产摘要（OFFICIAL_RELEASE_DIGESTS）——
 * 摘要缺失时 pnpm prepare:template 会中断，这条断言让「忘记补摘要」在单测阶段
 * 就暴露，而不是等到 CI 下载模板时。
 */
import { readFileSync } from "node:fs";
import { SUPPORTED_WEBGAL_VERSION } from "../src/core/render";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${ROOT}/${rel}`, "utf8")) as Record<string, unknown>;
}

function main(): void {
  assert(/^\d+\.\d+\.\d+$/.test(SUPPORTED_WEBGAL_VERSION), `版本号应为 x.y.z：${SUPPORTED_WEBGAL_VERSION}`);

  const engine = readJson("src-tauri/templates/webgal/webgal-engine.json");
  const tpl = readJson("src-tauri/templates/webgal/game/template/template.json");

  // webgal-engine.json 同时带 version 与 webgalVersion，两个字段都可能与渲染器漂移，必须逐个断言
  for (const field of ["version", "webgalVersion"] as const) {
    const declared = String(engine[field] ?? "");
    assert(declared === SUPPORTED_WEBGAL_VERSION,
      `webgal-engine.json 的 ${field} 声明 ${declared}，渲染器支持 ${SUPPORTED_WEBGAL_VERSION}——升级模板后必须同步核实渲染语义`);
  }
  const fromTemplate = String(tpl["webgal-version"] ?? "");
  assert(fromTemplate === SUPPORTED_WEBGAL_VERSION,
    `template.json 声明 ${fromTemplate}，与渲染器支持的 ${SUPPORTED_WEBGAL_VERSION} 不一致`);

  // fetch 脚本的 VERSION 也是独立第三处：它决定下载哪个模板
  const fetchScript = readFileSync(`${ROOT}/scripts/fetch-webgal-template.mjs`, "utf8");
  const m = /const VERSION = "([^"]+)"/.exec(fetchScript);
  assert(!!m, "未能从 fetch-webgal-template.mjs 解析出 VERSION");
  assert(m![1] === SUPPORTED_WEBGAL_VERSION,
    `fetch-webgal-template.mjs 的 VERSION=${m![1]} 与渲染器支持的 ${SUPPORTED_WEBGAL_VERSION} 不一致`);

  // 第四处：官方资产摘要（默认强制校验，不再依赖 CI 变量）
  const digestBlock = /const OFFICIAL_RELEASE_DIGESTS = \{([\s\S]*?)\n\};/.exec(fetchScript);
  assert(!!digestBlock, "未能从 fetch-webgal-template.mjs 解析出 OFFICIAL_RELEASE_DIGESTS");
  const pinned = new RegExp(`"${SUPPORTED_WEBGAL_VERSION.replace(/\./g, "\\.")}"\\s*:\\s*\\{[\\s\\S]*?sha256:\\s*"([0-9a-f]{64})"`).exec(digestBlock![1]);
  assert(!!pinned,
    `fetch-webgal-template.mjs 未为 ${SUPPORTED_WEBGAL_VERSION} 钉住官方 zip 摘要：` +
      `缺失时 pnpm prepare:template 会直接中断（这是有意的 fail-closed），请补上 GitHub Releases API 的 assets[].digest`);
  console.log(`模板 zip 摘要已钉住（${SUPPORTED_WEBGAL_VERSION}）：${pinned![1].slice(0, 12)}…`);

  console.log(`=== WebGAL 版本一致性测试通过（#1517，${SUPPORTED_WEBGAL_VERSION}）===`);
}

main();
