/**
 * #1140 图片小说配音闭环（纯函数部分）：
 * buildVoiceJobs 复用于 imageOnly 章节（分镜 shots 不影响 key）、
 * vocalKeysForChapters 与 jobs key 同源（剪枝不误删，含长台词 _pN 分段与分支台词）、
 * 失败项映射 toImageStoryVoiceFailedItem、过期映射剪枝 pruneStaleImageStoryVocal。
 */
import {
  buildVoiceJobs,
  pruneStaleImageStoryVocal,
  toImageStoryVoiceFailedItem,
  vocalKeysForChapters,
} from "../src/core/voice";
import type { ApiConfig, CharacterCard, ChapterScript } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cfg = {
  id: "tts1",
  name: "tts",
  baseUrl: "https://api.example.com/v1",
  apiKey: "k",
  model: "m",
  extra: { voiceLibrary: ["female-shaonv", "male-qn-qingse"] },
} as unknown as ApiConfig;

const cards: CharacterCard[] = [
  { id: "alice", name: "爱丽丝", gender: "female", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
  { id: "bob", name: "鲍勃", gender: "male", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
];

// 超长台词（>500 字，按句拆成多段 _pN）
const longText = Array.from({ length: 30 }, (_, i) => `这是第${i + 1}句超长台词，用于触发按句拆分配音。`).join("");

const chapter: ChapterScript = {
  chapter: 0,
  title: "第一章",
  scenes: [
    {
      id: "s1",
      location: "城门",
      atmosphere: "",
      time: "",
      bgPrompt: "gate",
      itemEvents: [],
      figures: ["alice"],
      lines: [
        { type: "dialogue", characterId: "alice", text: "你好。" },
        { type: "narration", text: "远处传来钟声。" },
        { type: "dialogue", characterId: "bob", text: longText },
      ],
      choices: [
        { id: "c1", prompt: "跟上去", lines: [{ type: "dialogue", characterId: "alice", text: "等等我。" }] },
      ],
      shots: [
        { id: "s1_shot1", prompt: "wide shot", triggerLineIndex: 0, characters: ["alice"], note: "城门" },
      ],
    },
  ],
};

// 1) imageOnly 章节（含 shots/choices）可直接跑主管线 buildVoiceJobs：对话+旁白+分支逐行出 job
const jobs = buildVoiceJobs(cfg, [chapter], cards);
assert(jobs.length >= 5, `对话2+旁白1+超长拆分多段+分支1，至少 5 个 job（实际 ${jobs.length}）`);
assert(new Set(jobs.map((j) => j.key)).size === jobs.length, "job key 不得重复");
assert(jobs.every((j) => j.file.startsWith("v_")), "配音文件名应为 v_ 前缀内容寻址");
const narration = jobs.find((j) => j.text === "远处传来钟声。");
assert(!!narration && narration.charId === "narrator", "旁白应以 narrator 身份配音（避免整段静默）");
const branch = jobs.find((j) => j.text === "等等我。");
assert(!!branch && branch.key === "ch0_s1_1003", `分支台词 key 应按 lines.length+1000*(b+1)+j 公式（实际 ${branch?.key}）`);
const longJobs = jobs.filter((j) => j.key.startsWith("ch0_s1_2"));
assert(longJobs.length > 1 && longJobs.every((j) => /_p\d+$/.test(j.key)), "超长台词应拆成多个 _pN 分段 job");

// 2) vocalKeysForChapters 与 jobs key 同源：剪枝保留集必须覆盖全部 job key
const keep = new Set(vocalKeysForChapters([chapter]));
assert(jobs.every((j) => keep.has(j.key)), "保留集必须覆盖全部 job key（否则剪枝会误删有效映射）");

// 3) 剪枝：过期 key 删除、有效 key（含 _pN 分段）保留
const vocal: Record<string, string> = {
  ch0_s1_0: "/cache/v_ch0_s1_0_fp_hash.mp3",
  [longJobs[0].key]: "/cache/v_long_p1.mp3",
  ch9_old_0: "/cache/v_old.mp3",
  ch0_s1_9999: "/cache/v_stale.mp3",
};
const removed = pruneStaleImageStoryVocal(vocal, [chapter]);
assert(removed.includes("ch9_old_0") && removed.includes("ch0_s1_9999"), "过期 key 应被剪掉");
assert(vocal["ch0_s1_0"] !== undefined && vocal[longJobs[0].key] !== undefined, "有效 key（含分段）不得被剪");
assert(!("ch9_old_0" in vocal), "被剪 key 应从映射中删除");

// 4) 失败项映射：vocal_ 前缀转 label，非前缀 id 原样通过
const mapped = toImageStoryVoiceFailedItem({ id: "vocal_ch0_s1_0", kind: "tts", step: "配音", message: "boom", at: 0 });
assert(mapped.key === "vocal_ch0_s1_0" && mapped.label === "配音 ch0_s1_0" && mapped.message === "boom", "失败项映射应保留 key、label 取台词 key");
const raw = toImageStoryVoiceFailedItem({ id: "voice_stage", kind: "tts", step: "配音", message: "empty", at: 0 });
assert(raw.key === "voice_stage" && raw.label === "配音 voice_stage", "阶段级失败项应原样通过");

console.log("=== nb-nV image story voice tests passed ===");
