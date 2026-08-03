import { splitChapters } from "../src/core/chapters";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { assembleProject, gameKeyFor } from "../src/core/project";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { tauri } from "../src/utils/tauri";

const out = "/root/my_project/game";
async function main() {
  await tauri.removePath(out).catch(() => {});
  const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
  const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
  const scripts = demoScriptAll(chapters, cards);
  const { meta } = await assembleProject({
    outputDir: out,
    title: cards.title,
    gameKey: gameKeyFor(cards.title),
    templateDir: "/root/my_project/novel2vn/src-tauri/templates/webgal",
    chapters: scripts,
    cards,
    assets: { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} },
    log: () => {},
  });
  console.log("生成完成:", meta.outputDir);
}
main().catch((e) => { console.error(e); process.exit(1); });
