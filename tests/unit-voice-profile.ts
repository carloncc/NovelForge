import { buildVoiceJobs } from "../src/core/voice";
import { configState } from "../src/stores/config";
import type { ApiConfig, CharacterCard, ChapterScript } from "../src/core/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const config: ApiConfig = {
  id: "tts-clone-test",
  name: "MiniMax test",
  baseUrl: "https://api.minimaxi.com",
  apiKey: "test",
  model: "speech-2.8-hd",
  adapter: "minimax-tts",
  extra: { voiceLibrary: ["preset"] },
};

const character = {
  id: "hero", name: "Hero", appearance: "", clothing: "", personality: "", voiceDesc: "", color: "#fff",
  imagePrompt: "", voiceProfileId: "clone-1",
} satisfies CharacterCard;

const chapter = {
  chapter: 1, title: "Test", scenes: [{ id: "s1", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [{ type: "dialogue", characterId: "hero", text: "hello", speed: 1.3, ttsEmotion: "angry" }], figures: [] }],
} satisfies ChapterScript;

const previousProfiles = configState.voiceProfiles;
configState.voiceProfiles = [{ id: "clone-1", name: "Hero clone", provider: "minimax", ttsConfigId: config.id, voiceId: "voice_hero", status: "ready", revision: 1, createdAt: new Date(0).toISOString() }];
try {
  const jobs = buildVoiceJobs(config, [chapter], [character]);
  assert(jobs.length === 1, "expected one dialogue job");
  assert(jobs[0].voice === "voice_hero" && jobs[0].cloned, "clone voice was not resolved");
  assert(jobs[0].ttsConfigId === config.id, "clone config was not propagated");
  assert(!jobs[0].file.includes("voice_hero"), "cache filename must not expose raw voice ids");
  assert(jobs[0].speed === 1.3, "per-line speed was not propagated");
  assert(jobs[0].ttsEmotion === "angry", "per-line ttsEmotion was not propagated");
  console.log("=== voice profile routing tests passed ===");
} finally {
  configState.voiceProfiles = previousProfiles;
}

// 分章节生成：只生成选中章节的配音任务
function assertChapters(): void {
  const twoChapters = [
    { chapter: 0, title: "A", scenes: [{ id: "s1", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [{ type: "dialogue", characterId: "hero", text: "one" }], figures: [] }] },
    { chapter: 1, title: "B", scenes: [{ id: "s1", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [{ type: "dialogue", characterId: "hero", text: "two" }], figures: [] }] },
  ] satisfies ChapterScript[];
  const all = buildVoiceJobs(config, twoChapters, [character]);
  assert(all.length === 2, "两章应生成 2 条配音");
  const firstOnly = buildVoiceJobs(config, twoChapters, [character], new Set([0]));
  assert(firstOnly.length === 1 && firstOnly[0].key.startsWith("ch0_"), "只选中第 0 章应只生成该章配音");
  const secondOnly = buildVoiceJobs(config, twoChapters, [character], new Set([1]));
  assert(secondOnly.length === 1 && secondOnly[0].key.startsWith("ch1_"), "只选中第 1 章应只生成该章配音");
  const none = buildVoiceJobs(config, twoChapters, [character], new Set([5]));
  assert(none.length === 0, "未选中的章节不应生成配音");
  console.log("=== 分章节配音过滤测试通过 ===");
}
assertChapters();
