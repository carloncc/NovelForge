/**
 * nb-nD 1406（指纹刷新）回归单测：
 * - mergePendingInvalidations 纯函数：global 主导、角色并集过滤排序、空即 undefined
 * - approveVisualBible 草稿/失效态自动对齐：面板未调 refreshFingerprint 时批准仍可成功
 * - 已批准态指纹漂移仍拒绝（旧语义保留，避免悄悄重盖章）
 */
import {
  approveVisualBible,
  computeProjectVisualBibleFingerprint,
  mergePendingInvalidations,
  saveVisualBible,
  visualBiblePath,
} from "../src/core/visualBible";
import type { CharacterCard, NovelDoc, ProjectVisualBible } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-nb-nd-fingerprint`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function character(id: string): CharacterCard {
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

function testMergePending(): void {
  const chars = { alice: {}, bob: {} };
  assert(mergePendingInvalidations(undefined, undefined, chars) === undefined, "双空应返回 undefined（只盖章）");
  assert(
    mergePendingInvalidations({ scope: "global" }, { scope: "characters", characterIds: ["alice"] }, chars)?.scope === "global",
    "global 应主导",
  );
  assert(
    mergePendingInvalidations({ scope: "characters", characterIds: ["bob"] }, { scope: "global" }, chars)?.scope === "global",
    "detected 侧 global 同样主导",
  );
  const merged = mergePendingInvalidations(
    { scope: "characters", characterIds: ["bob"] },
    { scope: "characters", characterIds: ["alice", "ghost"] },
    chars,
  );
  assert(
    merged?.scope === "characters" && JSON.stringify((merged as { characterIds: string[] }).characterIds) === JSON.stringify(["alice", "bob"]),
    "角色范围应取并集、过滤不存在 id、排序",
  );
}

async function reset(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(ROOT);
}

async function writeArtifacts(value: ProjectVisualBible): Promise<void> {
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.styleReferencePath), PNG_B64);
  for (const entry of Object.values(value.characters)) {
    await tauri.writeFileBase64(visualBiblePath(ROOT, entry.threeViewPath), PNG_B64);
  }
}

async function testDraftAutoAlign(): Promise<void> {
  await reset();
  const value = bible();
  const cards = [character("alice")];
  await writeArtifacts(value);
  await saveVisualBible(ROOT, value);
  // 模拟面板 4 条路径改完 prompt 却没调 refreshFingerprint：指纹过期、态为 draft。
  value.inputFingerprint = "stale-fp";
  const approved = await approveVisualBible(ROOT, value, { novel: novel(), characters: cards });
  assert(approved.status === "approved", "草稿态指纹过期时批准应自动对齐并成功，而非报 stale");
  const current = await computeProjectVisualBibleFingerprint(ROOT, approved, novel(), cards);
  assert(approved.inputFingerprint === current, "批准后指纹应对齐到当前输入");
}

async function testApprovedStillRejects(): Promise<void> {
  await reset();
  const value = { ...bible(), status: "approved" as const, approvedAt: "2026-08-07T00:00:00.000Z" };
  const cards = [character("alice")];
  await writeArtifacts(value);
  await saveVisualBible(ROOT, value);
  value.inputFingerprint = "caller-controlled";
  let rejected = false;
  try {
    await approveVisualBible(ROOT, value, { novel: novel(), characters: cards });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("fingerprint");
  }
  assert(rejected, "已批准态指纹漂移必须仍拒绝（需显式刷新标 stale）");
  assert(value.status === "stale", "拒绝后应落盘 stale 状态");
}

async function main(): Promise<void> {
  testMergePending();
  await testDraftAutoAlign();
  await testApprovedStillRejects();
  await tauri.removePath(ROOT).catch(() => {});
  console.log("=== nb-nD fingerprint (1406) unit tests passed ===");
}

main().catch((error) => {
  console.error("nb-nD fingerprint unit tests failed:", error);
  process.exit(1);
});
