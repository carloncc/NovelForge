import { renderChapter, renderConfig, sanitizeId } from "../src/core/render";
import type { ChapterScript, ExtractionResult, RenderAssets } from "../src/core/types";

function makeScript(overrides: Partial<ChapterScript> = {}): ChapterScript {
  return {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "s1",
        location: "城门前",
        atmosphere: "黄昏",
        time: "夜晚",
        bgPrompt: "bg",
        itemEvents: [],
        lines: [
          { type: "dialogue", characterId: "linche", text: "你好", emotion: "normal" },
          { type: "narration", text: "旁白" },
        ],
        figures: [],
      },
    ],
    ...overrides,
  };
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [
    { id: "linche", name: "林澈", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
  ],
  scenes: [],
  items: [],
};

const assets: RenderAssets = { bg: { s1: "/x/bg_s1.png" }, cg: {}, figure: { linche: "/x/f_linche.png" }, item: {}, vocal: {} };

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function nonCommentLines(txt: string): string[] {
  return txt.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith(";") && !l.startsWith("//"));
}

const LINE_RE = /^(?:[^:;\\]|\\[:;,\.`\\])*:(.*);$/;
const CMD_RE = /^(changeBg|changeFigure|intro|end|changeScene):.*;$/;
const END_RE = /^end;$/;

function main(): void {
  // 1) 台词含换行/分号/反斜杠/反引号 → 单行且转义
  const evilText = "第一句;带分号\n第二行:带半角冒号 `反引号` \\反斜杠";
  const s1 = makeScript();
  s1.scenes[0].lines[0] = { type: "dialogue", characterId: "linche", text: evilText, emotion: "normal" };
  const out1 = renderChapter(s1, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  const lines1 = nonCommentLines(out1);
  for (const l of lines1) {
    assert(l.endsWith(";"), `行应以分号结尾: ${l}`);
    assert(END_RE.test(l) || CMD_RE.test(l) || LINE_RE.test(l), `非法语句行: ${l}`);
  }
  assert(!out1.includes("\n第一句"), "换行被拆成新语句");
  assert(out1.includes("\\;"), "分号未转义");
  assert(out1.includes("\\:"), "冒号未转义");
  assert(out1.includes("\\`"), "反引号未转义");
  assert(out1.includes("\\\\"), "反斜杠未转义");
  assert(nonCommentLines(out1).length === 16, "行数异常（label+清场3+bgm复位+film复位2+章节标题卡+changeBg+推近+changeFigure+取景+2句+end；#1328 后黄昏/夜晚不再误配 playEffect）");

  // 2) 恶意角色名 → 不产生裸分号注入
  const s2 = makeScript();
  const evilChars = cards.characters.map((c) => ({ ...c, name: "林;澈:evil`\n" }));
  const out2 = renderChapter(s2, { title: "t", gameKey: "k", characters: evilChars, items: cards.items, assets, introCard: false }, 1);
  const line2 = nonCommentLines(out2).find((l) => l.includes("evil"))!;
  assert(line2.startsWith("林\\;澈：evil\\` :"), `角色名未正确转义（#1457：姓名内冒号转全角「：」避免被引擎拆成说话人分隔符）: ${line2}`);

  // 3) 恶意 itemId → sanitize 进指令参数
  const s3 = makeScript({
    scenes: [{
      id: "s1",
      location: "x",
      atmosphere: "",
      time: "",
      bgPrompt: "",
      itemEvents: [{ triggerIndex: 0, itemId: "../../etc/passwd;bgm:evil", action: "obtain", description: "描述" }],
      lines: [{ type: "narration", text: "获得物品" }],
      figures: [],
    }],
  });
  const evilItems = cards.items.concat([{ id: "../../etc/passwd;bgm:evil", name: "邪物", appearance: "外观", note: "", imagePrompt: "" }]);
  const evilAssets: RenderAssets = { ...assets, item: { "../../etc/passwd;bgm:evil": "/x/item_evil.png" } };
  const out3 = renderChapter(s3, { title: "t", gameKey: "k", characters: cards.characters, items: evilItems, assets: evilAssets, introCard: false }, 1);
  const idLine = out3.split("\n").find((l) => l.includes("-id=item_"))!;
  assert(idLine.includes("-id=item_"), `缺少物品 id 参数: ${idLine}`);
  const idParam = idLine.slice(idLine.indexOf("-id=item_") + "-id=item_".length).split(" ")[0];
  assert(/^[a-zA-Z0-9_]+$/.test(idParam), `itemId 未 sanitize: ${idParam}`);
  assert(!idParam.startsWith("."), "itemId 含路径穿越");
  assert(!out3.includes("bgm:evil;"), "itemId 注入了指令");
  assert(sanitizeId("a b/c;d") === "a_b_c_d", "sanitizeId 行为异常");

  // 4) 章节标题含换行 → 注释行保持单行，不注入可执行语句
  const s4 = makeScript({ title: "第一章\nchangeBg:evil.jpg -next;" });
  const out4 = renderChapter(s4, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(!nonCommentLines(out4).join("\n").includes("changeBg:evil.jpg"), "标题换行注入了指令");

  // 5) config.txt 标题清洗
  const cfg = renderConfig("星陨;之城\n第二章", "key12345");
  assert(!cfg.includes(";之城"), "config 标题含分号");
  assert(!cfg.includes("\n第二章"), "config 标题含换行");

  // 6) CG 查找：assets.cg 的 key 是 `${chapter}_${sceneId}`（非 scene.id），
  // 以及生成阶段写入的 scene.cgFile 捷径；两者都必须触发 CG 演出（回归测试）
  const s6 = makeScript({
    scenes: [{
      id: "s1",
      location: "城门前",
      atmosphere: "",
      time: "",
      bgPrompt: "bg",
      cgEvent: { triggerIndex: 1, title: "名场面", description: "CG 描述", imagePrompt: "cg prompt" },
      itemEvents: [],
      lines: [
        { type: "narration", text: "前奏" },
        { type: "dialogue", characterId: "linche", text: "高潮！", emotion: "normal" },
      ],
      figures: [],
    }],
  });
  const cgAssets: RenderAssets = { ...assets, cg: { "0_s1": "/x/cg_0_s1.png" } };
  const out6 = renderChapter(s6, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: cgAssets, introCard: false }, 1);
  assert(out6.includes("changeBg:cg_0_s1.png"), "CG 未按 章节_sceneId key 播放");
  assert(out6.includes("unlockCg:game/background/cg_0_s1.png"), "CG 未解锁（unlockCg 缺失；#1460 需带 game/background/ 目录，否则引擎鉴赏室缩略图 404）");
  const s7 = makeScript({
    scenes: [{
      id: "s1",
      location: "城门前",
      atmosphere: "",
      time: "",
      bgPrompt: "bg",
      cgEvent: { triggerIndex: 1, title: "名场面", description: "CG 描述", imagePrompt: "cg prompt" },
      cgFile: "/x/cg_scene_shortcut.png",
      itemEvents: [],
      lines: [{ type: "narration", text: "前奏" }],
      figures: [],
    }],
  });
  const out7 = renderChapter(s7, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(out7.includes("changeBg:cg_scene_shortcut.png"), "scene.cgFile 捷径未生效");

  // 8) 换装：标注 costume 即切换服装立绘并记住，后续句沿用；未知服装 id 回退默认
  const assetsCt: RenderAssets = {
    bg: { s1: "/x/bg_s1.png" },
    cg: {},
    figure: { linche: "/x/f_linche.png", linche_ct_battle: "/x/f_linche_battle.png", linche_happy: "/x/f_linche_happy.png" },
    item: {},
    vocal: {},
  };
  const s8 = makeScript();
  s8.scenes[0].lines = [
    { type: "dialogue", characterId: "linche", text: "换上战斗服！", emotion: "normal", costume: "battle" },
    { type: "dialogue", characterId: "linche", text: "再来一句。", emotion: "happy" },
    { type: "dialogue", characterId: "linche", text: "幻之服装？", emotion: "normal", costume: "ghost" },
  ];
  const out8 = renderChapter(s8, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: assetsCt, introCard: false }, 1);
  assert(out8.includes("changeFigure:f_linche_battle.png"), "换装句应切服装立绘");
  // 第二句 emotion=happy 但已换装：优先找该服装的表情差分（未生成）→ 回退默认服装的表情差分。
  // 旧行为换装期间完全放弃表情（哭泣/大笑只有平静脸）；现在有表情胜过无表情，服装表情差分建议后续补齐
  assert(out8.includes("f_linche_happy.png"), "换装期间无服装差分时应回退默认服装的表情差分");
  // 第三句未知服装 id：回退默认立绘不断线
  assert(out8.includes("changeFigure:f_linche.png"), "未知服装应回退默认立绘");

  // 9) 长旁白（无配音）按句读拆成多条消息：一屏一句，接近 galgame 节奏
  const s9 = makeScript();
  s9.scenes[0].lines = [
    { type: "narration", text: "城门前，守夜人林澈握着佩剑，目光如鹰隼般扫视着官道上渐行渐远的人流。他已经在城门口站了整整六个时辰。" },
  ];
  const out9 = renderChapter(s9, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  const nar9 = nonCommentLines(out9).filter((l) => l.startsWith(":"));
  // #1458：分页阈值下调到与文本框实际容量对齐（MESSAGE_MAX 32 / TEXTBOX_PAGE 64），
  // 长句拆成多屏（此处 3 屏）；去掉消息前缀后拼接必须与原文逐字一致（不得静默裁掉）。
  assert(nar9.length >= 2, `长旁白应拆成多屏，实际 ${nar9.length}: ${nar9.join(" | ")}`);
  const cleaned9 = nar9.map((l) => l.replace(/^:/, "").replace(/;$/, "")).join("");
  assert(cleaned9 === "城门前，守夜人林澈握着佩剑，目光如鹰隼般扫视着官道上渐行渐远的人流。他已经在城门口站了整整六个时辰。", `长旁白拆分后内容应逐字完整，实际: ${JSON.stringify(cleaned9)}`);

  // 10) 动作标签旁白吸收：形如「X叹了口气：」不独立成行，下句对话保留
  const s10 = makeScript();
  s10.scenes[0].lines = [
    { type: "narration", text: "林澈叹了口气：" },
    { type: "dialogue", characterId: "linche", text: "你和你爹一样，认死理。", emotion: "normal" },
  ];
  const out10 = renderChapter(s10, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(!out10.includes("林澈叹了口气"), "动作标签旁白不应独立成行");
  assert(out10.includes("林澈:你和你爹一样"), "动作标签后的对话应保留");

  // 11) 动作标签推断说话人/情绪：对话缺说话人（narrator）且情绪默认时用标签
  const s11 = makeScript();
  s11.scenes[0].lines = [
    { type: "narration", text: "林澈冷冷道：" },
    { type: "dialogue", characterId: "narrator", text: "苏小姐消息灵通。", emotion: "normal" },
  ];
  const out11 = renderChapter(s11, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(out11.includes("林澈:苏小姐消息灵通。"), "动作标签应推断说话人（冷冷道→angry 情绪）");

  // 12) 内心独白用「」包裹区分
  const s12 = makeScript();
  s12.scenes[0].lines = [
    { type: "narration", text: "我该不该相信她呢……", monologue: true },
  ];
  const out12 = renderChapter(s12, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(out12.includes(":「我该不该相信她呢……」;"), "独白应用「」包裹");

  // 13) 有配音的台词不拆分：保持单条，避免换页掐断语音
  const s13 = makeScript();
  s13.scenes[0].lines = [
    { type: "dialogue", characterId: "linche", text: "城门前，守夜人林澈握着佩剑，目光如鹰隼般扫视着官道上渐行渐远的人流。他已经在城门口站了整整六个时辰。", emotion: "normal" },
  ];
  const vocalAssets: RenderAssets = { ...assets, vocal: { ch0_s1_0: "/x/v_ch0_s1_0.mp3" } };
  const out13 = renderChapter(s13, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: vocalAssets, introCard: false }, 1);
  const dia13 = nonCommentLines(out13).filter((l) => l.startsWith("林澈:"));
  assert(dia13.length === 1, `有配音的长台词应保持单条，实际 ${dia13.length}`);
  assert(dia13[0].includes("v_ch0_s1_0.mp3"), "配音应挂在唯一一条消息上");

  // 14) 跨章演出复位（#789）：上一章的 BGM/黑边/滤镜不残留在下一章
  const ch1 = makeScript({
    scenes: [{
      id: "s1",
      location: "决战之地",
      atmosphere: "紧张激烈的战斗",
      time: "夜晚",
      bgPrompt: "bg",
      itemEvents: [],
      lines: [{ type: "narration", text: "决战开始。" }],
      figures: [],
    }],
  });
  const battleAssets: RenderAssets = { ...assets, bgm: { s1: "/x/bgm_battle.mp3" } };
  const outCh1 = renderChapter(ch1, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: battleAssets, introCard: false }, 1);
  // #1459：filmMode 经核实不是「电影黑边」而是替换整个对话框（丢名牌/底板、文字 250%），
  // 改为仅「本场景确有视频播放」时启用；紧张氛围改走 godrayFilm 滤镜。
  assert(outCh1.includes("filmMode:none;"), "紧张场景不应再开 filmMode（#1459：改用滤镜）");
  assert(outCh1.includes('setTransform:{"godrayFilm":0.35}'), "紧张场景应开启 godrayFilm 滤镜");
  assert(outCh1.includes("bgm:bgm_battle.mp3"), "战斗场景应播放 BGM");

  const ch2 = makeScript({
    chapter: 1,
    title: "第二章",
    scenes: [{
      id: "s2",
      location: "清晨的村庄",
      atmosphere: "宁静",
      time: "清晨",
      bgPrompt: "bg",
      itemEvents: [],
      lines: [{ type: "narration", text: "清晨。" }],
      figures: [],
    }],
  });
  const quietAssets: RenderAssets = { bg: { s2: "/x/bg_s2.png" }, cg: {}, figure: {}, item: {}, vocal: {} };
  const outCh2 = renderChapter(ch2, { title: "t", gameKey: "k", characters: cards.characters, items: cards.items, assets: quietAssets, introCard: false }, 2);
  assert(outCh2.includes("bgm:none -enter=0"), "章首应显式停止上一章残留的 BGM");
  assert(outCh2.includes("filmMode:none;"), "章首应显式关闭上一章残留的电影黑边");
  assert(outCh2.includes('setTransform:{"oldFilm":0}'), "章首应复位 oldFilm 滤镜");
  assert(outCh2.includes('setTransform:{"godrayFilm":0}'), "章首应复位 godrayFilm 滤镜");

  console.log("=== 渲染注入边界测试通过 ===");
}
main();
