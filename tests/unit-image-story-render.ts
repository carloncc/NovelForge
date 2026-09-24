/**
 * 图片小说渲染分支（#810）：跳过 changeFigure 全家族，按 shot.triggerLineIndex 淡入切换全屏图；
 * 立绘版输出不受影响（回归由 unit-render 覆盖）。
 */
import { renderChapter } from "../src/core/render";
import type { ChapterScript, ExtractionResult, RenderAssets } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [{ id: "alice", name: "爱丽丝", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" }],
  scenes: [],
  items: [],
};

const script: ChapterScript = {
  chapter: 0,
  title: "第一章",
  scenes: [
    {
      id: "s1",
      location: "城门",
      atmosphere: "黄昏",
      time: "傍晚",
      bgPrompt: "gate",
      itemEvents: [],
      figures: ["alice"],
      lines: [
        { type: "dialogue", characterId: "alice", text: "你好。" },
        { type: "narration", text: "远处传来钟声。" },
        { type: "dialogue", characterId: "alice", text: "该走了。" },
      ],
      shots: [
        { id: "s1_shot1", prompt: "wide shot of the gate", triggerLineIndex: 0, characters: ["alice"], note: "城门" },
        { id: "s1_shot2", prompt: "close shot of alice", triggerLineIndex: 2, characters: ["alice"], note: "特写" },
      ],
    },
  ],
};

const assets: RenderAssets = {
  bg: {},
  cg: {},
  figure: { alice: "/cache/figure_alice_normal.png" },
  item: {},
  vocal: {},
  shot: { s1_shot1: "/cache/shot_ch1_s1_1.png", s1_shot2: "/cache/shot_ch1_s1_2.png" },
};

const out = renderChapter(script, { characters: cards.characters, items: cards.items, assets, introCard: true, mode: "imageOnly" }, 1);

// 1) 不得出现任何立绘/人物演出指令
assert(!out.includes("changeFigure"), `图片小说不得输出 changeFigure：\n${out}`);
assert(!out.includes("setTempAnimation"), "图片小说不得输出 setTempAnimation");
assert(!out.includes("miniAvatar"), "图片小说不得输出 miniAvatar");
assert(!out.includes("fig-"), "图片小说不得输出 fig-* 目标");
assert(!out.includes("【爱丽丝】"), "图片小说不输出登场资料卡");

// 2) 分镜按 triggerLineIndex 淡入切换（只淡入，不推近）
const shot1 = out.indexOf("changeBg:shot_ch1_s1_1.png -duration=400 -ease=easeInOut");
const shot2 = out.indexOf("changeBg:shot_ch1_s1_2.png -duration=400 -ease=easeInOut");
const line1 = out.indexOf("爱丽丝:你好。;");
const line2 = out.indexOf(":远处传来钟声。;");
const line3 = out.indexOf("爱丽丝:该走了。;");
assert(shot1 >= 0 && shot2 >= 0, "两张分镜都应切换");
assert(shot1 < line1, "第一张分镜应在第一句之前切换（trigger=0）");
assert(shot2 > line2 && shot2 < line3, "第二张分镜应在第二句之后、第三句之前切换（trigger=2）");
assert(out.includes("unlockCg:game/background/shot_ch1_s1_1.png -name=城门"), "分镜应解锁鉴赏室并带短标题（#1460：unlockCg 需带目录，否则引擎鉴赏室缩略图 404）");
assert(!out.includes('setTransform:{"scale":{"x":1.08'), "分镜切换不做推近（#814 决策 9）");

// 3) 台词/旁白照常输出
assert(line1 >= 0 && line2 >= 0 && line3 >= 0, "台词与旁白应完整输出");

// 4) 无分镜产物的场景不切换（保留上一张），但也不报错
const noAsset = renderChapter(script, { characters: cards.characters, items: cards.items, assets: { ...assets, shot: {} }, mode: "imageOnly" }, 1);
assert(!noAsset.includes("changeBg:shot"), "分镜无产物时不应输出切换指令");
assert(noAsset.includes("爱丽丝:你好。;"), "无分镜时台词仍应输出");

// 5) 立绘版回归：同剧本 sprite 模式仍输出 changeFigure
const sprite = renderChapter(script, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
assert(sprite.includes("changeFigure:figure_alice_normal.png"), "立绘版应照常输出立绘");

console.log("=== image story render tests passed ===");
