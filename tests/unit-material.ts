import { generateImages } from "../src/core/images";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { splitChapters } from "../src/core/chapters";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { tauri } from "../src/utils/tauri";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const work = (await mkdtemp(join(tmpdir(), "novelforge-mat-"))).replace(/\\/g, "/");
  await tauri.removePath(work).catch(() => {});
  const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
  const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
  const scripts = demoScriptAll(chapters, cards);

  // 造 2 个假素材（1 角色 + 1 物品）
  const png = await readFile(`${import.meta.dirname.replace(/\\/g, "/")}/../src/assets/logo.png`);
  await tauri.mkdirAll(`${work}/mats`);
  const charPath = `${work}/mats/林澈-角色参考.png`;
  const itemPath = `${work}/mats/星陨剑-物品图.png`;
  await tauri.writeFileBase64(charPath, png.toString("base64"));
  await tauri.writeFileBase64(itemPath, png.toString("base64"));

  const materials = [
    { name: "林澈-角色参考.png", path: charPath, kind: "character" as const, mime: "image/png" },
    { name: "星陨剑-物品图.png", path: itemPath, kind: "item" as const, mime: "image/png" },
  ];

  const logs: string[] = [];
  const { images: result } = await generateImages(undefined, scripts, cards, materials, `${work}/cache`, (ev) => logs.push(ev.message));

  const figureOk = result.figure["linche"] && (await tauri.pathExists(result.figure["linche"]));
  const itemOk = result.item["xingyun"] && (await tauri.pathExists(result.item["xingyun"]));
  const usedMaterial = logs.filter((l) => l.includes("用户素材"));
  const skipped = logs.filter((l) => l.includes("跳过"));

  console.log("素材优先命中:", usedMaterial.length, "条 ->", usedMaterial.map((l) => l.slice(0, 40)).join(" | "));
  console.log("未配置 API 跳过:", skipped.length, "条");
  console.log("立绘(用户素材):", figureOk, "| 物品(用户素材):", itemOk);
  if (!figureOk || !itemOk) throw new Error("素材优先匹配失败");
  if (usedMaterial.length < 2) throw new Error("素材未全部使用");
  console.log("=== 素材优先逻辑验证通过 ===");
}
main().catch((e) => { console.error("失败:", e); process.exit(1); });
