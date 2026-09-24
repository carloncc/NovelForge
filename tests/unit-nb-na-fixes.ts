/**
 * nb-nA 修清单单测（1384/1385/1386/1420 纯函数部分；1382/1383 为 UI/禁区逻辑，不在此覆盖）。
 * 运行：npx tsx tests/unit-nb-na-fixes.ts（亦被 scripts/run-tests.mjs 自动发现 unit-*.ts）。
 */
import { sanitizeContextLengthInput, MIN_CONTEXT_LENGTH } from "../src/api/providers";
import { shouldApplyCutoutStatus } from "../src/core/cutout/download";
import {
  VOICE_LIBRARY_EMPTY_MESSAGE,
  isVoiceLibraryEmpty,
  modelFetchSignature,
  shouldRefetchModels,
  mergeDiscoveredModels,
  applyDiscoveredModelsSuccess,
  applyDiscoveredModelsFailure,
  isModelEndpointChanged,
  requireVoiceLibrary,
  voiceLibraryFor,
} from "../src/stores/config";
import type { ApiConfig } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ttsCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: "tts1", name: "tts", baseUrl: "https://api.test.com", apiKey: "k",
    model: "speech-2.6-hd", extra: {}, ...over,
  };
}

function main(): void {
  // ---------- 1384：上下文长度清洗 ----------
  assert(MIN_CONTEXT_LENGTH === 1024, "下限应为 1024");
  assert(sanitizeContextLengthInput("") === undefined, "空串→undefined（回显空）");
  assert(sanitizeContextLengthInput("   ") === undefined, "空白→undefined");
  assert(sanitizeContextLengthInput("abc") === undefined, "非数字→undefined（不再写 NaN）");
  assert(sanitizeContextLengthInput("NaN") === undefined, "NaN 字符串→undefined");
  assert(sanitizeContextLengthInput("Infinity") === undefined, "Infinity→undefined");
  assert(sanitizeContextLengthInput("-5") === 1024, "负数 clamp 到 1024");
  assert(sanitizeContextLengthInput("0") === 1024, "0 clamp 到 1024");
  assert(sanitizeContextLengthInput("512") === 1024, "512 clamp 到 1024");
  assert(sanitizeContextLengthInput("1024") === 1024, "1024 保持");
  assert(sanitizeContextLengthInput("2048") === 2048, "2048 保持");
  assert(sanitizeContextLengthInput("128000.9") === 128000, "小数向下取整");
  assert(sanitizeContextLengthInput("  64000  ") === 64000, "首尾空格应 trim 后解析");

  // ---------- 1386：下载回调归属 ----------
  assert(shouldApplyCutoutStatus("a", "a") === true, "同模型应写状态");
  assert(shouldApplyCutoutStatus("a", "b") === false, "切模型后旧回调应丢弃");

  // ---------- 1385：拉取签名/合并策略 ----------
  const base = { id: "c1", baseUrl: "https://api.test.com/v1", apiKey: "sk-aaa", extra: { pathPrefix: "" } };
  const sameKey = { ...base };
  const changedKey = { ...base, apiKey: "sk-bbb" };
  assert(modelFetchSignature(base) === modelFetchSignature(sameKey), "同 key 签名应一致");
  assert(modelFetchSignature(base) !== modelFetchSignature(changedKey), "K→K 但内容变也应触发重拉（旧 presence 位会漏）");
  assert(modelFetchSignature({ ...base, apiKey: "" }) !== modelFetchSignature(base), "有无 key 签名应不同");
  assert(shouldRefetchModels(undefined, "x") === true, "无旧签名应拉取");
  assert(shouldRefetchModels("x", "x") === false, "签名一致不重拉");
  assert(shouldRefetchModels("x", "y") === true, "签名变化应重拉");
  const prev = [{ id: "m1" }];
  const next = [{ id: "m2" }];
  assert(mergeDiscoveredModels(prev, next) === next, "成功整体替换");
  assert(mergeDiscoveredModels(prev, undefined) === prev, "失败保留旧列表（不丢）");
  assert(mergeDiscoveredModels(prev, undefined, { baseUrlChanged: true, clearOnEndpointChange: true }).length === 0, "endpoint 变化且要求清空才清");
  assert(applyDiscoveredModelsSuccess(prev, next) === next, "成功入口替换");
  assert(applyDiscoveredModelsFailure(prev) === prev, "失败入口保留");
  assert(isModelEndpointChanged({ baseUrl: "a", pathPrefix: "" }, { baseUrl: "a", pathPrefix: "" }) === false, "同 endpoint 不算变化");
  assert(isModelEndpointChanged({ baseUrl: "a", pathPrefix: "" }, { baseUrl: "b", pathPrefix: "" }) === true, "baseUrl 变化应识别");
  assert(isModelEndpointChanged({ baseUrl: "a", pathPrefix: "x" }, { baseUrl: "a", pathPrefix: "y" }) === true, "前缀变化应识别");

  // ---------- 1420：音色库空库统一 key ----------
  assert(typeof VOICE_LIBRARY_EMPTY_MESSAGE === "string" && VOICE_LIBRARY_EMPTY_MESSAGE.length > 0, "主文案常量应存在");
  assert(VOICE_LIBRARY_EMPTY_MESSAGE.includes("音色列表"), "主文案应指引到「音色列表」入口");
  const cleared = ttsCfg({ extra: { voiceLibrary: [] } });
  assert(voiceLibraryFor(cleared).length === 0, "显式 [] 应视为空库");
  assert(isVoiceLibraryEmpty(cleared) === true, "空库判定应为 true");
  let thrown = "";
  try {
    requireVoiceLibrary(cleared);
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  // t() 缺翻译回退原文：外语词典补齐前消息仍等于 key 本身（中文行为不变），补齐后自动译文
  assert(thrown === VOICE_LIBRARY_EMPTY_MESSAGE, "空库抛出应经 t(主文案key)，中文行为不变、外语待词典补齐");
  const undefLib = ttsCfg({ extra: {} });
  assert(isVoiceLibraryEmpty(undefLib) === false, "undefined 回退默认表不算空");

  console.log("=== nb-nA 纯函数测试通过（1384/1385/1386/1420） ===");
}

main();
