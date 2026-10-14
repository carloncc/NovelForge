/**
 * 素材管线核查报告（2026-10-13）发现 2 / 3 / 6 的回归测试。
 *
 * 发现 2（🔴）配音缓存键不含全局 TTS 参数：
 *   旧 voiceFileName 只哈希「每句标注」的 speed/ttsEmotion（绝大多数台词没有标注 → 两项 undefined），
 *   而真正下发的是「每句优先、其次全局」（universal.ts 的 unifiedTts）。于是用户在「API 配置 > TTS」
 *   把全局语速从 1.1 拉到 1.6、或把输出格式从 mp3 改成 wav 后，旧音频照旧按同名命中
 *   （vocalHit 还会跨扩展名探测），日志宣称"全部命中缓存（0 计费）"，改动完全无效。
 *   现在 buildVoiceJobs 在构建期就把有效值解析进 job.speed/ttsEmotion/format —— 缓存键与实际
 *   下发值天然同源。
 *
 * 发现 3（🔴）OpenAI 兼容 TTS / 阿里 CosyVoice 预设不消费 $speed/$emotion：
 *   请求体只按模板 requestMap 构造，未映射的变量被静默丢弃。openai-tts 已按厂商官方文档补上
 *   speed（OpenAI 0.25~4.0，智谱 0.5~2 都支持）；情绪两家都没有对应字段，dashscope-tts 用的旧版
 *   parameters.* 端点也查无权威字段名（官方文档已改到 SpeechSynthesizer 的 input.rate/instruction），
 *   故这两处不臆造字段，改由「未消费变量」告警明确告知用户"已忽略"。
 *
 * 发现 6（🟡）配音落盘无体积上限：
 *   超限响应此前被原样写进缓存并登记为成品（还会被组装进游戏包）；现在落盘前校验，超限记失败项。
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_VOICE_B64_BYTES,
  buildVoiceJobs,
  runVoiceJob,
  splitVocalFileName,
  vocalHit,
} from "../src/core/voice";
import {
  DEFAULT_TTS_FORMAT,
  DEFAULT_TTS_SPEED,
  buildRequestBody,
  resetUnconsumedTtsWarnings,
  unconsumedTtsVars,
  unifiedTts,
} from "../src/api/universal";
import { getTemplate } from "../src/api/templates";
import { addLogListener } from "../src/utils/logger";
import { configState } from "../src/stores/config";
import type { ApiConfig, ChapterScript, CharacterCard, PipelineEvent } from "../src/core/types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/* ---------- 夹具 ---------- */

function ttsCfg(extra: Record<string, unknown> = {}): ApiConfig {
  return {
    id: "tts-1",
    name: "TTS 测试",
    baseUrl: "https://api.test.com",
    apiKey: "sk-test",
    model: "tts-1",
    adapter: "openai-tts",
    extra: { voiceLibrary: ["alloy", "nova"], ...extra },
  };
}

/** 角色不带 gender：voiceName 直接生效（避免性别纠错把音色换成库里的别的音色，保证文件名可比） */
const alice: CharacterCard = {
  id: "alice", name: "爱丽丝", appearance: "", clothing: "", personality: "",
  voiceDesc: "", voiceName: "alloy", imagePrompt: "", color: "#fff",
};

function chapter(lines: ChapterScript["scenes"][number]["lines"]): ChapterScript {
  return {
    chapter: 0,
    title: "第一章",
    scenes: [{ id: "s1", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], figures: [], lines }],
  };
}

/** 单条对话（无 speed/ttsEmotion 标注）+ 一条旁白 */
const plainChapter = chapter([
  { type: "dialogue", characterId: "alice", text: "你好，世界。" },
  { type: "narration", text: "远处传来钟声。" },
]);

function jobsFor(cfg: ApiConfig, ch: ChapterScript = plainChapter): ReturnType<typeof buildVoiceJobs> {
  return buildVoiceJobs(cfg, [ch], [alice]);
}

function fileOf(jobs: ReturnType<typeof buildVoiceJobs>, text: string): string {
  const job = jobs.find((j) => j.text === text);
  assert(job, `未找到文本为「${text}」的配音任务`);
  return job.file;
}

const DIALOGUE = "你好，世界。";
const NARRATION = "远处传来钟声。";

/* ---------- 发现 2：缓存键必须覆盖「真正下发」的全局参数 ---------- */

async function cacheKeyTests(): Promise<void> {
  // 1) 默认配置（无全局 speed/emotion，mp3）的文件名必须与升级前完全一致：
  //    旧公式 = `v_<key>_<fnv1a([configId|default:voice])>_<fnv1a([text, 1.1, undefined])>.mp3`，
  //    下面的两个字面量是用旧公式**独立复算**出来的（已逐字核对一致）。
  //    钉住它们是为了「不做无谓的缓存失效」——升级前生成的旧音频本就产自同一组参数，
  //    重配一次就是白花钱，而 #发现2 的修法很容易顺手把所有旧缓存一起作废。
  const base = jobsFor(ttsCfg());
  const baseFile = fileOf(base, DIALOGUE);
  assert(
    baseFile === "v_ch0_s1_0_1ykzav7_gxb984.mp3",
    `默认配置下的文件名必须与升级前一致（否则旧缓存全部失效、全库重配计费）：${baseFile}`,
  );
  assert(
    fileOf(base, NARRATION) === "v_ch0_s1_1_1ykzav7_1lc0pm1.mp3",
    `旁白在默认配置下同样必须保持旧文件名：${fileOf(base, NARRATION)}`,
  );

  // 2) 既有约定：未标注语速 ≡ 显式标注 1.1（下游兜底值），否则同一句话会存两份、重复计费
  const explicitDefault = fileOf(jobsFor(ttsCfg(), chapter([
    { type: "dialogue", characterId: "alice", text: DIALOGUE, speed: DEFAULT_TTS_SPEED },
  ])), DIALOGUE);
  assert(explicitDefault === baseFile, "未标注语速与显式标注 1.1 必须算出同一个文件名（既有约定）");

  // 3) 全局语速变化 → 必须换名（旧实现：全局参数不进缓存键，改语速后旧音频照旧命中）
  const slow = jobsFor(ttsCfg({ speed: 1.1 }));
  const fast = jobsFor(ttsCfg({ speed: 1.6 }));
  assert(fileOf(slow, DIALOGUE) === baseFile, "全局语速 1.1 与默认值同效，文件名应保持一致");
  assert(fileOf(fast, DIALOGUE) !== baseFile, "全局语速改成 1.6 后必须换文件名，否则旧音频会被当成新产物");
  const fastJob = fast.find((j) => j.text === DIALOGUE);
  assert(fastJob?.speed === 1.6, `全局语速应解析进 job.speed（实际 ${fastJob?.speed}）`);

  // 4) 全局情绪变化 → 必须换名
  assert(fileOf(jobsFor(ttsCfg({ emotion: "angry" })), DIALOGUE) !== baseFile, "全局情绪变化必须换文件名");

  // 5) 输出格式变化 → 必须换名**且换扩展名**（旧实现硬编码 .mp3，wav 也写 .mp3，
  //    且 vocalHit 跨扩展名探测会把旧 .mp3 直接当成新 .wav 的产物返回）
  const wavFile = fileOf(jobsFor(ttsCfg({ ttsFormat: "wav" })), DIALOGUE);
  assert(wavFile !== baseFile, "ttsFormat 从 mp3 改 wav 必须换文件名");
  assert(wavFile.endsWith(".wav"), `ttsFormat=wav 时扩展名应为 .wav（实际 ${wavFile}）`);
  const wavParsed = splitVocalFileName(wavFile);
  assert(!!wavParsed && wavParsed.hash !== splitVocalFileName(baseFile)!.hash, "换格式必须换内容哈希，否则跨扩展名探测仍会命中旧文件");
  assert(!!splitVocalFileName(wavFile), "换扩展名后 splitVocalFileName 仍须能解析出 fp/hash");

  // 6) 每句标注优先于全局：两种全局配置下，同一句「标注 1.3」的有效值相同 → 同一个缓存槽（不重复计费）
  const lineSpeed = chapter([{ type: "dialogue", characterId: "alice", text: DIALOGUE, speed: 1.3 }]);
  const a = fileOf(jobsFor(ttsCfg({ speed: 1.1 }), lineSpeed), DIALOGUE);
  const b = fileOf(jobsFor(ttsCfg({ speed: 1.6 }), lineSpeed), DIALOGUE);
  assert(a === b, "每句标注的语速优先于全局：有效值相同就该命中同一缓存槽");
  assert(a !== fileOf(fast, DIALOGUE), "标注 1.3 与全局 1.6 是不同参数，必须换名");
  assert(a !== baseFile, "标注 1.3 与默认 1.1 必须换名");

  // 7) 旁白同样吃全局参数（旧实现旁白连每句标注都没有，键里永远是 undefined）
  const narrFast = jobsFor(ttsCfg({ speed: 1.6 })).find((j) => j.text === NARRATION);
  assert(narrFast?.speed === 1.6, "旁白也必须解析出全局语速");
  assert(fileOf(fast, NARRATION) !== fileOf(base, NARRATION), "全局语速变化后旁白也必须换名");

  // 8) 克隆音色绑在另一个 TTS 配置上时，有效参数取**该配置**的值（与 runVoiceJob 的 jobConfig 同源）
  const cloneCfg: ApiConfig = { ...ttsCfg({ speed: 1.6, ttsFormat: "wav" }), id: "tts-clone", name: "克隆线路" };
  const previousPresets = configState.presets;
  const previousProfiles = configState.voiceProfiles;
  try {
    configState.presets = [{
      id: "p1", name: "P1",
      channels: { llm: [], vision: [], image: [], tts: [cloneCfg] },
      active: { llm: "", vision: "", image: "", tts: cloneCfg.id },
    }];
    configState.voiceProfiles = [{
      id: "clone-1", name: "Hero clone", provider: "minimax", ttsConfigId: cloneCfg.id,
      voiceId: "voice_hero", status: "ready", revision: 1, createdAt: new Date(0).toISOString(),
    }];
    const cloneJobs = buildVoiceJobs(ttsCfg(), [plainChapter], [{ ...alice, voiceProfileId: "clone-1" }]);
    const cloneJob = cloneJobs.find((j) => j.text === DIALOGUE);
    assert(cloneJob?.ttsConfigId === cloneCfg.id, "夹具应解析出克隆音色的 TTS 配置");
    assert(cloneJob?.speed === 1.6 && cloneJob?.format === "wav", `克隆线路的全局参数应取它自己绑定的配置（speed=${cloneJob?.speed} format=${cloneJob?.format}）`);
    assert(cloneJob.file.endsWith(".wav"), "克隆线路的文件名扩展名应跟随它自己的输出格式");
  } finally {
    configState.presets = previousPresets;
    configState.voiceProfiles = previousProfiles;
  }

  // 9) 端到端：改了全局语速后，磁盘上的旧文件不能再被命中（vocalHit 的跨扩展名探测也救不了）
  const dir = (await mkdtemp(join(tmpdir(), "novelforge-voicekey-"))).replace(/\\/g, "/");
  const oldName = fileOf(jobsFor(ttsCfg({ speed: 1.1 })), DIALOGUE);
  const newName = fileOf(jobsFor(ttsCfg({ speed: 1.6 })), DIALOGUE);
  await writeFile(`${dir}/${oldName}`, "");
  await writeFile(`${dir}/${newName.replace(/\.mp3$/, ".ogg")}`, "");
  assert((await vocalHit(dir, oldName)) !== null, "同名文件应命中（夹具自检）");
  const staleHit = await vocalHit(dir, newName);
  assert(
    staleHit !== null && staleHit.endsWith(".ogg"),
    `跨扩展名探测只能命中同一内容哈希的文件；不得命中旧语速的 ${oldName}（实际 ${staleHit}）`,
  );
  assert(!staleHit.endsWith(oldName), "旧语速文件不得冒充新语速产物");
}

/* ---------- 发现 3：每句语速/情绪是否被线路消费 ---------- */

const mockRoutes: Array<{
  match: (url: string, body: unknown) => boolean;
  respond: (url: string, body: unknown) => { status: number; contentType: string; body: BodyInit };
}> = [];

function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  let body: unknown = null;
  if (init?.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = String(init.body);
    }
  }
  for (const route of mockRoutes) {
    if (route.match(url, body)) {
      const res = route.respond(url, body);
      return Promise.resolve(new Response(res.body, { status: res.status, headers: { "Content-Type": res.contentType } }));
    }
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function ttsVarTests(): void {
  const openai = getTemplate("openai-tts")!;
  const dashscope = getTemplate("dashscope-tts")!;
  const minimax = getTemplate("minimax-tts")!;
  const vars = { model: "tts-1", text: "你好", voice: "alloy", format: "mp3", speed: 1.5, emotion: "angry" };

  // 1) openai-tts 必须把语速真正写进请求体（官方 /v1/audio/speech 与智谱 /paas/v4/audio/speech 都支持 speed）
  const openaiBody = buildRequestBody(openai, vars) as { speed?: number; emotion?: string; input?: string };
  assert(openaiBody.speed === 1.5, `openai-tts 必须下发 speed（实际 ${JSON.stringify(openaiBody)}）`);
  assert(!("emotion" in openaiBody), "两家都没有 emotion 字段：不得臆造（改由未消费变量告警兜底）");

  // 2) dashscope-tts（旧版 parameters.* 端点）查无权威字段名 → 不臆造，钉住现状
  const dashBody = buildRequestBody(dashscope, vars) as { parameters: Record<string, unknown> };
  assert(!("rate" in dashBody.parameters) && !("emotion" in dashBody.parameters), "dashscope 旧端点未查证到语速/情绪字段，不得臆造字段");

  // 3) 未消费变量判定：只有「确实带了意图」的才告警
  assert(
    JSON.stringify(unconsumedTtsVars(openai, { speed: 1.5, emotion: "angry" })) === JSON.stringify(["emotion"]),
    "openai-tts：语速已消费，情绪没有对应字段 → 只报 emotion",
  );
  assert(
    JSON.stringify(unconsumedTtsVars(dashscope, { speed: 1.5, emotion: "angry" })) === JSON.stringify(["speed", "emotion"]),
    "dashscope-tts：语速与情绪都未映射 → 两个都要报",
  );
  assert(unconsumedTtsVars(minimax, { speed: 1.6, emotion: "angry" }).length === 0, "MiniMax 两个字段都消费，不得告警");
  assert(unconsumedTtsVars(openai, { speed: DEFAULT_TTS_SPEED }).length === 0, "中性默认语速不算用户意图，不得刷告警");
  assert(unconsumedTtsVars(openai, {}).length === 0, "没有值就没什么可丢的");
  assert(unconsumedTtsVars(getTemplate("openai-image")!, { speed: 1.6, emotion: "x" }).length === 0, "图像模板不参与该检查");
}

async function ttsDispatchTests(): Promise<void> {
  globalThis.fetch = mockFetch as typeof fetch;
  const cfg = ttsCfg();

  // 端到端：请求体真的带上了每句语速；情绪被丢弃时打一条明确告警，且同一模板只提醒一次
  let captured: Record<string, unknown> | null = null;
  mockRoutes.length = 0;
  mockRoutes.push({
    match: (url) => url.includes("/v1/audio/speech"),
    respond: (_url, body) => {
      captured = body as Record<string, unknown>;
      return { status: 200, contentType: "audio/mpeg", body: "MP3RAW" };
    },
  });

  resetUnconsumedTtsWarnings();
  const warnings: string[] = [];
  const off = addLogListener((entry) => {
    if (entry.level === "warn") warnings.push(entry.message);
  });
  try {
    await unifiedTts(cfg, getTemplate("openai-tts")!, { text: "你好", voice: "alloy", speed: 1.6, ttsEmotion: "angry" });
    assert(captured!.speed === 1.6, `端到端请求体必须带 speed（实际 ${JSON.stringify(captured)}）`);
    const first = warnings.filter((m) => m.includes("不支持每句情绪"));
    assert(first.length === 1, `情绪被静默丢弃必须有一条明确告警（实际 ${warnings.length} 条 warn）`);
    assert(first[0].includes("已忽略"), "告警必须写明「已忽略」，否则用户不知道改参数为什么不生效");
    await unifiedTts(cfg, getTemplate("openai-tts")!, { text: "你好", voice: "alloy", speed: 1.6, ttsEmotion: "angry" });
    assert(
      warnings.filter((m) => m.includes("不支持每句情绪")).length === 1,
      "配音按句请求：同一模板的同一告警只能提醒一次，否则上千条日志会把真正的错误淹没",
    );
  } finally {
    off();
  }

  // 中性默认语速 + 无情绪时不得产生任何告警（否则每条不支持 speed 的线路都会刷屏）
  resetUnconsumedTtsWarnings();
  const quiet: string[] = [];
  const off2 = addLogListener((entry) => {
    if (entry.level === "warn") quiet.push(entry.message);
  });
  try {
    mockRoutes.length = 0;
    mockRoutes.push({
      // 提交与轮询共用同一响应：提交要 output.task_id，轮询要 task_status + results
      match: (url) => url.includes("/speech-synthesis") || url.includes("/tasks/t1"),
      respond: () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ output: { task_id: "t1", task_status: "SUCCEEDED", results: [{ audio_url: "https://oss.test/a.mp3" }] } }) }),
    });
    mockRoutes.push({
      match: (url) => url === "https://oss.test/a.mp3",
      respond: () => ({ status: 200, contentType: "audio/mpeg", body: "MP3RAW" }),
    });
    await unifiedTts(
      { ...ttsCfg(), adapter: "dashscope-tts", model: "cosyvoice-v2", baseUrl: "https://ws.cn-beijing.maas.aliyuncs.com" },
      getTemplate("dashscope-tts")!,
      { text: "你好", voice: "longxiaochun" },
    );
    assert(quiet.length === 0, `默认参数下不该有告警（实际：${quiet.join(" | ")}）`);
  } finally {
    off2();
  }
  // 端到端闭环：全局语速经 buildVoiceJobs 解析进 job.speed，再由 runVoiceJob 真正下发到请求体。
  // 这一条同时钉住发现 2 与发现 3：缓存键里的值就是实际请求里的值（改全局语速既换名、又真的变速）。
  let dispatched: Record<string, unknown> | null = null;
  mockRoutes.length = 0;
  mockRoutes.push({
    match: (url) => url.includes("/v1/audio/speech"),
    respond: (_url, body) => {
      dispatched = body as Record<string, unknown>;
      return { status: 200, contentType: "audio/mpeg", body: "MP3RAW" };
    },
  });
  const globalCfg = ttsCfg({ speed: 1.6 });
  const [globalJob] = jobsFor(globalCfg);
  const globalDir = (await mkdtemp(join(tmpdir(), "novelforge-voicedispatch-"))).replace(/\\/g, "/");
  await runVoiceJob(globalCfg, globalJob, globalDir, () => undefined, true);
  assert(dispatched!.speed === 1.6, `全局语速必须一路下发到请求体（实际 ${JSON.stringify(dispatched)}）`);
  assert(globalJob.speed === 1.6 && globalJob.file.includes("_"), "缓存键与下发值必须同源");
}

/* ---------- 发现 6：配音落盘体积闸门 ---------- */

async function sizeGateTests(): Promise<void> {
  globalThis.fetch = mockFetch as typeof fetch;
  const cfg = ttsCfg();
  const [job] = jobsFor(cfg);
  assert(!!job, "夹具应产出配音任务");
  const root = (await mkdtemp(join(tmpdir(), "novelforge-voicesize-"))).replace(/\\/g, "/");
  const cacheRoot = `${root}/.novel2vn/cache`;
  const vocalDir = `${cacheRoot}/vocal`;

  // 1) 超限响应：必须记失败（返回 null）且**不落盘**——写进去就是一个"看起来成功"的坏产物
  const oversizeBytes = Math.ceil((MAX_VOICE_B64_BYTES * 3) / 4) + 64;
  mockRoutes.length = 0;
  mockRoutes.push({
    match: (url) => url.includes("/v1/audio/speech"),
    respond: () => ({ status: 200, contentType: "audio/mpeg", body: new Uint8Array(oversizeBytes) }),
  });
  const events: PipelineEvent[] = [];
  const oversizePath = await runVoiceJob(cfg, job, cacheRoot, (ev) => events.push(ev), true);
  assert(oversizePath === null, `超限响应必须记为失败项（返回 null），不得当作成功产物（实际 ${oversizePath}）`);
  const files = await readdir(vocalDir).catch(() => [] as string[]);
  assert(!files.some((f) => f.startsWith("v_")), `超限响应不得落盘（实际写入：${files.join(", ")}）`);
  assert(events.some((ev) => ev.message.includes("过大")), `必须留下可读的超限失败原因（实际：${events.map((e) => e.message).join(" | ")}`);

  // 2) 正常响应：闸门不能误伤——照常落盘、内容与响应一致
  mockRoutes.length = 0;
  mockRoutes.push({
    match: (url) => url.includes("/v1/audio/speech"),
    respond: () => ({ status: 200, contentType: "audio/mpeg", body: "MP3RAW" }),
  });
  const okPath = await runVoiceJob(cfg, job, cacheRoot, () => undefined, true);
  assert(typeof okPath === "string" && okPath.endsWith(job.file), `正常响应应照常落盘（实际 ${okPath}）`);
  const bytes = await readFile(okPath!);
  assert(bytes.toString("utf8") === "MP3RAW", "落盘内容必须与响应体一致");
  assert((await vocalHit(vocalDir, job.file)) === okPath, "落盘后应能被缓存命中（路径口径一致）");

  // 3) 上限常量本身要落在合理区间（太小会误伤长台词的 wav，太大等于没闸门）
  assert(
    MAX_VOICE_B64_BYTES >= 4 * 1024 * 1024 && MAX_VOICE_B64_BYTES <= 64 * 1024 * 1024,
    `配音体积上限应在 4~64MB 之间（实际 ${MAX_VOICE_B64_BYTES}）`,
  );
  assert(DEFAULT_TTS_FORMAT === "mp3", "默认输出格式仍是 mp3（历史默认，缓存键兼容的前提）");
}

async function main(): Promise<void> {
  await cacheKeyTests();
  ttsVarTests();
  await ttsDispatchTests();
  await sizeGateTests();
  console.log("=== 配音缓存键 / TTS 参数消费 / 落盘体积闸门 测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
