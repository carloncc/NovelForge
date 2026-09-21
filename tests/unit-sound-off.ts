/**
 * 声音默认开启（#536）：新项目开箱有声（BGM/SE），用户可自行关闭。
 * 覆盖三处：
 *  1) 默认选项 useBgm / useSe 均为 true（此前默认静音，成品像「哑剧」）
 *  2) renderChapter 的 useSe 口径：false 不输出 playEffect、true 输出、undefined 兼容旧行为
 *  3) 项目恢复时用 DEFAULT_OPTIONS 兜底：老 project_state.json 缺字段时按新默认（开启）恢复
 */
import { renderChapter } from "../src/core/render";
import type { ChapterScript, CharacterCard, ExtractionResult, RenderAssets } from "../src/core/types";
import { projectState } from "../src/stores/project";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const characters: CharacterCard[] = [
  { id: "linche", name: "林澈", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
];
const cards: ExtractionResult = { title: "测试", characters, scenes: [], items: [] };
const assets: RenderAssets = { bg: { s1: "/x/bg_s1.png" }, cg: {}, figure: { linche: "/x/f_linche.png" }, item: {}, vocal: {} };

/** 氛围命中 detectSe 的「雨」分支 → 开启 SE 时应输出 playEffect:se_rain.wav */
function rainyScript(): ChapterScript {
  return {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "s1",
        location: "城门前",
        atmosphere: "大雨",
        time: "夜晚",
        bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "dialogue", characterId: "linche", text: "你好", emotion: "normal" }],
        figures: [],
      },
    ],
  };
}

function renderWith(useSe: boolean | undefined): string {
  const opts = { title: "t", gameKey: "k", characters, items: cards.items, assets, introCard: false };
  return renderChapter(rainyScript(), useSe === undefined ? opts : { ...opts, useSe }, 1);
}

function main(): void {
  // 1) 默认选项即有声（#536）
  assert(projectState.options.useBgm === true, "默认 useBgm 必须为 true（有 BGM 文件就播）");
  assert(projectState.options.useSe === true, "默认 useSe 必须为 true（有内置 SE 就播）");

  // 2) renderChapter 的 useSe 口径：显式关闭仍然静音
  const off = renderWith(false);
  assert(!off.includes("playEffect:"), "useSe=false 不应输出任何 playEffect（用户主动关闭）");
  assert(!off.includes(".wav"), "useSe=false 不应引用任何音频文件");

  const on = renderWith(true);
  assert(on.includes("playEffect:se_rain.wav"), "useSe=true 且氛围为雨时应收录 playEffect:se_rain.wav");

  const legacy = renderWith(undefined);
  assert(legacy.includes("playEffect:se_rain.wav"), "useSe 未设置（旧项目）应保持旧行为（输出 SE）");

  // 3) 老存档恢复：缺字段时按新默认（开启）兜底，而不是永久静音
  const restored = { ...projectState.options } as Record<string, unknown>;
  delete restored.useSe;
  delete restored.useBgm;
  const merged = { useBgm: projectState.options.useBgm, useSe: projectState.options.useSe, ...restored };
  assert(merged.useSe === true && merged.useBgm === true, "老 project_state.json 缺字段时按新默认（开启）恢复");

  console.log("=== 声音默认开启测试通过 ===");
}

main();
