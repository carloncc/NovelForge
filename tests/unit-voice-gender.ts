/**
 * 音色性别分配：修复「女角色拿到男声」。
 * 覆盖：官方表/常见音色名判定、提取归一化的性别纠错、buildVoiceJobs 对旧数据的最终防线。
 */
import { buildVoiceJobs } from "../src/core/voice";
import { normalizeExtractionResult } from "../src/core/extract";
import { pickVoiceForGender, voiceGenderOf } from "../src/core/minimaxVoices";
import type { ApiConfig, CharacterCard, ChapterScript, ExtractionResult } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const LIB = [
  "male-qn-qingse",
  "female-shaonv",
  "female-yujie",
  "Chinese (Mandarin)_Gentleman",
  "Chinese (Mandarin)_Sweet_Lady",
  "harry",
  "anna",
  "alloy",
];

// 1) 性别判定：官方表（含正则认不出的 ID）、常见音色名、未知返回 undefined
assert(voiceGenderOf("Chinese (Mandarin)_Gentleman") === "male", "温润男声应判定为 male");
assert(voiceGenderOf("Chinese (Mandarin)_Sweet_Lady") === "female", "甜美女声应判定为 female");
assert(voiceGenderOf("female-yujie") === "female", "female 前缀应判定为 female");
assert(voiceGenderOf("harry") === "male" && voiceGenderOf("anna") === "female", "常见音色名应可判定性别");
assert(voiceGenderOf("alloy") === undefined, "未知音色应返回 undefined");

// 2) 性别挑选：只从同性别池中取，且稳定可复现
const picked = pickVoiceForGender(LIB, "female", "suwanqing");
assert(picked === pickVoiceForGender(LIB, "female", "suwanqing"), "同一角色挑选结果应稳定");
assert(voiceGenderOf(picked!) === "female", "female 角色不应选到男声");
assert(pickVoiceForGender(["male-qn-qingse"], "female", "x") === undefined, "无同性别候选应返回 undefined");

// 3) 提取归一化：无效音色 / 性别不符 → 按角色性别重选
function char(id: string, name: string, gender: "male" | "female", voiceName?: string): CharacterCard {
  return { id, name, gender, voiceName, appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" };
}
const extracted: ExtractionResult = {
  title: "t",
  scenes: [],
  items: [],
  characters: [
    char("su", "苏晚晴", "female", "not-in-lib"),
    char("lin", "林澈", "male", "female-shaonv"),
    char("liu", "柳儿", "female", "Chinese (Mandarin)_Gentleman"),
  ],
};
normalizeExtractionResult(extracted, LIB, "t");
assert(voiceGenderOf(extracted.characters[0].voiceName!) === "female", "无效音色应回退到同性别音色");
assert(voiceGenderOf(extracted.characters[1].voiceName!) === "male", "性别不符（female 音色给 male 角色）应被纠正");
assert(voiceGenderOf(extracted.characters[2].voiceName!) === "female", "正则认不出的男声应被纠正");

// 4) buildVoiceJobs 最终防线：卡片里已存的错误音色也会按性别纠正（修复既有项目）
const cfg = {
  id: "tts1",
  name: "minimax",
  baseUrl: "https://api.minimaxi.com",
  apiKey: "k",
  model: "speech-01",
  adapter: "minimax-tts",
  extra: { voiceLibrary: LIB },
} as unknown as ApiConfig;
const cards: CharacterCard[] = [char("su", "苏晚晴", "female", "male-qn-qingse")];
const chapter: ChapterScript = {
  chapter: 0,
  title: "第一章",
  scenes: [
    {
      id: "s1",
      location: "城门前",
      atmosphere: "",
      time: "",
      bgPrompt: "",
      itemEvents: [],
      figures: [],
      lines: [{ type: "dialogue", characterId: "su", text: "你好。" }],
    },
  ],
};
const jobs = buildVoiceJobs(cfg, [chapter], cards);
assert(jobs.length === 1, "应有 1 条配音任务");
assert(voiceGenderOf(jobs[0].voice) === "female", `女角色不应使用男声音色（实际 ${jobs[0].voice}）`);

console.log("=== 音色性别分配测试通过 ===");
