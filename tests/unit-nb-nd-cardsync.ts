/**
 * nb-nD 1407（描述重生成落盘）回归单测：
 * - mergeUpdatedCardsIntoStored 纯函数：只合绘画提示词、未知 id 跳过、其余字段保留
 * - persistRegeneratedCharacterDescription 集成：新 prompt 同步进 cards.json 且保留 _novelFp
 */
import {
  mergeUpdatedCardsIntoStored,
  persistRegeneratedCharacterDescription,
  saveVisualBible,
  visualBiblePath,
} from "../src/core/visualBible";
import type { CharacterCard, ProjectVisualBible } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-nb-nd-cardsync`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function card(id: string, imagePrompt: string, threeViewPrompt: string): CharacterCard {
  return {
    id,
    name: `${id}-edited`,
    appearance: "silver hair",
    clothing: "black coat",
    personality: "calm",
    voiceDesc: "soft",
    imagePrompt,
    threeViewPrompt,
    color: "#fff",
  };
}

function bible(): ProjectVisualBible {
  return {
    version: 1,
    status: "draft",
    styleSource: "novel_analysis",
    styleDescription: "cinematic anime",
    styleReferencePath: "style-sample.png",
    characters: {
      alice: {
        threeViewPath: "threeview_alice.png",
        prompt: "old prompt",
        approved: false,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
    },
    inputFingerprint: "fp-1",
  };
}

function testPureMerge(): void {
  const stored = [card("alice", "old image", "old three"), card("bob", "bob image", "bob three")];
  const updated = [{ ...card("alice", "new image", "new three"), name: "alice-hacked" }, card("ghost", "g", "g")];
  const { characters, changedIds } = mergeUpdatedCardsIntoStored(stored, updated);
  assert(JSON.stringify(changedIds) === JSON.stringify(["alice"]), "应只报告实际变化的 id");
  const alice = characters.find((c) => c.id === "alice")!;
  assert(alice.imagePrompt === "new image" && alice.threeViewPrompt === "new three", "绘画提示词应更新");
  assert(alice.name === "alice-edited", "其余手改字段（姓名等）必须保留，不被覆盖");
  assert(characters.some((c) => c.id === "bob" && c.imagePrompt === "bob image"), "未涉及的卡片不动");
  assert(!characters.some((c) => c.id === "ghost"), "未知 id 不新增（补全阶段不该造新卡）");
  const noop = mergeUpdatedCardsIntoStored(stored, [card("alice", "old image", "old three")]);
  assert(!noop.changedIds.length, "无变化时 changedIds 应为空（调用方跳过写盘）");
}

async function testPersistSyncsCardsJson(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(ROOT);
  const value = bible();
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.styleReferencePath), PNG_B64);
  await tauri.writeFileBase64(visualBiblePath(ROOT, "threeview_alice.png"), PNG_B64);
  await saveVisualBible(ROOT, value);
  const oldCard = card("alice", "old image", "old three");
  await tauri.writeTextFile(
    `${ROOT}/.novel2vn/cards.json`,
    JSON.stringify({ title: "t", characters: [oldCard], scenes: [], items: [], _novelFp: "fp-novel" }, null, 2),
  );
  const { card: updated } = await persistRegeneratedCharacterDescription(
    ROOT,
    value,
    "alice",
    oldCard,
    "new image prompt",
    "new threeview prompt",
  );
  assert(updated.imagePrompt === "new image prompt", "返回卡片应为新 prompt");
  const disk = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/cards.json`)).text) as {
    characters: CharacterCard[];
    _novelFp?: string;
  };
  const alice = disk.characters.find((c) => c.id === "alice")!;
  assert(alice.imagePrompt === "new image prompt", "cards.json 必须同步新 imagePrompt（管线按此出图）");
  assert(alice.threeViewPrompt === "new threeview prompt", "cards.json 必须同步新 threeViewPrompt");
  assert(disk._novelFp === "fp-novel", "同步必须保留 _novelFp（防误作废）");
  await tauri.removePath(ROOT).catch(() => {});
}

async function main(): Promise<void> {
  testPureMerge();
  await testPersistSyncsCardsJson();
  console.log("=== nb-nD cardsync (1407) unit tests passed ===");
}

main().catch((error) => {
  console.error("nb-nD cardsync unit tests failed:", error);
  process.exit(1);
});
