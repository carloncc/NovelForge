/**
 * 配置/能力/音色/剧本提示词加固包（#1125/#1126/#1135/#1136/#1139/#1149/#1131）：
 * 只覆盖白名单内的纯函数（配置页逻辑下沉到各模块后在此单测）。
 */
import {
  isImageCapabilityConflict,
  knownImageModelCapabilities,
  normalizeModelId,
  resolveContextLength,
  resolveImageModelCapabilities,
} from "../src/api/providers";
import { checkCustomTemplate } from "../src/api/templates";
import {
  VOICE_LIBRARY_EMPTY_MESSAGE,
  isVoiceLibraryEmpty,
  requireVoiceLibrary,
  voiceLibraryFor,
} from "../src/stores/config";
import { buildVoiceJobs } from "../src/core/voice";
import {
  buildScriptSystemPrompt,
  cgPromptRule,
  resolveCgMax,
  SCRIPT_CG_DEFAULT_MAX,
  videoPointsPromptRule,
} from "../src/core/script";
import { nodeDefaultDir } from "../src/utils/tauri";
import type { ApiConfig, ChapterScript, CharacterCard } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function imageCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: "img1", name: "img", baseUrl: "https://api.test.com", apiKey: "k",
    model: "Qwen/Qwen-Image-Edit-2509", ...over,
  };
}

/* ---------- #1149：规范化模型 id + 前缀/后缀匹配 ---------- */
assert(normalizeModelId("siliconflow/Qwen/Qwen-Image-Edit-2509:free") === "qwen-image-edit-2509", "应去 vendor 前缀与 :tag 后缀");
assert(normalizeModelId("openai/gpt-image-2") === "gpt-image-2", "应取最后一段并小写");
assert(normalizeModelId("gpt-image-2-2026-01-15") === "gpt-image-2-2026-01-15", "无前后缀保持原样");
assert(normalizeModelId("model@snap1") === "model", "@snapshot 后缀应去掉");
assert(normalizeModelId("") === "" && normalizeModelId(undefined) === "", "空模型应返回空串");

assert(knownImageModelCapabilities("openai/gpt-image-2")?.supportsImageEdit === true, "前缀模型应命中 gpt-image 族");
assert(knownImageModelCapabilities("siliconflow/Qwen/Qwen-Image-Edit-2509:free")?.maxReferenceImages === 3, "后缀模型应命中 qwen 族");
assert(knownImageModelCapabilities("gpt-image-2-2026-01-15")?.supportsImageEdit === true, "日期后缀应按族前缀命中");
assert(knownImageModelCapabilities("unknown-model-xyz") === undefined, "未知模型应返回 undefined");

// 探测标记比较也要归一化：网关加前后缀后，旧探测结果不应被误判「换模型」而作废
const stored = {
  maxReferenceImages: 3, supportsSeed: true, supportsImageEdit: true, referenceEncoding: "data-url",
} as const;
const stamped = imageCfg({
  model: "siliconflow/Qwen/Qwen-Image-Edit-2509:free",
  extra: { imageCapabilities: { ...stored }, imageCapabilitiesModel: "Qwen/Qwen-Image-Edit-2509" },
});
assert(resolveImageModelCapabilities(stamped).supportsImageEdit === true, "归一化后同模型应信任已探测能力");

// 上下文长度同样归一化匹配，不再静默回退 128k
const ctxCfg = {
  model: "Qwen/Qwen3-235B-A22B-Instruct:free",
  extra: { discoveredModels: [{ id: "Qwen/Qwen3-235B-A22B-Instruct", capabilities: ["llm"], contextLength: 32000 }] },
};
assert(resolveContextLength(ctxCfg as never) === 32000, "加 :free 后缀仍应命中探测的上下文长度");

/* ---------- #1125：图片能力冲突 ---------- */
assert(isImageCapabilityConflict({ maxReferenceImages: 1, supportsImageEdit: false }), "参考图>0 且未开图生图即冲突");
assert(!isImageCapabilityConflict({ maxReferenceImages: 0, supportsImageEdit: false }), "参考图为 0 不冲突");
assert(!isImageCapabilityConflict({ maxReferenceImages: 3, supportsImageEdit: true }), "已开图生图不冲突");

/* ---------- #1126：自定义模板先校验再写入 ---------- */
assert(checkCustomTemplate('{"endpoint": "/v1/x", "requestMap": {}}').ok, "合法模板应通过");
const bad = checkCustomTemplate('{"endpoint": "/v1/x",');
assert(!bad.ok && !bad.ok, "非法 JSON 应失败");
if (!bad.ok) assert(typeof bad.error === "string" && bad.error.length > 0, "失败应给出可读错误");
const missing = checkCustomTemplate('{"id": "x"}');
assert(!missing.ok, "缺 endpoint/requestMap 应失败");

/* ---------- #1139：音色库清空行为一致 ---------- */
const emptyCfg = imageCfg({ extra: { voiceLibrary: [] } });
assert(voiceLibraryFor(emptyCfg).length === 0, "显式 [] 应保持为空，不再回填默认表");
assert(isVoiceLibraryEmpty(emptyCfg), "显式 [] 应判空");
assert(!isVoiceLibraryEmpty(imageCfg({ extra: undefined })), "undefined 回退默认表，不算空");
let threw = false;
try {
  requireVoiceLibrary(emptyCfg);
} catch (e) {
  threw = (e as Error).message === VOICE_LIBRARY_EMPTY_MESSAGE;
}
assert(threw, "空库应抛可读错误（禁止回退假音色 default）");

const cards: CharacterCard[] = [
  { id: "hero", name: "Hero", gender: "male", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
];
const chapter: ChapterScript = {
  chapter: 0, title: "t",
  scenes: [{ id: "s1", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], figures: [], lines: [{ type: "dialogue", characterId: "hero", text: "你好。" }] }],
};
let voiceThrew = false;
try {
  buildVoiceJobs(emptyCfg, [chapter], cards);
} catch (e) {
  voiceThrew = (e as Error).message === VOICE_LIBRARY_EMPTY_MESSAGE;
}
assert(voiceThrew, "空库 buildVoiceJobs 应直接抛可读错误，不逐句 400 重试");

/* ---------- #1135/#1136：提示词条件注入 ---------- */
assert(resolveCgMax(undefined) === SCRIPT_CG_DEFAULT_MAX, "缺省 CG 上限回退默认 3");
assert(resolveCgMax(0) === SCRIPT_CG_DEFAULT_MAX, "0=不限制仍受提示词默认 3 约束");
assert(resolveCgMax(2) === 2, "用户上限应原样生效");

assert(videoPointsPromptRule(false).includes("不要输出 videoPoints"), "关闭视频位应明确要求不输出");
assert(videoPointsPromptRule(true, 1).includes("不超过 1 个"), "限数时应注入整章上限");
assert(videoPointsPromptRule(undefined) === "", "缺省不注入（调用方行为不变）");
assert(cgPromptRule(2).includes("不超过 2 个"), "CG 上限应注入覆盖规则 5");
assert(cgPromptRule(undefined) === "", "缺省不注入");

const basePrompt = buildScriptSystemPrompt({ imageOnly: false });
assert(!basePrompt.includes("已关闭视频推荐位") && !basePrompt.includes("CG 上限"), "缺省提示词与旧版一致");
const offPrompt = buildScriptSystemPrompt({ imageOnly: false, useVideoPoints: false });
assert(offPrompt.includes("不要输出 videoPoints"), "关闭后提示词不再要求视频位");
assert(offPrompt.includes("覆盖上文规则 6"), "关闭规则应声明覆盖关系");
const cgPrompt = buildScriptSystemPrompt({ imageOnly: false, cgMax: 2 });
assert(cgPrompt.includes("不超过 2 个") && cgPrompt.includes("覆盖上文规则 5"), "CG 上限应覆盖规则 5");

/* ---------- #1131：Node 分支不用开发机硬编码路径 ---------- */
const savedEnv = process.env.NOVELFORGE_OUTPUT_DIR;
process.env.NOVELFORGE_OUTPUT_DIR = "/tmp/nf-test-output";
assert(nodeDefaultDir("output") === "/tmp/nf-test-output", "环境变量应优先");
assert(nodeDefaultDir("resources") === "/tmp/nf-test-output/resources", "resources 随环境变量派生");
if (savedEnv === undefined) delete process.env.NOVELFORGE_OUTPUT_DIR;
else process.env.NOVELFORGE_OUTPUT_DIR = savedEnv;
const cwdOut = nodeDefaultDir("output");
assert(!cwdOut.startsWith("/root/my_project"), "回退目录不得是开发机绝对路径");
assert(cwdOut.endsWith("/output"), "回退目录应为 cwd/output");

console.log("=== 配置加固包测试通过 ===");
