import {
  acceptCharacterSheet,
  loadVisualBible,
  regenerateCharacterSheet,
  saveVisualBible,
  syncBibleCharactersWithCards,
  validateVisualBibleForApproval,
  visualBiblePath,
  type VisualBibleServiceDependencies,
} from "../src/core/visualBible";
import type { CharacterCard, ProjectVisualBible } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-bible-sync`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function card(id: string, prompt?: string): CharacterCard {
  return {
    id,
    name: id,
    appearance: "black hair",
    clothing: "school uniform",
    personality: "bright",
    voiceDesc: "clear",
    imagePrompt: prompt ?? `${id}, black hair, school uniform`,
    color: "#fff",
  };
}

function staleBible(): ProjectVisualBible {
  return {
    version: 1,
    status: "draft",
    styleSource: "novel_analysis",
    styleDescription: "cinematic anime",
    styleReferencePath: "style-sample.png",
    inputFingerprint: "test-fp",
    // 重提换 id 前的老条目：新卡片 id 全对不上（复刻用户现场：7 角色全 missing）
    characters: {
      old_iriya: {
        threeViewPath: "threeview_old_iriya.png",
        prompt: "old turnaround",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
    },
  };
}

async function writeArtifacts(value: ProjectVisualBible): Promise<void> {
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.styleReferencePath), PNG_B64);
  for (const entry of Object.values(value.characters)) {
    await tauri.writeFileBase64(visualBiblePath(ROOT, entry.threeViewPath), PNG_B64);
  }
}

function mockDeps(counter: { n: number }): VisualBibleServiceDependencies {
  return {
    chatText: async () => "style",
    chatVision: async () => "style",
    generateImage: async () => {
      counter.n += 1;
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
}

const imageCfg = { id: "image", name: "image", baseUrl: "https://example.invalid/v1", apiKey: "test", model: "image" };

async function reset(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(ROOT);
}

// 现场复刻：圣经全员 missing → 同步补建＋移除多余 → 接受后可批准
async function testSyncHealsAllMissing(): Promise<void> {
  await reset();
  await writeArtifacts(staleBible());
  await saveVisualBible(ROOT, staleBible());
  const loaded = await loadVisualBible(ROOT);
  const bible = loaded.visualBible;
  assert(bible, "bible 应能加载");

  const before = await validateVisualBibleForApproval(ROOT, bible!, ["iriya_toshiki"]);
  assert(before.errors.some((e) => e.includes("iriya_toshiki is missing")), "同步前应报 missing");

  const calls = { n: 0 };
  const r = await syncBibleCharactersWithCards(ROOT, bible!, {
    characters: [card("iriya_toshiki"), card("kitagawa_reon"), { ...card("noprompt"), imagePrompt: "" }],
    imageCfg,
    dependencies: mockDeps(calls),
  });
  assert(r.added.length === 2 && r.added.includes("iriya_toshiki"), `应补建 2 个：${JSON.stringify(r)}`);
  assert(r.removed.includes("old_iriya"), `应移除多余旧条目：${JSON.stringify(r.removed)}`);
  assert(r.failed.length === 1 && r.failed[0].id === "noprompt", "缺提示词角色应进 failed 不调 API");
  assert(r.failed[0].reason.includes("重新生成描述"), "failed 原因应指引修复动作");
  assert(calls.n === 2, `只应为补建调 2 次图像 API，实际 ${calls.n}`);

  const after = await loadVisualBible(ROOT);
  const synced = after.visualBible!;
  assert(synced.characters["iriya_toshiki"]?.threeViewPath, "新条目应有三视图路径");
  assert(await tauri.pathExists(visualBiblePath(ROOT, synced.characters["iriya_toshiki"].threeViewPath)), "三视图文件应已落盘");
  assert(!synced.characters["old_iriya"], "旧条目应已移除");
  assert(synced.characters["iriya_toshiki"].approved === false, "新建条目默认未确认");

  const v = await validateVisualBibleForApproval(ROOT, synced, ["iriya_toshiki"]);
  assert(!v.errors.some((e) => e.includes("is missing")), "同步后不应再报 missing");
  await acceptCharacterSheet(ROOT, synced, "iriya_toshiki");
  const reloaded = (await loadVisualBible(ROOT)).visualBible!;
  const v2 = await validateVisualBibleForApproval(ROOT, reloaded, ["iriya_toshiki"]);
  assert(v2.valid, `确认后应可批准：${v2.errors.join(";")}`);
}

// 已同步时 no-op：不调任何 API
async function testSyncNoopWhenAligned(): Promise<void> {
  await reset();
  await writeArtifacts(staleBible());
  await saveVisualBible(ROOT, staleBible());
  const bible = (await loadVisualBible(ROOT)).visualBible!;
  const calls = { n: 0 };
  const r = await syncBibleCharactersWithCards(ROOT, bible, {
    characters: [card("old_iriya")],
    imageCfg,
    dependencies: mockDeps(calls),
  });
  assert(r.added.length === 0 && r.removed.length === 0 && r.failed.length === 0, "已同步应 no-op");
  assert(calls.n === 0, "no-op 不应调 API");
}

// 孤儿三视图认领：同 id 文件在、条目丢了 → 建条目指过去，不调图像 API
async function testSyncAdoptsOrphanSheet(): Promise<void> {
  await reset();
  await writeArtifacts(staleBible());
  await saveVisualBible(ROOT, staleBible());
  const bible = (await loadVisualBible(ROOT)).visualBible!;
  // 预置孤儿文件（模拟条目丢失但图还在，如 beichuanliyin 现场）
  const { visualBiblePath: vbPath } = await import("../src/core/visualBible");
  const { tauri: t2 } = await import("../src/utils/tauri");
  const dir = vbPath(ROOT, "style-sample.png").split("/").slice(0, -1).join("/");
  await t2.writeFileBase64(`${dir}/threeview_orphan.rev-zzz999-9.png`, PNG_B64);
  const calls = { n: 0 };
  const r = await syncBibleCharactersWithCards(ROOT, bible, {
    characters: [card("orphan")],
    imageCfg,
    dependencies: mockDeps(calls),
  });
  assert(r.adopted.includes("orphan"), `应认领孤儿文件：${JSON.stringify(r)}`);
  assert(r.added.length === 0 && calls.n === 0, "认领不应调用图像 API");
  const reloaded = (await loadVisualBible(ROOT)).visualBible!;
  assert(reloaded.characters["orphan"]?.threeViewPath === "threeview_orphan.rev-zzz999-9.png", "条目应指向孤儿文件");
  assert(reloaded.characters["orphan"]?.approved === false, "认领条目默认未确认");
}

// 建条目占位：无图只建条目（全局重建的前置），已有条目不动，无提示词抛错
async function testEnsureEntry(): Promise<void> {
  const { ensureBibleCharacterEntry } = await import("../src/core/visualBible");
  await reset();
  await writeArtifacts(staleBible());
  await saveVisualBible(ROOT, staleBible());
  const bible = (await loadVisualBible(ROOT)).visualBible!;
  // 缺提示词：抛错指引修描述
  let threw = "";
  try {
    await ensureBibleCharacterEntry(ROOT, bible, { ...card("nop"), imagePrompt: "" });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw.includes("重新生成描述"), `缺提示词应指引修描述：${threw}`);
  // 正常建条目：不调任何 API（无 dependencies 参数），manifest 可加载
  await ensureBibleCharacterEntry(ROOT, bible, card("fresh"));
  const reloaded = (await loadVisualBible(ROOT)).visualBible!;
  assert(reloaded.characters["fresh"]?.approved === false, "新建条目默认未确认");
  assert(reloaded.characters["fresh"]?.threeViewPath === "threeview_fresh.png", "应占 canonical 位");
  assert(reloaded.characters["old_iriya"]?.threeViewPath === "threeview_old_iriya.png", "已有条目不应被动");
  const v = await validateVisualBibleForApproval(ROOT, reloaded, ["fresh"]);
  assert(v.errors.some((e) => e.includes("has not been accepted")), "新建条目应待确认（未生成图也先拦在确认环节）");
}

// 单角色三视图重生成：圣经缺条目时自愈新建（不再抛 missing）
async function testSingleRegenHealsMissingEntry(): Promise<void> {
  await reset();
  await writeArtifacts(staleBible());
  await saveVisualBible(ROOT, staleBible());
  const bible = (await loadVisualBible(ROOT)).visualBible!;
  const calls = { n: 0 };
  const outPath = await regenerateCharacterSheet(ROOT, bible, {
    character: card("fresh_char"),
    imageCfg,
    dependencies: mockDeps(calls),
  });
  assert(calls.n === 1, "应生成一次三视图");
  assert(await tauri.pathExists(outPath), "返回路径文件应存在");
  const reloaded = (await loadVisualBible(ROOT)).visualBible!;
  assert(reloaded.characters["fresh_char"]?.prompt.includes("fresh_char"), "缺失条目应已自愈新建");
}

await testSyncHealsAllMissing();
await testSyncNoopWhenAligned();
await testSyncAdoptsOrphanSheet();
await testEnsureEntry();
await testSingleRegenHealsMissingEntry();
await tauri.removePath(ROOT).catch(() => {});
console.log("=== bible sync tests passed ===");
