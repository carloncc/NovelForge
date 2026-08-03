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
  assert(nonCommentLines(out1).length === 9, "行数异常（label+清场3+changeBg+changeFigure+2句+end）");

  // 2) 恶意角色名 → 不产生裸分号注入
  const s2 = makeScript();
  const evilChars = cards.characters.map((c) => ({ ...c, name: "林;澈:evil`\n" }));
  const out2 = renderChapter(s2, { title: "t", gameKey: "k", characters: evilChars, items: cards.items, assets, introCard: false }, 1);
  const line2 = nonCommentLines(out2).find((l) => l.includes("evil"))!;
  assert(line2.startsWith("林\\;澈\\:evil\\` :"), `角色名未正确转义: ${line2}`);

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

  console.log("=== 渲染注入边界测试通过 ===");
}
main();
