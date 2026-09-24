/**
 * nb-nD 1444/1445/1447（缓存失效）+ 1406 缺指纹自动对齐 + 1401 启动失败复位 回归单测：
 * - 1445 partitionInvalidationIds 纯函数：有效/跳过切分，不抛
 * - 1447 costumeOwnedImageTasks 纯函数：只圈定单套服装换装底图，不含表情/动作/其它服装
 * - 1447 invalidateCostumeSheetCaches 集成：只删窄范围文件与映射，不过界
 * - 1444/1445 静态断言：全局作废含 assets.shot= {}、清理容错 try/catch、作废走跳过而非 throw
 * - 1406 缺指纹 draft 自动对齐：inputFingerprint 为空时批准仍可成功（此前直接 stale 死路）
 * - 1401 静态断言：录音启动失败 catch 内复位 stream/recordingChar，可直接重试
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approveVisualBible,
  costumeOwnedImageTasks,
  invalidateCostumeSheetCaches,
  partitionInvalidationIds,
  saveVisualBible,
  visualBiblePath,
} from "../src/core/visualBible";
import type { CharacterCard, NovelDoc, ProjectVisualBible } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-nb-nd-cache`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function character(): CharacterCard {
  return {
    id: "alice",
    name: "alice",
    appearance: "silver hair",
    clothing: "black coat",
    personality: "calm",
    voiceDesc: "soft",
    imagePrompt: "alice, silver hair, black coat",
    threeViewPrompt: "alice character turnaround",
    color: "#fff",
    costumes: [
      { id: "casual", name: "日常服", prompt: "alice, silver hair, casual wear" },
      { id: "armor", name: "铠甲", prompt: "alice, silver hair, armor" },
    ],
    actions: [{ id: "jump", name: "jump", prompt: "alice jumping" }],
  };
}

function novel(): NovelDoc {
  const text = "Chapter one\nA rainy neon city.";
  return {
    fileName: "novel.txt",
    sourcePath: `${ROOT}/novel.txt`,
    encoding: "utf-8",
    fullText: text,
    chapters: [{ index: 0, title: "One", text, charCount: text.length, enabled: true }],
  };
}

function bible(): ProjectVisualBible {
  return {
    version: 1,
    status: "draft",
    styleSource: "novel_analysis",
    styleDescription: "cinematic anime, cool palette, soft rim light",
    styleReferencePath: "style-sample.png",
    characters: {
      alice: {
        threeViewPath: "threeview_alice.png",
        prompt: "alice character turnaround",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
    },
    inputFingerprint: "stale-fp",
  };
}

function testPartition(): void {
  const cards = [character(), { ...character(), id: "bob", name: "bob" }];
  const { valid, skipped } = partitionInvalidationIds(cards, ["alice", "ghost", "bob"]);
  assert(valid.map((c) => c.id).join(",") === "alice,bob", "有效 id 应按请求顺序保留");
  assert(skipped.join(",") === "ghost", "缺失 id 应进 skipped 而不是抛错");
  const empty = partitionInvalidationIds(cards, []);
  assert(!empty.valid.length && !empty.skipped.length, "空请求应返回双空");
  const allMissing = partitionInvalidationIds(cards, ["x", "y"]);
  assert(!allMissing.valid.length && allMissing.skipped.length === 2, "全缺失时 valid 为空、skipped 全收");
}

function testCostumeNarrow(): void {
  const c = character();
  const narrow = costumeOwnedImageTasks(c, "casual");
  assert(narrow.assetIds.has("alice_ct_casual"), "窄范围必须含本服装换装底图 assetId");
  assert(narrow.fileNames.has("figure_alice_ct_casual_normal.png"), "窄范围必须含本服装换装底图文件名");
  assert(!narrow.assetIds.has("alice_ct_armor"), "其它服装不得进入窄范围");
  assert(!narrow.assetIds.has("alice"), "默认表情立绘不得进入窄范围（修一张锚点不删全量）");
  assert(![...narrow.assetIds].some((id) => id.includes("_act_")), "动作立绘不得进入窄范围");
  assert(narrow.assetIds.size === 1 && narrow.fileNames.size === 1, "单服装窄范围应恰好 1 图（换装底图 normal）");
  const other = costumeOwnedImageTasks(c, "armor");
  assert(other.assetIds.has("alice_ct_armor") && !other.assetIds.has("alice_ct_casual"), "按 costumeId 隔离");
  const missing = costumeOwnedImageTasks(c, "nonexistent");
  assert(!missing.assetIds.size && !missing.fileNames.size, "不存在的服装 id 应返回空集（不误删）");
}

async function testNarrowInvalidate(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(`${ROOT}/.novel2vn/cache/images`);
  const c = character();
  const narrowFile = "figure_alice_ct_casual_normal.png";
  const narrowMeta = `${narrowFile}.meta.json`;
  const keepFiles = ["figure_alice_normal.png", "figure_alice_act_jump.png", "figure_alice_ct_armor_normal.png"];
  for (const f of [narrowFile, ...keepFiles]) {
    await tauri.writeFileBase64(`${ROOT}/.novel2vn/cache/images/${f}`, PNG_B64);
  }
  await tauri.writeTextFile(`${ROOT}/.novel2vn/cache/images/${narrowMeta}`, JSON.stringify({ task: "alice_ct_casual" }));
  await tauri.writeTextFile(
    `${ROOT}/.novel2vn/assets.json`,
    JSON.stringify({
      bg: {}, cg: {}, item: {}, vocal: {},
      figure: {
        alice_ct_casual: "cache/images/figure_alice_ct_casual_normal.png",
        alice: "cache/images/figure_alice_normal.png",
        alice_act_jump: "cache/images/figure_alice_act_jump.png",
      },
      shot: {},
    }),
  );
  await invalidateCostumeSheetCaches(ROOT, c, "casual");
  assert(!(await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/${narrowFile}`)), "窄作废应删除本服装换装底图");
  assert(!(await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/${narrowMeta}`)), "同名 .meta.json 应随图一起失效");
  for (const f of keepFiles) {
    assert(await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/${f}`), `非目标文件不得删除：${f}`);
  }
  const assets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as {
    figure: Record<string, string>;
  };
  assert(!("alice_ct_casual" in assets.figure), "映射应剪掉本服装条目");
  assert("alice" in assets.figure && "alice_act_jump" in assets.figure, "其余映射条目必须保留");
  await tauri.removePath(ROOT).catch(() => {});
}

function testStaticWiring(): void {
  const vb = readFileSync(join(process.cwd(), "src", "core", "visualBible.ts"), "utf-8");
  // 1444：全局作废此前漏掉 shot（分镜死链），现必须补上；vocal 在 cache/audio 不在此目录，不清是对的。
  assert(vb.includes("assets.shot = {};"), "invalidateGlobalCaches 必须补 assets.shot = {}（1444）");
  // 1445：清理走 best-effort，不阻断整单。
  assert(vb.includes("部分缓存清理失败"), "removeCachedImages 必须单文件容错并记 warn（1445）");
  assert(vb.includes("partitionInvalidationIds"), "作废范围必须经 partition 切分（1445，不直接 throw）");
  assert(!vb.includes("throw new Error(`Character is missing from approval request"), "缺失 id 不得再 throw（1445）");
  // 1447：服装锚点走窄入口，不再整角色 broad 清理。
  assert(vb.includes("invalidateCostumeSheetCaches(outputDir, invalidationCharacter, costumeId)"), "服装锚点重生成必须走窄作废入口（1447）");
  const vue = readFileSync(join(process.cwd(), "src", "components", "EditCards.vue"), "utf-8");
  // 1401：启动失败半赋值后必须复位，否则守卫永久拦截。
  const catchIdx = vue.indexOf("录音启动失败");
  assert(catchIdx > 0, "EditCards 必须有录音启动失败提示");
  const catchWindow = vue.slice(Math.max(0, catchIdx - 400), catchIdx + 200);
  assert(catchWindow.includes("stopRecordingNow()") && catchWindow.includes("recordingChar.value = null"), "启动失败 catch 必须复位 stream/recordingChar（1401）");
}

async function testMissingFingerprintAutoAlign(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(ROOT);
  const value = bible();
  // 模拟旧项目升级/从未同步：指纹缺失（空串）、态为 draft。此前直接 stale 死路（无刷新入口只能切页）。
  value.inputFingerprint = "";
  const cards = [{ ...character(), costumes: undefined, actions: undefined }];
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.styleReferencePath), PNG_B64);
  await tauri.writeFileBase64(visualBiblePath(ROOT, "threeview_alice.png"), PNG_B64);
  await saveVisualBible(ROOT, value);
  value.inputFingerprint = "";
  const approved = await approveVisualBible(ROOT, value, { novel: novel(), characters: cards });
  assert(approved.status === "approved", "缺指纹 draft 批准应自动对齐并成功，而非报 stale（1406）");
  assert(typeof approved.inputFingerprint === "string" && approved.inputFingerprint.length > 0, "批准后指纹应对齐到当前输入");
  await tauri.removePath(ROOT).catch(() => {});
}

async function main(): Promise<void> {
  testPartition();
  testCostumeNarrow();
  await testNarrowInvalidate();
  testStaticWiring();
  await testMissingFingerprintAutoAlign();
  console.log("=== nb-nD cache (1444/1445/1447 + 1406-missing + 1401-reset) unit tests passed ===");
}

main().catch((error) => {
  console.error("nb-nD cache unit tests failed:", error);
  process.exit(1);
});
