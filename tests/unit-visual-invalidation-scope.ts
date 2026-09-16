/**
 * 视觉守门「作废范围」单测：
 * 指纹变化不再一律判「全书作废」——只有出图输入（画风 / 角色身份提示词 / 参考图 / 服装锚点）
 * 真的变了才作废对应范围；小说正文/分章之类与画风无关的变化绝不删图、绝不重画。
 */
import {
  approveVisualBible,
  buildVisualInputSignature,
  characterVisualSignature,
  computeProjectVisualBibleFingerprint,
  refreshVisualBibleFingerprint,
  saveVisualBible,
  visualInvalidationScope,
  visualBiblePath,
} from "../src/core/visualBible";
import type { AssetMap, CharacterCard, NovelDoc, ProjectVisualBible, VisualInputSignature } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-visual-invalidation-scope`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";
const STYLE = "cinematic anime, cool palette, soft rim light";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function character(id: string, threeViewPrompt = `${id} character turnaround`): CharacterCard {
  return {
    id,
    name: id,
    appearance: "silver hair",
    clothing: "black coat",
    personality: "calm",
    voiceDesc: "soft",
    imagePrompt: `${id}, silver hair, black coat`,
    threeViewPrompt,
    color: "#fff",
  };
}

function novel(text = "Chapter one\nA rainy neon city."): NovelDoc {
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
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: STYLE,
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
      bob: {
        threeViewPath: "threeview_bob.png",
        prompt: "bob character turnaround",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
    },
    inputFingerprint: "fp-1",
    cacheBinding: { globalFingerprint: "fp-1", characterRevisions: { alice: 1, bob: 1 } },
  };
}

/** 与 refresh/approve 内部完全同口径的基线签名（无参考图、novel_analysis 风格）。 */
function baseline(cards: readonly CharacterCard[]): VisualInputSignature {
  return buildVisualInputSignature({ characters: cards, styleSource: "novel_analysis", styleDescription: STYLE });
}

async function reset(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(ROOT);
}

async function writeRequiredArtifacts(value: ProjectVisualBible): Promise<void> {
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.styleReferencePath), PNG_B64);
  for (const entry of Object.values(value.characters)) {
    await tauri.writeFileBase64(visualBiblePath(ROOT, entry.threeViewPath), PNG_B64);
  }
}

async function writeLegacyCaches(): Promise<void> {
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/cache/images/figure_alice_normal.png`, PNG_B64);
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/cache/images/bg_ch1_s1.png`, PNG_B64);
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify({
    bg: { ch1_s1: "bg_ch1_s1.png" },
    cg: {},
    figure: { alice: "figure_alice_normal.png" },
    item: {},
    vocal: { line: "line.wav" },
  } satisfies AssetMap));
}

function testSignatureTracksIdentityPrompt(): void {
  const a = character("alice");
  assert(characterVisualSignature(a) === characterVisualSignature(character("alice")), "same input must hash the same");
  assert(
    characterVisualSignature(a) !== characterVisualSignature(character("alice", "alice v2")),
    "a changed identity prompt must change the signature",
  );
  assert(
    characterVisualSignature(a) !== characterVisualSignature(a, PNG_B64),
    "a changed identity reference image must change the signature",
  );
  assert(
    characterVisualSignature(a) !== characterVisualSignature(a, undefined, { school: { revision: 2, prompt: "school" } }),
    "a changed costume anchor must change the signature",
  );
}

function testScopeDiffOnlyFlagsVisualChanges(): void {
  const cards = [character("alice"), character("bob")];
  const base = baseline(cards);

  assert(visualInvalidationScope(base, baseline(cards)) === undefined, "identical inputs must not invalidate anything");
  assert(visualInvalidationScope(undefined, baseline(cards)) === undefined, "no baseline means no guessed invalidation");

  const one = visualInvalidationScope(base, baseline([character("alice", "alice v2"), character("bob")]));
  assert(
    one?.scope === "characters" && one.characterIds.join(",") === "alice",
    "only the character whose visual input changed should be invalidated",
  );

  const both = visualInvalidationScope(base, baseline([character("alice", "alice v2"), character("bob", "bob v2")]));
  assert(
    both?.scope === "characters" && both.characterIds.join(",") === "alice,bob",
    "changed characters should be listed in stable order",
  );

  const styled = visualInvalidationScope(base, buildVisualInputSignature({
    characters: cards,
    styleSource: "novel_analysis",
    styleDescription: `${STYLE}, now pastel`,
  }));
  assert(styled?.scope === "global", "a style change must still invalidate everything");
}

/** 只改小说正文：指纹变化，但一张图都不该判废。 */
async function testNovelOnlyChangeKeepsImageCaches(): Promise<void> {
  await reset();
  const value = bible();
  const cards = [character("alice"), character("bob")];
  value.visualInputs = baseline(cards);
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);

  await refreshVisualBibleFingerprint(ROOT, value, "fp-2", cards);

  assert(value.status === "stale", "a fingerprint change must still mark the bible stale so the user re-confirms");
  assert(
    value.pendingInvalidation === undefined,
    "a novel/card-text-only fingerprint change must not queue an image invalidation",
  );
}

/** 角色身份提示词变了：精确作废该角色。 */
async function testCharacterPromptChangeScopesToThatCharacter(): Promise<void> {
  await reset();
  const value = bible();
  value.visualInputs = baseline([character("alice"), character("bob")]);
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);

  const cards = [character("alice", "alice character turnaround, now with a scar"), character("bob")];
  await refreshVisualBibleFingerprint(ROOT, value, "fp-2", cards);

  const pending = value.pendingInvalidation;
  assert(
    pending?.scope === "characters" && pending.characterIds.join(",") === "alice",
    "a changed character prompt should invalidate exactly that character",
  );
}

/** 没有基线签名的旧项目：不做任何推断，只保留显式范围。 */
async function testLegacyBibleWithoutBaselineKeepsImages(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await writeLegacyCaches();
  const cards = [character("alice"), character("bob")];
  const novelDoc = novel();
  value.inputFingerprint = await computeProjectVisualBibleFingerprint(ROOT, value, novelDoc, cards);
  value.cacheBinding = { globalFingerprint: value.inputFingerprint, characterRevisions: { alice: 1, bob: 1 } };
  await saveVisualBible(ROOT, value);

  const changed = novel("Chapter one\nA rainy neon city.\nAn appended paragraph.");
  const fp2 = await computeProjectVisualBibleFingerprint(ROOT, value, changed, cards);
  await refreshVisualBibleFingerprint(ROOT, value, fp2, cards);
  assert(value.pendingInvalidation === undefined, "a legacy bible without a baseline must not guess any scope");

  await approveVisualBible(ROOT, value, { novel: changed, characters: cards });
  assert(
    await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/figure_alice_normal.png`),
    "approving a legacy bible whose images already match must not delete paid-for images",
  );
}

/** 批准时记下基线：之后没有视觉变化就不该再判废。 */
async function testApprovalRecordsBaseline(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  const cards = [character("alice"), character("bob")];
  const novelDoc = novel();
  value.inputFingerprint = await computeProjectVisualBibleFingerprint(ROOT, value, novelDoc, cards);
  value.cacheBinding = { globalFingerprint: value.inputFingerprint, characterRevisions: { alice: 1, bob: 1 } };
  await saveVisualBible(ROOT, value);

  await approveVisualBible(ROOT, value, { novel: novelDoc, characters: cards });
  assert(value.visualInputs !== undefined, "approval must record the visual input baseline");
  assert(
    value.visualInputs.style === baseline(cards).style,
    "the recorded baseline must use the same style inputs",
  );
  assert(
    (await tauri.readTextFile(visualBiblePath(ROOT, "visual-bible.json"))).text.includes("visualInputs"),
    "the baseline must survive a save/load round trip",
  );

  await refreshVisualBibleFingerprint(ROOT, value, `${value.inputFingerprint}-y`, cards);
  assert(
    value.pendingInvalidation === undefined,
    "with a recorded baseline and unchanged visuals, a novel change must not queue anything",
  );
}

/** 显式全局作废（换画风）仍然全删。 */
async function testGlobalScopeStillInvalidatesEverything(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await writeLegacyCaches();
  const cards = [character("alice"), character("bob")];
  const novelDoc = novel();
  value.inputFingerprint = await computeProjectVisualBibleFingerprint(ROOT, value, novelDoc, cards);
  value.cacheBinding = { globalFingerprint: value.inputFingerprint, characterRevisions: { alice: 1, bob: 1 } };
  value.pendingInvalidation = { scope: "global" };
  await saveVisualBible(ROOT, value);

  await approveVisualBible(ROOT, value, { novel: novelDoc, characters: cards });

  assert(
    !(await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/figure_alice_normal.png`)),
    "an explicit global invalidation (style change) must still drop cached images",
  );
  const assets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(!Object.keys(assets.figure).length && !Object.keys(assets.bg).length, "global invalidation clears visual mappings");
  assert(assets.vocal.line, "global invalidation preserves voice mappings");
}

/** 显式角色范围仍然只删该角色。 */
async function testCharacterScopeStillInvalidatesOnlyThatCharacter(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await writeLegacyCaches();
  const cards = [character("alice"), character("bob")];
  const novelDoc = novel();
  value.inputFingerprint = await computeProjectVisualBibleFingerprint(ROOT, value, novelDoc, cards);
  value.cacheBinding = { globalFingerprint: value.inputFingerprint, characterRevisions: { alice: 1, bob: 1 } };
  value.pendingInvalidation = { scope: "characters", characterIds: ["alice"] };
  await saveVisualBible(ROOT, value);

  await approveVisualBible(ROOT, value, { novel: novelDoc, characters: cards });

  assert(
    !(await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/figure_alice_normal.png`)),
    "the named character's cached figures must be dropped",
  );
  assert(
    await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/bg_ch1_s1.png`),
    "a character-scoped invalidation must not touch backgrounds",
  );
  const assets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(Object.keys(assets.bg).length === 1, "a character-scoped invalidation must keep the background map");
}

/** 从未绑定缓存的全新草稿：批准时必须照旧全量判废。 */
async function testFreshDraftWithoutBindingInvalidatesEverything(): Promise<void> {
  await reset();
  const value = bible();
  value.status = "draft";
  delete value.cacheBinding;
  await writeRequiredArtifacts(value);
  await writeLegacyCaches();
  const cards = [character("alice"), character("bob")];
  const novelDoc = novel();
  value.inputFingerprint = await computeProjectVisualBibleFingerprint(ROOT, value, novelDoc, cards);
  await saveVisualBible(ROOT, value);

  await approveVisualBible(ROOT, value, { novel: novelDoc, characters: cards });

  assert(
    !(await tauri.pathExists(`${ROOT}/.novel2vn/cache/images/figure_alice_normal.png`)),
    "a bible that was never bound to any image cache must invalidate pre-existing images on approval",
  );
  const assets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(!Object.keys(assets.bg).length, "pre-bible visual mappings are cleared");
  assert(assets.vocal.line, "voice mappings are never touched");
}

async function main(): Promise<void> {
  testSignatureTracksIdentityPrompt();
  testScopeDiffOnlyFlagsVisualChanges();
  await testNovelOnlyChangeKeepsImageCaches();
  await testCharacterPromptChangeScopesToThatCharacter();
  await testLegacyBibleWithoutBaselineKeepsImages();
  await testApprovalRecordsBaseline();
  await testGlobalScopeStillInvalidatesEverything();
  await testCharacterScopeStillInvalidatesOnlyThatCharacter();
  await testFreshDraftWithoutBindingInvalidatesEverything();
  await tauri.removePath(ROOT).catch(() => {});
  console.log("=== visual invalidation scope unit tests passed ===");
}

main().catch((error) => {
  console.error("visual invalidation scope unit tests failed:", error);
  process.exit(1);
});
