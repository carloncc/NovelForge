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
  chapter: 1, title: "Test", scenes: [{ id: "s1", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [{ type: "dialogue", characterId: "hero", text: "hello" }], figures: [] }],
} satisfies ChapterScript;

const previousProfiles = configState.voiceProfiles;
configState.voiceProfiles = [{ id: "clone-1", name: "Hero clone", provider: "minimax", ttsConfigId: config.id, voiceId: "voice_hero", status: "ready", revision: 1, createdAt: new Date(0).toISOString() }];
try {
  const jobs = buildVoiceJobs(config, [chapter], [character]);
  assert(jobs.length === 1, "expected one dialogue job");
  assert(jobs[0].voice === "voice_hero" && jobs[0].cloned, "clone voice was not resolved");
  assert(jobs[0].ttsConfigId === config.id, "clone config was not propagated");
  assert(!jobs[0].file.includes("voice_hero"), "cache filename must not expose raw voice ids");
  console.log("=== voice profile routing tests passed ===");
} finally {
  configState.voiceProfiles = previousProfiles;
}
