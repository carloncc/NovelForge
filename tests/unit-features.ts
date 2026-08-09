import { renderChapter, renderConfig } from "../src/core/render";
import type { ChapterScript, ExtractionResult, RenderAssets } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [
    { id: "linche", name: "林澈", appearance: "黑色短发", clothing: "", personality: "沉默寡言", voiceDesc: "", voiceName: "alloy", imagePrompt: "", color: "" },
    { id: "suwanqing", name: "苏晚晴", appearance: "长发及腰", clothing: "", personality: "温柔", voiceDesc: "", voiceName: "nova", imagePrompt: "", color: "" },
  ],
  scenes: [],
  items: [],
};

const assets: RenderAssets = {
  bg: {},
  cg: {},
  figure: { linche: "/x/f_linche.png", suwanqing: "/x/f_su.png" },
  item: {},
  vocal: {},
};

function chapter(n: number, withVideo = false): ChapterScript {
  return {
    chapter: n,
    title: `第${n + 1}章`,
    scenes: [
      {
        id: `s${n}`,
        location: "城门前",
        atmosphere: "",
        time: "",
        bgPrompt: "",
        itemEvents: [],
        lines: [
          { type: "dialogue", characterId: "linche", text: "台词A", emotion: "normal" },
          { type: "dialogue", characterId: "suwanqing", text: "台词B", emotion: "normal" },
        ],
        figures: [],
        videoPoints: withVideo
          ? [{ id: `op_${n}`, title: "名场面", description: "战斗", videoPrompt: "prompt", durationSecs: 5 }]
          : [],
      },
    ],
  };
}

function main(): void {
  // 0) 章节 label（流程图/任务选择 UI）+ 章首清场
  const out0 = renderChapter(chapter(0), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 2);
  assert(out0.includes("label:ch1_第1章;"), `应输出章节 label: ${out0.split("\n")[3]}`);
  assert(out0.includes("changeFigure:none -left"), "章首应清左位立绘");
  assert(out0.split("\n").some((l) => /^changeFigure:none( -exit=exit)? -next;$/.test(l.trim())), "章首应清中位立绘");
  assert(out0.includes("changeFigure:none -right"), "章首应清右位立绘");
  assert(out0.includes("intro:第 1 章 · 第1章 -fontColor=rgba(255,255,255,1) -fontSize=large -hold;"), "章首应有章节标题卡");

  // 1) 登场资料卡：首次出场插入旁白资料（立绘可见），之后不再重复
  const seen = new Set<string>();
  const out1 = renderChapter(chapter(0), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, seenCharacters: seen }, 2);
  const introCount1 = (out1.match(/【.*】/g) || []).length;
  assert(introCount1 === 2, `第一章应有 2 个登场资料卡，实际 ${introCount1}`);
  assert(out1.includes(":【林澈】 黑色短发 沉默寡言;"), "资料卡内容不完整");
  assert(out1.includes("changeFigure:f_linche.png -left"), "登场应有立绘");
  assert(!out1.includes("intro:「"), "资料卡不应使用黑屏 intro");

  const out2 = renderChapter(chapter(1), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, seenCharacters: seen }, 2);
  const introCount2 = (out2.match(/【.*】/g) || []).length;
  assert(introCount2 === 0, `第二章不应重复资料卡，实际 ${introCount2}`);

  // 2) 开关关闭时无资料卡
  const out3 = renderChapter(chapter(0), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false, seenCharacters: new Set() }, 2);
  assert(!out3.includes("【"), "introCard:false 不应输出资料卡");

  // 3) 视频位：有文件 → playVideo；无文件 → 注释占位
  const outV = renderChapter(chapter(0, true), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, videos: { op_0: "/x/video/op_0.mp4" }, introCard: false }, 2);
  assert(outV.includes("playVideo:op_0.mp4;"), "有视频文件应输出 playVideo");
  assert(!outV.includes("[视频位]"), "有视频文件不应输出占位注释");

  const outNoV = renderChapter(chapter(0, true), { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, videos: {}, introCard: false }, 2);
  assert(!outNoV.includes("playVideo:"), "无视频文件不应输出 playVideo");
  assert(outNoV.includes("[视频位]"), "无视频文件应输出占位注释");

  // 4) CG 鉴赏解锁 + config 紧急回避
  const cgAssets: RenderAssets = {
    ...assets,
    cg: { s0: "/x/cg_0.png" },
  };
  const chWithCg = chapter(0, false);
  chWithCg.scenes[0].cgEvent = {
    triggerIndex: 0,
    title: "城头之战",
    description: "血战",
    imagePrompt: "prompt",
  };
  const outCg = renderChapter(chWithCg, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: cgAssets, introCard: false }, 2);
  assert(outCg.includes("unlockCg:cg_0.png -name=城头之战;"), "有 CG 图应输出 unlockCg");
  const cfgTxt = renderConfig("测试;名字", "key1234");
  assert(cfgTxt.includes("Show_panic:true;"), "config 应启用紧急回避");
  assert(!cfgTxt.includes(";名字"), "config 标题应清洗");

  // 5) 表情差分：情绪对话切换对应表情立绘；BGM 匹配输出 bgm 指令
  const emoAssets: RenderAssets = {
    ...assets,
    figure: {
      linche: "/x/f_linche_normal.png",
      linche_happy: "/x/f_linche_happy.png",
      suwanqing: "/x/f_su_normal.png",
    },
    bgm: { s0: "/x/bgm/battle_theme.mp3" },
  };
  const chEmo = chapter(0, false);
  chEmo.scenes[0].lines[0] = { type: "dialogue", characterId: "linche", text: "哈哈", emotion: "happy" };
  const outEmo = renderChapter(chEmo, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: emoAssets, introCard: false }, 2);
  assert(outEmo.includes("changeFigure:f_linche_happy.png -left"), "情绪对话应切换表情立绘");
  assert(outEmo.includes("bgm:battle_theme.mp3"), "匹配到 BGM 应输出 bgm 指令");
  assert(outEmo.includes("unlockBgm:battle_theme.mp3"), "匹配到 BGM 应解锁鉴赏");
  const outEmoOff = renderChapter(chEmo, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: emoAssets, introCard: false, figureEmotions: false }, 2);
  assert(!outEmoOff.includes("f_linche_happy"), "表情开关关闭不应切换表情立绘");
  const chNoBgm = chapter(0, false);
  const outNoBgm = renderChapter(chNoBgm, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: { ...assets, bgm: {} }, introCard: false }, 2);
  assert(!outNoBgm.includes("bgm:"), "无 BGM 文件不应输出 bgm 指令");

  // 6) BGM 串场修复：首场景有 BGM、后续场景无匹配 BGM → 应输出 bgm:none 淡出停止
  const multiAssets: RenderAssets = {
    ...assets,
    bgm: { s0: "/x/bgm/calm_piano.mp3" },
  };
  const chMulti = chapter(0, false);
  chMulti.scenes.push({
    id: "s1",
    location: "内殿",
    atmosphere: "",
    time: "",
    bgPrompt: "",
    itemEvents: [],
    lines: [{ type: "narration", text: "转场" }],
    figures: [],
  });
  const outMulti = renderChapter(chMulti, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: multiAssets, introCard: false }, 2);
  const bgmIdx = outMulti.indexOf("bgm:calm_piano.mp3");
  const stopIdx = outMulti.indexOf("bgm:none");
  assert(bgmIdx >= 0 && stopIdx > bgmIdx, "无匹配 BGM 的场景应淡出停止上一首 BGM");

  console.log("=== 登场演出/视频位测试通过 ===");
}
main();
