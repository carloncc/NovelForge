import {
  renderChapter,
  renderConfig,
  isDramatic,
  chapterDisplayTitle,
  branchPrefix,
  sanitizeChoicePrompt,
  stableHash,
  TEXTBOX_PAGE_MAX_CHARS,
  MESSAGE_MAX_CHARS,
  MESSAGE_MAX_CHARS_LATIN,
} from "../src/core/render";
import { buildFlowchartJson } from "../src/core/project";
import type { ChapterScript } from "../src/core/types";
import type { RenderAssets } from "../src/core/render";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const chars = [
  { id: "alice", name: "Alice:Bob", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
  { id: "linche", name: "林澈", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
];

function baseAssets(over: Partial<RenderAssets> = {}): RenderAssets {
  return {
    bg: { s1: "/x/bg_s1.png" },
    cg: {},
    figure: { linche: "/x/f_linche.png", alice: "/x/f_alice.png" },
    item: {},
    vocal: {},
    ...over,
  };
}

function mkChapter(over: Partial<ChapterScript> = {}): ChapterScript {
  return {
    chapter: 0,
    title: "第一章 初入江湖",
    scenes: [
      {
        id: "s1",
        location: "城门前",
        atmosphere: "黄昏",
        time: "夜晚",
        bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "dialogue", characterId: "linche", text: "你好", emotion: "normal" }],
        figures: [],
      },
    ],
    ...over,
  };
}

function opts(extra: Record<string, unknown> = {}): any {
  return { characters: chars, items: [], assets: baseAssets(), introCard: false, ...extra };
}

function main(): void {
  // 1432：多语言高潮关键词
  assert(isDramatic("轰鸣声中城门崩塌"), "1432 简体应命中");
  assert(isDramatic("轟鳴聲中城門崩塌"), "1432 繁体应命中");
  assert(isDramatic("The explosion thundered across the battlefield"), "1432 英文应命中");
  assert(isDramatic("爆発の轟音が響いた"), "1432 日文应命中");
  assert(isDramatic("폭발 굉음이 울려퍼졌다"), "1432 韩文应命中");
  assert(!isDramatic("清晨的村庄一片宁静"), "1432 普通文本不应命中");
  assert(!isDramatic("The morning village is peaceful"), "1432 普通英文不应命中");

  // 1354：编号口径统一（宽口径去重 + 重编号），标题卡与流程图同口径
  assert(chapterDisplayTitle(2, "第三章 决战") === "第三章 决战", "1354 自带编号不重复拼");
  assert(chapterDisplayTitle(2, "第一卷 战争") === "第一卷 战争", "1354 卷/话类宽口径不拼前缀");
  assert(chapterDisplayTitle(2, "初入江湖") === "第 2 章 · 初入江湖", "1354 裸标题拼前缀");
  assert(chapterDisplayTitle(1, "") === "第 1 章", "1354 空标题只剩章号");
  const flow = buildFlowchartJson(
    [{ chapter: 0, title: "第一章 初入江湖", scenes: [] } as unknown as ChapterScript],
    "t",
  );
  assert(!flow.includes("第 1 章 第一章"), "1354 流程图不应双编号");
  assert(flow.includes("第一章 初入江湖"), "1354 流程图保留原标题");

  // 1431：imageOnly 高潮不再被 figureActions 门控
  const imgOnly = mkChapter({
    scenes: [
      {
        id: "s1", location: "战场", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "dialogue", characterId: "linche", text: "轰鸣声中他倒下了", emotion: "normal" }],
        figures: [],
      },
    ],
  });
  const outImg = renderChapter(imgOnly, opts({ mode: "imageOnly", figureActions: false }), 1);
  assert(outImg.includes("setAnimation:shake"), "1431 imageOnly 高潮应有震动（不受 figureActions 门控）");
  assert(outImg.includes('{"blur":5}'), "1431 imageOnly 高潮应有虚化");

  // 1448：情绪动作后补取景复位（不用 -next，避免 1456 折叠吞 motion）
  const emo = mkChapter({
    scenes: [
      {
        id: "s1", location: "城门", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [
          { type: "dialogue", characterId: "linche", text: "先到", emotion: "normal" },
          { type: "dialogue", characterId: "linche", text: "我很生气", emotion: "angry" },
        ],
        figures: [],
      },
    ],
  });
  const outEmo = renderChapter(emo, opts({}), 1);
  const mi = outEmo.indexOf("setTempAnimation:");
  assert(mi >= 0, "1448 应有情绪动作");
  const afterMotion = outEmo.slice(mi);
  assert(afterMotion.includes('setTransform:{"scale":{"x":1.75'), "1448 情绪动作后应补半身取景复位");

  // 1456：复位段去掉 -next（初段演出不同 target 同窗保留，复位落后续窗）
  const dra = mkChapter({
    scenes: [
      {
        id: "s1", location: "战场", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "dialogue", characterId: "linche", text: "轰鸣声中他挥剑斩下", emotion: "normal" }],
        figures: [],
      },
    ],
  });
  const outDra = renderChapter(dra, opts({}), 1);
  assert(outDra.includes('{"blur":5} -target=bg-main -duration=700 -next;'), "1456 初段虚化保留 -next");
  assert(outDra.includes('{"blur":0'), "1456 应有虚化复位");
  const blurReset = outDra.split("\n").find((l) => l.includes('{"blur":0') && l.includes("bg-main"))!;
  assert(!blurReset.trimEnd().endsWith("-next;"), "1456 复位行不应带 -next（否则同窗折叠吞初段）");

  // 1457：人名冒号全角化（不用 \: 转义）
  const colon = mkChapter({
    scenes: [
      {
        id: "s1", location: "城门", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "dialogue", characterId: "alice", text: "Hi", emotion: "normal" }],
        figures: [],
      },
    ],
  });
  const outColon = renderChapter(colon, opts({}), 1);
  const colonLine = outColon.split("\n").find((l) => l.includes("Hi"))!;
  assert(colonLine.includes("Alice：Bob:"), "1457 人名冒号应为全角");
  assert(!colonLine.includes("Alice\\:"), "1457 人名不应再用 \\: 转义");

  // 1449：配音用 -vocal= 显式键
  const voc = mkChapter();
  const vocAssets = baseAssets({ vocal: { ch0_s1_0: "/v/v_1.flac" } });
  const outVoc = renderChapter(voc, { characters: chars, items: [], assets: vocAssets, introCard: false } as any, 1);
  assert(outVoc.includes("-vocal=v_1.flac;"), "1449 配音应用 -vocal= 显式键");
  assert(!/ -v_1\.flac;/.test(outVoc), "1449 不应再输出裸配音开关");

  // 1450：选项保留字符全角化 + 空兜底
  assert(sanitizeChoicePrompt("A->B(冲)[锋]") === "A→B（冲）【锋】", "1450 保留字符应全角化");
  assert(sanitizeChoicePrompt("   ") === "继续", "1450 空文案兜底");
  const ch = mkChapter({
    scenes: [
      {
        id: "s1", location: "路口", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "dialogue", characterId: "linche", text: "选吧", emotion: "normal" }],
        figures: [],
        choices: [
          { id: "c1", prompt: "A->B(冲)", lines: [{ type: "narration", text: "走了" }] },
          { id: "c2", prompt: "", lines: [{ type: "narration", text: "留下" }] },
        ],
      },
    ],
  });
  const outCh = renderChapter(ch, opts({}), 1);
  const chooseLine = outCh.split("\n").find((l) => l.startsWith("choose:"))!;
  assert(!chooseLine.includes("->"), "1450 choose 行不应含 ->");
  assert(!chooseLine.includes("(") && !chooseLine.includes("["), "1450 choose 行不应含半角括号");
  assert(chooseLine.includes("继续:"), "1450 空选项应兜底为继续");

  // 1462：分支前缀哈希区分易撞 id
  const p1 = branchPrefix(1, "sc_a b");
  const p2 = branchPrefix(1, "sc_a_b");
  assert(p1 !== p2, "1462 易撞 id 前缀应不同");
  assert(stableHash("x").length > 0, "1462 哈希可用");
  assert(outCh.includes(`${p1}_c1`) || outCh.includes("_c1"), "1462 分支 label 应输出");

  // 1461：分支后舞台复原
  assert(outCh.includes("; ---- 分支舞台复原 ----"), "1461 join 后应有舞台复原块");
  assert(outCh.includes("changeFigure:none -left -next;"), "1461 复原应清槽");

  // 1452：文件名映射（; | 与" -"）
  const evilBg = mkChapter();
  const evilAssets = baseAssets({ bg: { s1: "/x/第1话; 高潮 - Theme|01.png" } });
  const outEvil = renderChapter(evilBg, { characters: chars, items: [], assets: evilAssets, introCard: false } as any, 1);
  const bgLine = outEvil.split("\n").find((l) => l.startsWith("changeBg:"))!;
  assert(!bgLine.includes("; 高潮"), "1452 文件名 ; 应被映射");
  assert(!bgLine.includes("|01"), "1452 文件名 | 应被映射");
  assert(!bgLine.includes(" - "), "1452 文件名 ' -' 应被映射");

  // 1453：CG 按 triggerIndex 触发 + bg 空回填
  const cg = mkChapter({
    scenes: [
      {
        id: "s1", location: "山顶", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [
          { type: "dialogue", characterId: "linche", text: "第一句", emotion: "normal" },
          { type: "dialogue", characterId: "linche", text: "第二句", emotion: "normal" },
          { type: "dialogue", characterId: "linche", text: "第三句", emotion: "normal" },
        ],
        figures: [],
        cgEvent: { triggerIndex: 2, title: "名场面", description: "决战", imagePrompt: "p" },
        cgFile: "/x/cg_s1.png",
      },
    ],
  });
  const outCg = renderChapter(cg, opts({}), 1);
  const cgBgIdx = outCg.indexOf("changeBg:cg_s1.png");
  const firstSayIdx = outCg.indexOf("第一句");
  const thirdSayIdx = outCg.indexOf("第三句");
  assert(cgBgIdx > firstSayIdx, "1453 CG 不应在场景开场（trigger=2）");
  assert(cgBgIdx < thirdSayIdx || cgBgIdx > firstSayIdx, "1453 CG 应在台词流中触发");
  assert(outCg.includes("unlockCg:game/background/cg_s1.png"), "1460 unlockCg 应带目录前缀");

  // 1460：unlockBgm 带目录前缀
  const bgmChap = mkChapter();
  const bgmAssets = baseAssets({ bgm: { s1: "/x/calm_piano.mp3" } });
  const outBgm = renderChapter(bgmChap, { characters: chars, items: [], assets: bgmAssets, introCard: false } as any, 1);
  assert(outBgm.includes("unlockBgm:game/bgm/calm_piano.mp3"), "1460 unlockBgm 应带目录前缀");

  // 1458：分页与行容量收紧 + Max_line 对齐引擎
  assert(TEXTBOX_PAGE_MAX_CHARS === 64, "1458 单页上限应为 64");
  assert(MESSAGE_MAX_CHARS === 32, "1458 单消息上限应为 32");
  assert(MESSAGE_MAX_CHARS_LATIN === 80, "1458 拉丁上限应为 80");
  const cfg = renderConfig("t", "k");
  assert(cfg.includes("Max_line:2;"), "1458 Max_line 应与引擎可见行数一致");
  const cfgFile = renderConfig("t", "k", "zh_CN", "超长封面文件名_0123456789_0123456789_0123456789_0123456789.png");
  assert(cfgFile.includes("超长封面文件名"), "1452 封面文件名不应被截断");

  // 1463：首场景无 visual 时章首复位背景
  const noBg = mkChapter({
    scenes: [
      {
        id: "s9", location: "虚空", atmosphere: "", time: "", bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "narration", text: "黑场开局" }],
        figures: [],
      },
    ],
  });
  const outNoBg = renderChapter(noBg, { characters: chars, items: [], assets: baseAssets({ bg: {} }), introCard: false } as any, 1);
  assert(outNoBg.includes("changeBg:none"), "1463 无背景首场景章首应复位背景");

  console.log("=== nb-nG render 修复测试通过 ===");
}
main();
