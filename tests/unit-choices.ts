import { renderChapter, sceneVocalKey } from "../src/core/render";
import { buildVoiceJobs } from "../src/core/voice";
import type { ChapterScript, ExtractionResult, RenderAssets } from "../src/core/types";
import type { ApiConfig } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [
    { id: "linche", name: "林澈", appearance: "", clothing: "", personality: "", voiceDesc: "", voiceName: "alloy", imagePrompt: "", color: "" },
  ],
  scenes: [],
  items: [],
};

const assets: RenderAssets = {
  bg: {},
  cg: {},
  figure: { linche: "/x/f_linche.png" },
  item: {},
  vocal: {},
};

function chapterWithChoice(): ChapterScript {
  return {
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
        lines: [
          { type: "dialogue", characterId: "linche", text: "你好", emotion: "normal" },
          { type: "narration", text: "要怎么做？" },
        ],
        figures: [],
        choices: [
          {
            id: "stay",
            prompt: "留下来",
            lines: [
              { type: "dialogue", characterId: "linche", text: "我留下。" },
              { type: "narration", text: "你选择留下。" },
            ],
          },
          {
            id: "leave",
            prompt: "转身离开",
            lines: [
              { type: "dialogue", characterId: "linche", text: "我走了。" },
            ],
          },
        ],
      },
    ],
  };
}

function main(): void {
  const out = renderChapter(chapterWithChoice(), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);

  // 1) choose 语句：两个选项，选项文本转义
  assert(out.includes("choose:留下来:ch1_s1_c1|转身离开:ch1_s1_c2;"), `缺少 choose 语句: ${out.split("\n").filter((l) => l.startsWith("choose")).join(";")}`);

  // 2) 分支 label 块 + jumpLabel 回到合并点
  assert(out.includes("label:ch1_s1_c1;"), "缺少选项 1 的 label");
  assert(out.includes("label:ch1_s1_c2;"), "缺少选项 2 的 label");
  assert(out.includes("jumpLabel:ch1_s1_join;"), "缺少分支结束跳转");
  assert(out.includes("label:ch1_s1_join;"), "缺少分支合并点 label");

  // 3) 分支台词渲染为对话/旁白，且保持合法（冒号 + 分号结尾）
  assert(out.includes("林澈:我留下。;"), "分支对话未渲染");
  assert(out.includes(":你选择留下。;"), "分支旁白未渲染");

  // 4) 分支台词语音键与配音阶段一致（voice.ts 同公式）
  const cfg: ApiConfig = { id: "t", name: "t", baseUrl: "http://localhost", apiKey: "x", model: "m" };
  const jobs = buildVoiceJobs(cfg, [chapterWithChoice()], cards.characters);
  const branchKeys = jobs.map((j) => j.key);
  // 主流程 2 句 + 分支 2 + 1 句 = 5 句对话配音
  assert(branchKeys.length === 3, `配音任务数异常: ${branchKeys.length}`);
  assert(branchKeys.includes(sceneVocalKey(0, "s1", 0)), "主流程台词语音键缺失");
  assert(branchKeys.includes(sceneVocalKey(0, "s1", 2 + 1000 * 1 + 0)), "分支 1 语音键缺失");
  assert(branchKeys.includes(sceneVocalKey(0, "s1", 2 + 1000 * 2 + 0)), "分支 2 语音键缺失");

  // 5) 无 choices 时正常渲染，不产生 choose/label
  const noChoice = renderChapter({ ...chapterWithChoice(), scenes: [{ ...chapterWithChoice().scenes[0], choices: undefined }] }, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(!noChoice.includes("choose:"), "无分支不应输出 choose");

  console.log("=== 分支选择渲染/语音键测试通过 ===");
}
main();
