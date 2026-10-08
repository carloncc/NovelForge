import { esc, renderChapter, renderConfig, renderSpokenText, sanitizeId } from "../src/core/render";
import type { ChapterScript, ExtractionResult } from "../src/core/types";
import type { RenderAssets } from "../src/core/render";

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
  const out1 = renderChapter(s1, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  const lines1 = nonCommentLines(out1);
  for (const l of lines1) {
    assert(l.endsWith(";"), `行应以分号结尾: ${l}`);
    assert(END_RE.test(l) || CMD_RE.test(l) || LINE_RE.test(l), `非法语句行: ${l}`);
  }
  assert(!out1.includes("\n第一句"), "换行被拆成新语句");
  assert(out1.includes("\\;"), "分号未转义");
  assert(out1.includes("\\:"), "冒号未转义");
  // 反引号**不**转义：引擎的还原表（WSe）只认 反斜杠/竖线/冒号/逗号/分号/句点 六条，
  // 没有反引号规则，转义成反斜杠+反引号反而会在正文里多显示一个反斜杠。
  assert(!out1.includes("\\`"), "反引号不应被转义（引擎没有对应还原规则）");
  assert(out1.includes("`反引号`"), "反引号应原样保留");
  assert(out1.includes("\\\\"), "反斜杠未转义");
  // 半角 [ ] 必须改全角：引擎的 qTe() 会把 [文本](值) 当增强文本解析成注音（ruby），
  // 正文里偶然出现的 [笑](laughing) 会被渲染成「笑」上标 laughing。
  const sB = makeScript();
  sB.scenes[0].lines[0] = { type: "dialogue", characterId: "linche", text: "他说[笑](laughing)着", emotion: "normal" };
  const outB = renderChapter(sB, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(!outB.includes("[笑](laughing)"), "半角方括号会被引擎当注音语法，必须改全角");
  assert(outB.includes("［笑］"), "半角方括号应改写为全角");
  assert(nonCommentLines(out1).length === 16, "行数异常（label+清场3+bgm复位+film复位2+章节标题卡+changeBg+推近+changeFigure+取景+2句+end；#1328 后黄昏/夜晚不再误配 playEffect）");

  // 2) 恶意角色名 → 不产生裸分号注入
  const s2 = makeScript();
  const evilChars = cards.characters.map((c) => ({ ...c, name: "林;澈:evil`\n" }));
  const out2 = renderChapter(s2, { characters: evilChars, items: cards.items, assets, introCard: false }, 1);
  const line2 = nonCommentLines(out2).find((l) => l.includes("evil"))!;
  assert(line2.startsWith("林\\;澈：evil` :"), `角色名未正确转义（#1457：姓名内冒号转全角「：」避免被引擎拆成说话人分隔符）: ${line2}`);

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
  const out3 = renderChapter(s3, { characters: cards.characters, items: evilItems, assets: evilAssets, introCard: false }, 1);
  const idLine = out3.split("\n").find((l) => l.includes("-id=item_"))!;
  assert(idLine.includes("-id=item_"), `缺少物品 id 参数: ${idLine}`);
  const idParam = idLine.slice(idLine.indexOf("-id=item_") + "-id=item_".length).split(" ")[0];
  assert(/^[a-zA-Z0-9_]+$/.test(idParam), `itemId 未 sanitize: ${idParam}`);
  assert(!idParam.startsWith("."), "itemId 含路径穿越");
  assert(!out3.includes("bgm:evil;"), "itemId 注入了指令");
  assert(sanitizeId("a b/c;d") === "a_b_c_d", "sanitizeId 行为异常");

  // 4) 章节标题含换行 → 注释行保持单行，不注入可执行语句
  const s4 = makeScript({ title: "第一章\nchangeBg:evil.jpg -next;" });
  const out4 = renderChapter(s4, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
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
  const out6 = renderChapter(s6, { characters: cards.characters, items: cards.items, assets: cgAssets, introCard: false }, 1);
  assert(out6.includes("changeBg:cg_0_s1.png"), "CG 未按 章节_sceneId key 播放");
  assert(out6.includes("unlockCg:cg_0_s1.png"), "CG 未解锁（#1507：必须是裸文件名，引擎会补 ./game/background/，重复拼前缀会导致鉴赏室 404）");
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
  const out7 = renderChapter(s7, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
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
  const out8 = renderChapter(s8, { characters: cards.characters, items: cards.items, assets: assetsCt, introCard: false }, 1);
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
  const out9 = renderChapter(s9, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
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
  const out10 = renderChapter(s10, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(!out10.includes("林澈叹了口气"), "动作标签旁白不应独立成行");
  assert(out10.includes("林澈:你和你爹一样"), "动作标签后的对话应保留");

  // 11) 动作标签推断说话人/情绪：对话缺说话人（narrator）且情绪默认时用标签
  const s11 = makeScript();
  s11.scenes[0].lines = [
    { type: "narration", text: "林澈冷冷道：" },
    { type: "dialogue", characterId: "narrator", text: "苏小姐消息灵通。", emotion: "normal" },
  ];
  const out11 = renderChapter(s11, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(out11.includes("林澈:苏小姐消息灵通。"), "动作标签应推断说话人（冷冷道→angry 情绪）");

  // 12) 内心独白用「」包裹区分
  const s12 = makeScript();
  s12.scenes[0].lines = [
    { type: "narration", text: "我该不该相信她呢……", monologue: true },
  ];
  const out12 = renderChapter(s12, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  assert(out12.includes(":「我该不该相信她呢……」;"), "独白应用「」包裹");

  // 13) 有配音的台词不拆分：保持单条，避免换页掐断语音
  const s13 = makeScript();
  s13.scenes[0].lines = [
    { type: "dialogue", characterId: "linche", text: "城门前，守夜人林澈握着佩剑，目光如鹰隼般扫视着官道上渐行渐远的人流。他已经在城门口站了整整六个时辰。", emotion: "normal" },
  ];
  const vocalAssets: RenderAssets = { ...assets, vocal: { ch0_s1_0: "/x/v_ch0_s1_0.mp3" } };
  const out13 = renderChapter(s13, { characters: cards.characters, items: cards.items, assets: vocalAssets, introCard: false }, 1);
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
  const outCh1 = renderChapter(ch1, { characters: cards.characters, items: cards.items, assets: battleAssets, introCard: false }, 1);
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
  const outCh2 = renderChapter(ch2, { characters: cards.characters, items: cards.items, assets: quietAssets, introCard: false }, 2);
  assert(outCh2.includes("bgm:none -enter=0"), "章首应显式停止上一章残留的 BGM");
  assert(outCh2.includes("filmMode:none;"), "章首应显式关闭上一章残留的电影黑边");
  assert(outCh2.includes('setTransform:{"oldFilm":0}'), "章首应复位 oldFilm 滤镜");
  assert(outCh2.includes('setTransform:{"godrayFilm":0}'), "章首应复位 godrayFilm 滤镜");

  // 15) #1508：台词中的字面竖线必须转义（引擎对未转义 | 切段 → 超出 Max_line 的段落被丢）
  const s15 = makeScript();
  s15.scenes[0].lines = [
    { type: "dialogue", characterId: "linche", text: "姓名|年龄|籍贯", emotion: "normal" },
  ];
  const out15 = renderChapter(s15, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  const say15 = nonCommentLines(out15).find((l) => l.startsWith("林澈:"))!;
  assert(say15.includes("姓名\\|年龄\\|籍贯"), `台词里的字面竖线必须转义为 \\|（否则会被引擎当成分页符丢字）: ${say15}`);
  // 句内不得出现"未转义"的竖线（除分页符外）
  assert(!/(^|[^\\])\|/.test(say15.replace(/^林澈:/, "").replace(/;$/, "")), `不得残留未转义竖线: ${say15}`);

  // 16) #1508：长台词的分页符必须是"真竖线"（引擎先切段再还原转义）
  const s16 = makeScript();
  const longText = "城门前，守夜人林澈握着佩剑，目光如鹰隼般扫视着官道上渐行渐远的人流。他已经在城门口站了整整六个时辰。";
  s16.scenes[0].lines = [{ type: "narration", text: longText }];
  const out16 = renderChapter(s16, { characters: cards.characters, items: cards.items, assets, introCard: false }, 1);
  const nar16 = nonCommentLines(out16).filter((l) => l.startsWith(":")).map((l) => l.replace(/^:/, "").replace(/;$/, ""));
  // 无配音的长旁白会先被"按句拆成多条消息"，因此每条通常已在单页容量内
  // （这正是避免超长裁切的另一条防线）。分页符只在单条超过 TEXTBOX_PAGE_MAX_CHARS 时出现，
  // 故这里只断言"若有分页符，必须是未转义的真竖线"。
  const hasRealPageBreak = nar16.some((l) => /(^|[^\\])\|/.test(l));
  const hasEscapedPipe = nar16.some((l) => l.includes("\\|"));
  assert(!hasRealPageBreak || !hasEscapedPipe || true, "占位（见下条直接断言）");
  if (hasRealPageBreak) {
    assert(!hasEscapedPipe, `分页符必须是未转义竖线（转义后引擎不会切段，整句会被 Max_line 裁掉）: ${JSON.stringify(nar16)}`);
  }
  // 还原后内容逐字完整（去掉 \| 与分页符）
  const restored = nar16.join("").replace(/\\\|/g, "|").replace(/\|/g, "");
  assert(restored === longText, `分页后还原内容应逐字完整，实际: ${JSON.stringify(restored)}`);

  // 17) #1508 契约：renderSpokenText 必须"先转义、再用未转义竖线分页"。
  // 上游多会先把长句按句拆成多条消息，所以这一步用直接调用锁住契约本身。
  {
    // 短句：不引入分页符
    assert(renderSpokenText("短句") === esc("短句"), "短句不应产生分页符");
    // 字面竖线：必须转义（否则被引擎当分页符，后续段落被丢）
    assert(esc("a|b") === "a\\|b", `字面竖线必须转义: ${esc("a|b")}`);
    // 超长句：分页符必须是未转义的 |，且每页内部无未转义 |
    // 注意 fixture 必须**超过** TEXTBOX_PAGE_MAX_CHARS(64)，否则 paginateForTextBox 按设计不分页
    const long = "城门前，守夜人林澈握着佩剑，目光如鹰隼般扫视着官道上渐行渐远的人流。他已经在城门口站了整整六个时辰，却始终没有等到那个约定之人，直到晨钟敲响才缓缓转身离去。";
    assert(long.length > 64, "fixture 必须超过单页上限，否则该用例无效");
    const rendered = renderSpokenText(long);
    const pages = rendered.split("|");
    assert(pages.length >= 2, `超长句应分成多页，实际 ${pages.length}: ${rendered}`);
    // 分页符确实存在（未转义）→ 引擎 Os 会切段
    assert(rendered.includes("|"), "必须有未转义的分页竖线");
    assert(!rendered.includes("\\|"), `分页路径里不该出现被转义的分页符: ${rendered}`);
    // 还原后逐字完整（去掉分页符；本句没有字面竖线）
    assert(pages.join("") === long, `分页还原应逐字完整，实际: ${JSON.stringify(pages.join(""))}`);
    // 含字面竖线的超长句：字面竖线转义、分页符不转义，两者不得混淆
    const withPipes = long + "|续";
    const rendered2 = renderSpokenText(withPipes);
    assert(rendered2.includes("\\|"), "字面竖线应保留为转义形式");
    assert(rendered2.includes("|"), "分页符应存在");
    assert(rendered2.split("\\|").join("|").split("|").join("") === withPipes.replace(/\|/g, ""), "混合场景还原应完整");
  }

  console.log("=== 渲染注入边界测试通过 ===");
}
main();
