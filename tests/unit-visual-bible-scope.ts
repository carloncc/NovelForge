/**
 * 视觉守门的作用域：清单里残留的旧角色不能把「已批准」拖回失效。
 *
 * 项目换过小说/重新提取之后，visual-bible.json 里常留着上一版小说的角色
 * （它们不在当前 cards.json 里，永远不会有 approved 标记）。若读取清单时把它们一并校验，
 * 于是「批准 → 一读就变回失效」→ 图像阶段永远判定守门未通过 → 图片一张也生成不出来。
 * 读取时只校验当前项目实际使用的角色（磁盘 cards.json），旧角色保留但不参与判定。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  approveVisualBible,
  computeProjectVisualBibleFingerprint,
  loadVisualBible,
  visualBibleManifestPath,
} from "../src/core/visualBible";
import { restoreProjectState } from "../src/utils/persist";
import { tauri } from "../src/utils/tauri";
import type { CharacterCard, ProjectVisualBible } from "../src/core/types";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-visual-bible-scope`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function characterCard(id: string): CharacterCard {
  return {
    id,
    name: id,
    appearance: "silver hair",
    clothing: "black coat",
    personality: "calm",
    voiceDesc: "soft",
    imagePrompt: `${id}, silver hair, black coat`,
    threeViewPrompt: `${id} character turnaround`,
    color: "#fff",
  };
}

async function seed(outputDir: string): Promise<CharacterCard[]> {
  const dir = `${outputDir}/.novel2vn`;
  mkdirSync(`${dir}/visual-bible`, { recursive: true });
  writeFileSync(`${dir}/project_state.json`, JSON.stringify({ materials: [], outputDir, options: {} }, null, 2), "utf8");
  writeFileSync(`${dir}/split.json`, JSON.stringify({
    method: "ai",
    fp: "src:1",
    chapters: [
      { index: 0, title: "第1章 一", text: "第 1 章正文，雨夜。" },
      { index: 1, title: "第2章 二", text: "第 2 章正文，天台。" },
    ],
  }, null, 2), "utf8");

  const current = [characterCard("alice")];
  writeFileSync(`${dir}/cards.json`, JSON.stringify({ title: "book", characters: current, scenes: [], items: [] }, null, 2), "utf8");

  // alice＝当前项目的角色（已确认）；legacy＝上一版小说残留的角色（永远未确认）
  const bible: ProjectVisualBible = {
    version: 1,
    status: "draft",
    styleSource: "novel_analysis",
    styleDescription: "painted animation, cool palette",
    styleReferencePath: "style-sample.png",
    characters: {
      alice: { threeViewPath: "threeview_alice.png", prompt: "alice turnaround", approved: true, revision: 1 },
      legacy: { threeViewPath: "threeview_legacy.png", prompt: "legacy turnaround", approved: false, revision: 1 },
    },
    inputFingerprint: "v1-placeholder",
  };
  writeFileSync(visualBibleManifestPath(outputDir), JSON.stringify(bible, null, 2), "utf8");
  await tauri.writeFileBase64(`${dir}/visual-bible/style-sample.png`, PNG_B64);
  await tauri.writeFileBase64(`${dir}/visual-bible/threeview_alice.png`, PNG_B64);
  await tauri.writeFileBase64(`${dir}/visual-bible/threeview_legacy.png`, PNG_B64);
  return current;
}

/** 批准后再次读取清单，必须仍是 approved（旧角色 legacy 不得把它拖回 stale） */
async function testLegacyCharacterDoesNotStaleApproval(): Promise<void> {
  const outputDir = `${ROOT}/scoped`;
  const current = await seed(outputDir);

  const restored = await restoreProjectState(outputDir);
  assert(restored.novel, "分章缓存应重建小说");
  assert(restored.visualBible, "应读到视觉守门清单");
  const fingerprint = await computeProjectVisualBibleFingerprint(outputDir, restored.visualBible, restored.novel, current);
  await approveVisualBible(outputDir, restored.visualBible, {
    novel: restored.novel,
    characters: current,
    now: () => "2026-09-10T00:00:00.000Z",
  });
  assert(fingerprint.length > 0, "指纹应可计算");

  const afterApprove = await restoreProjectState(outputDir);
  assert(
    afterApprove.visualBible?.status === "approved",
    `批准后重新加载仍应有效，实际 ${afterApprove.visualBible?.status}`,
  );
  assert(
    !afterApprove.warnings.some((warning) => warning.includes("stale")),
    `不应产生失效告警：${afterApprove.warnings.join(" | ")}`,
  );
  assert(
    Object.keys(afterApprove.visualBible.characters).includes("legacy"),
    "旧角色应保留在清单里（只是不参与判定），不做静默删除",
  );
}

/** 没有磁盘工作副本（无 cards.json）时保持旧行为：清单里的未确认角色仍判失效 */
async function testWithoutWorkingCardsKeepsOldBehavior(): Promise<void> {
  const outputDir = `${ROOT}/unscoped`;
  const current = await seed(outputDir);
  const restored = await restoreProjectState(outputDir);
  assert(restored.novel && restored.visualBible, "前置条件应满足");
  await approveVisualBible(outputDir, restored.visualBible, {
    novel: restored.novel,
    characters: current,
    now: () => "2026-09-10T00:00:00.000Z",
  });
  rmSync(`${outputDir}/.novel2vn/cards.json`);

  const reloaded = await loadVisualBible(outputDir);
  assert(reloaded.visualBible?.status === "stale", "无工作副本时仍应按清单全量校验并判失效");
  assert(
    reloaded.warnings.some((warning) => warning.includes("legacy has not been accepted")),
    `应指出是哪个角色未确认：${reloaded.warnings.join(" | ")}`,
  );
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  try {
    await testLegacyCharacterDoesNotStaleApproval();
    await testWithoutWorkingCardsKeepsOldBehavior();
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
  console.log("=== visual bible scope tests passed ===");
}

main().catch((error) => {
  console.error("visual bible scope tests failed:", error);
  process.exit(1);
});