import { splitChapters } from "../src/core/chapters.ts";
import { demoExtract } from "../src/core/extract.ts";
import { demoScriptAll } from "../src/core/script.ts";
import { renderChapter } from "../src/core/render.ts";
import { DEMO_NOVEL } from "../src/core/demoNovel.ts";

const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
const scripts = demoScriptAll(chapters, cards);

const opts = {
  characters: cards.characters,
  items: cards.items,
  assets: { bg: {}, cg: {}, figure: {}, item: {}, vocal: {}, bgm: {} },
  figureEmotions: true,
  figureActions: true,
  introCard: true,
  seenCharacters: new Set(),
  seVolume: 35,
  chapterCount: chapters.length,
};
const scene = renderChapter(scripts[0], opts, chapters.length);
console.log("===== 第 1 章渲染输出（前 130 行） =====");
console.log(scene.split("\n").slice(0, 130).join("\n"));
