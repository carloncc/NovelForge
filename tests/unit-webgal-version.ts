/**
 * #1517：渲染器已核实的引擎版本必须与随包模板一致。
 *
 * 渲染产物语法（config.txt 的键集合、Max_line 的真实容量、setFilter 与
 * setTransform 的语义差异）只对 SUPPORTED_WEBGAL_VERSION 成立；模板却由
 * scripts/fetch-webgal-template.mjs 独立升级。两者一旦漂移，游戏「能生成、
 * 但行为不对」，且没有任何线索可查。这里把它变成 CI 断言：升级模板但忘了
 * 同步渲染器结论时，门禁立刻失败，而不是等用户发现游戏不对劲。
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

  console.log(`=== WebGAL 版本一致性测试通过（#1517，${SUPPORTED_WEBGAL_VERSION}）===`);
}

main();
