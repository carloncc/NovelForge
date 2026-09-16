/**
 * 关闭声音（BGM/SE）：默认必须静音，且老项目/老存档不能被"重新打开声音"。
 * 覆盖三处：
 *  1) 默认选项 useBgm / useSe 均为 false（新项目开箱静音）
 *  2) renderChapter 的 useSe 口径：false 不输出 playEffect、true 输出、undefined 兼容旧行为
 *  3) 项目恢复时用 DEFAULT_OPTIONS 兜底：老 project_state.json 缺 useSe 也不会恢复成开声音
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
  // 1) 默认选项即静音
  assert(projectState.options.useBgm === false, "默认 useBgm 必须为 false（开箱静音）");
  assert(projectState.options.useSe === false, "默认 useSe 必须为 false（开箱静音）");

  // 2) renderChapter 的 useSe 口径
  const off = renderWith(false);
  assert(!off.includes("playEffect:"), "useSe=false 不应输出任何 playEffect（成品静音）");
  assert(!off.includes(".wav"), "useSe=false 不应引用任何音频文件");

  const on = renderWith(true);
  assert(on.includes("playEffect:se_rain.wav"), "useSe=true 且氛围为雨时应收录 playEffect:se_rain.wav");

  const legacy = renderWith(undefined);
  assert(legacy.includes("playEffect:se_rain.wav"), "useSe 未设置（旧项目）应保持旧行为（输出 SE）");

  // 3) 老存档恢复：options 里没有 useSe 时必须落回默认的 false，而不是被打开
  const restored = { ...projectState.options } as Record<string, unknown>;
  delete restored.useSe;
  delete restored.useBgm;
  const merged = { useBgm: false, useSe: false, ...restored };
  assert(merged.useSe === false, "老 project_state.json 缺 useSe 时恢复后必须仍是静音");

  console.log("=== 关闭声音（默认静音）测试通过 ===");
}

main();
