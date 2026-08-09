import { splitChapters } from "../src/core/chapters";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { renderChapter, renderStart } from "../src/core/render";
import { assembleProject, gameKeyFor } from "../src/core/project";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { tauri } from "../src/utils/tauri";

async function main(): Promise<void> {
  const out = "/tmp/novelforge-e2e/game";
  await tauri.removePath(out).catch(() => {});

  const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
  console.log(`[1] 章节切分: ${chapters.length} 章 ->`, chapters.map((c) => `${c.title}(${c.charCount}字)`).join(", "));

  const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
  console.log(`[2] 卡片提取: ${cards.characters.length}角色 ${cards.scenes.length}场景 ${cards.items.length}物品`);

  const scripts = demoScriptAll(chapters, cards);
  const totalLines = scripts.reduce((n, s) => n + s.scenes.reduce((m, sc) => m + sc.lines.length, 0), 0);
  const cgCount = scripts.reduce((n, s) => n + s.scenes.filter((sc) => sc.cgEvent).length, 0);
  const itemEvCount = scripts.reduce((n, s) => n + s.scenes.reduce((m, sc) => m + sc.itemEvents.length, 0), 0);
  console.log(`[3] 剧本: ${scripts.length}章 ${totalLines}句台词 CG事件:${cgCount} 物品事件:${itemEvCount}`);

  const assets = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
  const renderOpts = { title: cards.title, gameKey: gameKeyFor(cards.title), characters: cards.characters, items: cards.items, assets };
  for (const s of scripts) {
    const txt = renderChapter(s, renderOpts, scripts.length);
    validateTxt(txt, s.chapter + 1);
  }
  const start = renderStart(scripts.length, cards.title);
  console.log("[4] 渲染完成，语法校验通过");

  const { meta } = await assembleProject({
    outputDir: out,
    title: cards.title,
    gameKey: gameKeyFor(cards.title),
    templateDir: `${import.meta.dirname.replace(/\\/g, "/")}/../src-tauri/templates/webgal`,
    chapters: scripts,
    cards,
    assets,
    log: () => {},
  });
  console.log(`[5] 组装完成: ${out}`);
  console.log("    meta:", JSON.stringify(meta));

  const sceneDir = `${out}/game/scene`;
  const files = await tauri.listDir(sceneDir);
  console.log("[6] scene 文件:", files.map((f) => f.name).join(", "));

  for (const f of files) {
    if (!f.name.endsWith(".txt")) continue;
    const { text } = await tauri.readTextFile(`${sceneDir}/${f.name}`);
    checkBalance(text, f.name);
  }

  const gameOk = await tauri.pathExists(`${out}/index.html`);
  const configOk = await tauri.pathExists(`${out}/game/config.txt`);
  console.log(`[7] 引擎文件: index.html=${gameOk} config.txt=${configOk}`);
  if (!gameOk || !configOk) throw new Error("组装不完整");

  console.log("\n=== 端到端验证通过 ===");
}

const INSTRUCTION_RE = /^(changeBg|changeFigure|intro|bgm|playEffect|changeScene):.*;$/;
const END_RE = /^end;$/;
function validateTxt(txt: string, chapterNo: number): void {
  const lines = txt.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith(";")) continue;
    if (END_RE.test(t) || INSTRUCTION_RE.test(t)) continue;
    // 对话/旁白：需要含英文冒号并以分号结尾
    const colonIdx = t.indexOf(":");
    if (colonIdx < 0) throw new Error(`ch${chapterNo}: 缺少冒号: ${t}`);
    if (!t.endsWith(";")) throw new Error(`ch${chapterNo}: 缺少分号: ${t}`);
  }
}

function checkBalance(txt: string, fileName: string): void {
  const open = (txt.match(/「/g) || []).length;
  const close = (txt.match(/」/g) || []).length;
  if (open !== close) throw new Error(`${fileName}: 引号不匹配 ${open} vs ${close}`);
}

main().catch((e) => {
  console.error("验证失败:", e);
  process.exit(1);
});
