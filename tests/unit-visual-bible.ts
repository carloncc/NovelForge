import {
  analyzeNovelStyle,
  analyzeReferenceStyle,
  approveVisualBible,
  CharacterAssetKeyConflictError,
  computeProjectVisualBibleFingerprint,
  computeVisualBibleFingerprint,
  createVisualBibleDraft,
  acceptCharacterSheet,
  regenerateAllCharacterSheets,
  regenerateCharacterDescription,
  regenerateCharacterSheet,
  regenerateStyleSample,
  rewriteStyleDescription,
  updateStyleDescription,
  invalidateCharacterVisualAssets,
  invalidateGlobalVisualAssets,
  loadVisualBible,
  replaceCharacterReference,
  refreshVisualBibleFingerprint,
  saveVisualBible,
  validateVisualBibleForApproval,
  validateCharacterAssetKeys,
  visualBibleDir,
  visualBibleManifestPath,
  visualBiblePath,
  canonicalCostumeSheetPath,
  ensureCostumeAnchors,
  type VisualBibleServiceDependencies,
} from "../src/core/visualBible";
import { ReferenceImageError } from "../src/api/openaiCompatible";
import type {
  ApiConfig,
  AssetMap,
  CharacterCard,
  ImageReference,
  NovelDoc,
  ProjectVisualBible,
} from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-visual-bible`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function character(id: string, referenceImage?: string): CharacterCard {
  return {
    id,
    name: id,
    appearance: "silver hair",
    clothing: "black coat",
    personality: "calm",
    voiceDesc: "soft",
    imagePrompt: `${id}, silver hair, black coat`,
    threeViewPrompt: `${id} character turnaround`,
    referenceImage,
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

function apiConfig(id: string): ApiConfig {
  return { id, name: id, baseUrl: "https://example.invalid/v1", apiKey: "test", model: id };
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
      bob: {
        threeViewPath: "threeview_bob.png",
        prompt: "bob character turnaround",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
      alice_alt: {
        threeViewPath: "threeview_alice_alt.png",
        prompt: "alice alt character turnaround",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
      alice_act: {
        threeViewPath: "threeview_alice_act.png",
        prompt: "alice act character turnaround",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
    },
    inputFingerprint: "fingerprint-1",
  };
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

async function testManifestRoundTripAndRecovery(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);

  const loaded = await loadVisualBible(ROOT);
  assert(loaded.visualBible?.styleDescription === value.styleDescription, "manifest should round trip");
  assert(loaded.warnings.length === 0, "valid manifest should not warn");
  const { text } = await tauri.readTextFile(visualBibleManifestPath(ROOT));
  assert(!text.includes("base64") && !text.includes(PNG_B64), "manifest must not contain base64 payloads");

  await tauri.writeTextFile(visualBibleManifestPath(ROOT), "{ broken json");
  const corrupt = await loadVisualBible(ROOT);
  assert(corrupt.visualBible === null && corrupt.warnings.length === 1, "corrupt manifest should return a warning");
  assert(await tauri.pathExists(visualBiblePath(ROOT, "threeview_alice.png")), "corrupt manifest must not delete images");

  await tauri.removePath(visualBibleManifestPath(ROOT));
  const missing = await loadVisualBible(ROOT);
  assert(missing.visualBible === null && missing.warnings.length === 1, "missing manifest should return a warning");
}

async function testManifestRejectsIncompleteCharacterCacheBinding(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  value.cacheBinding = {
    globalFingerprint: "global-v1",
    characterRevisions: { alice: 1 },
  };
  let rejected = false;
  try {
    await saveVisualBible(ROOT, value);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("cache binding");
  }
  assert(rejected, "a persisted cache binding must include a revision for every manifest character");
}

async function testInterruptedDirectoryPublicationRecoversOnRestart(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);
  const artifactDir = visualBibleDir(ROOT);
  const backupDir = `${artifactDir}.replace-backup`;
  await tauri.copyDirAll(artifactDir, backupDir);
  await tauri.removePath(artifactDir);

  const recovered = await loadVisualBible(ROOT);
  assert(recovered.visualBible?.styleDescription === value.styleDescription, "restart should restore the sole valid directory backup");
  assert(recovered.warnings.some((warning) => warning.includes("Recovered")), "restart recovery should surface an actionable warning");
  assert(!(await tauri.pathExists(backupDir)), "backup should be removed only after the restored destination validates");
}

async function testDirectSaveRecoversSoleDirectoryBackup(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);
  const artifactDir = visualBibleDir(ROOT);
  const backupDir = `${artifactDir}.replace-backup`;
  await tauri.copyDirAll(artifactDir, backupDir);
  await tauri.removePath(artifactDir);

  value.styleDescription = "replacement style after interrupted publication";
  await saveVisualBible(ROOT, value);

  assert(await tauri.pathExists(visualBiblePath(ROOT, value.styleReferencePath)), "direct save should restore artifacts from the sole valid backup before publishing");
  assert(!(await tauri.pathExists(backupDir)), "direct save should remove a backup only after recovery validates");
  const loaded = await loadVisualBible(ROOT);
  assert(loaded.visualBible?.styleDescription === value.styleDescription, "direct save should publish the requested state after recovery");
}

async function testMutationRejectsUnverifiableRetainedBackup(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);
  const artifactDir = visualBibleDir(ROOT);
  const backupDir = `${artifactDir}.replace-backup`;
  await tauri.mkdirAll(backupDir);
  await tauri.writeTextFile(`${backupDir}/visual-bible.json`, "{ broken backup");
  await tauri.removePath(artifactDir);

  let rejected = false;
  try {
    await saveVisualBible(ROOT, value);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("retained");
  }
  assert(rejected, "mutations must abort when recovery retains an unverifiable backup");
  assert(await tauri.pathExists(`${backupDir}/visual-bible.json`), "an unverifiable backup must remain untouched");
  assert(!(await tauri.pathExists(visualBibleManifestPath(ROOT))), "mutation must not publish over an unresolved recovery state");
}

function expectAssetKeyConflict(characters: CharacterCard[], label: string): void {
  let conflict: unknown;
  try {
    validateCharacterAssetKeys(characters);
  } catch (error) {
    conflict = error;
  }
  assert(conflict instanceof CharacterAssetKeyConflictError, `${label} should throw the typed asset-key conflict error`);
  assert(conflict.code === "CHARACTER_ASSET_KEY_CONFLICT", `${label} should expose the actionable conflict code`);
  assert(conflict.message.includes("task") || conflict.message.includes("file"), `${label} should identify the conflicting production key`);
}

async function testCharacterAssetKeyCollisionsAreRejectedBeforeUse(): Promise<void> {
  expectAssetKeyConflict([character("alice"), character("alice_happy")], "emotion-derived task ID collision");

  const aliceWithWave = character("alice");
  aliceWithWave.actions = [{ id: "wave", name: "Wave", prompt: "alice waving" }];
  expectAssetKeyConflict([aliceWithWave, character("alice_act_wave")], "action-derived task ID collision");
  expectAssetKeyConflict([character("甲"), character("乙")], "Unicode filename collision");
  expectAssetKeyConflict([character("a+b"), character("a_b")], "sanitized filename collision");
  const duplicateActions = character("duplicate-actions");
  duplicateActions.actions = [
    { id: "wave", name: "Wave 1", prompt: "wave" },
    { id: "wave", name: "Wave 2", prompt: "wave again" },
  ];
  expectAssetKeyConflict([duplicateActions], "duplicate action IDs within one character");

  let generationCalls = 0;
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async () => {
      generationCalls += 1;
      return "style";
    },
    chatVision: async () => {
      generationCalls += 1;
      return "style";
    },
    generateImage: async () => {
      generationCalls += 1;
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  let draftConflict: unknown;
  try {
    await createVisualBibleDraft({
      outputDir: ROOT,
      novel: novel(),
      cards: { title: "Book", characters: [character("alice"), character("alice_happy")], scenes: [], items: [] },
      imageCfg: apiConfig("image"),
      styleSource: "novel_analysis",
      llmCfg: apiConfig("text"),
    }, dependencies);
  } catch (error) {
    draftConflict = error;
  }
  assert(draftConflict instanceof CharacterAssetKeyConflictError, "draft creation should reject colliding character keys");
  assert(generationCalls === 0, "draft collision validation must run before any model or image API call");
}

async function testManifestPersistsActionIdsAndRejectsReloadedCollisions(): Promise<void> {
  await reset();
  const valid = bible();
  valid.characters.alice.actionIds = ["wave"];
  await writeRequiredArtifacts(valid);
  await saveVisualBible(ROOT, valid);
  const roundTrip = await loadVisualBible(ROOT);
  assert(roundTrip.visualBible?.characters.alice.actionIds?.[0] === "wave", "manifest should round-trip action IDs needed for production collision validation");

  const conflicting = bible();
  conflicting.characters.alice.actionIds = ["wave"];
  conflicting.characters.alice_act_wave = {
    ...conflicting.characters.alice_act,
    threeViewPath: "threeview_alice_act_wave.png",
  };
  await writeRequiredArtifacts(conflicting);
  await tauri.writeTextFile(visualBibleManifestPath(ROOT), JSON.stringify(conflicting, null, 2));
  const loaded = await loadVisualBible(ROOT);
  assert(loaded.visualBible === null, "a manifest with cross-character production-key collisions should not load");
  assert(loaded.warnings.some((warning) => warning.includes("CHARACTER_ASSET_KEY_CONFLICT")), "load warning should expose the typed conflict code");
}

async function testInterruptedManifestPublicationRecoversOnRestart(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);
  const manifestPath = visualBibleManifestPath(ROOT);
  const backupPath = `${manifestPath}.replace-backup`;
  await tauri.copyFile(manifestPath, backupPath);
  await tauri.removePath(manifestPath);

  const recovered = await loadVisualBible(ROOT);
  assert(recovered.visualBible?.styleDescription === value.styleDescription, "restart should restore the manifest after destination was moved");
  assert(recovered.warnings.some((warning) => warning.includes("manifest")), "manifest recovery should surface an actionable warning");
  assert(!(await tauri.pathExists(backupPath)), "manifest backup should remain until the restored destination validates");
}

async function testApprovedBibleWithInvalidArtifactsLoadsStale(): Promise<void> {
  const cases: Array<{ name: string; damage: (path: string) => Promise<void> }> = [
    { name: "missing", damage: (path) => tauri.removePath(path) },
    { name: "empty", damage: (path) => tauri.writeFileBase64(path, "") },
    { name: "invalid", damage: (path) => tauri.writeFileBase64(path, "bm90LWFuLWltYWdl") },
  ];
  for (const scenario of cases) {
    await reset();
    const value = { ...bible(), status: "approved" as const, approvedAt: "2026-08-08T00:00:00.000Z" };
    await writeRequiredArtifacts(value);
    await saveVisualBible(ROOT, value);
    await scenario.damage(visualBiblePath(ROOT, value.styleReferencePath));

    const loaded = await loadVisualBible(ROOT);
    assert(loaded.visualBible?.status === "stale", `${scenario.name} approved artifact should load as stale`);
    assert(loaded.warnings.some((warning) => warning.includes("Style reference")), `${scenario.name} artifact warning should identify the style reference`);
    const persisted = JSON.parse((await tauri.readTextFile(visualBibleManifestPath(ROOT))).text) as ProjectVisualBible;
    assert(persisted.status === "stale" && !persisted.approvedAt, `${scenario.name} artifact damage should persist stale state`);
  }
}

async function testFingerprintTracksBodiesStyleAndReferenceBytes(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  const cards = [character("alice"), character("bob")];
  const input = {
    novel: novel(),
    characters: cards,
    styleSource: value.styleSource,
    styleDescription: value.styleDescription,
  } as const;
  const a = computeVisualBibleFingerprint(input);
  const b = computeVisualBibleFingerprint({ ...input, novel: novel() });
  const changed = computeVisualBibleFingerprint({ ...input, novel: novel("Different chapter") });
  const renamedNovel = novel();
  renamedNovel.chapters[0].title = "Renamed only";
  const renamed = computeVisualBibleFingerprint({ ...input, novel: renamedNovel });
  assert(a === b, "same inputs should produce the same fingerprint");
  assert(a !== changed, "chapter changes should alter the fingerprint");
  assert(a === renamed, "chapter title changes should not alter the fingerprint");
  const changedCards = cards.map((card) => card.id === "alice" ? { ...card, imagePrompt: `${card.imagePrompt}, scar` } : card);
  const cardsChanged = computeVisualBibleFingerprint({ ...input, characters: changedCards });
  assert(a !== cardsChanged, "character-card visual prompt changes should alter the fingerprint");

  const styleChanged = await computeProjectVisualBibleFingerprint(ROOT, {
    ...value,
    styleDescription: `${value.styleDescription}, grainy texture`,
  }, input.novel, cards);
  assert(styleChanged !== a, "style description changes should alter the current fingerprint");
  const referenceBible = {
    ...value,
    styleSource: "reference_image" as const,
    styleReferencePath: "style-reference.png",
  };
  await tauri.writeFileBase64(visualBiblePath(ROOT, referenceBible.styleReferencePath), PNG_B64);
  const referenceBefore = await computeProjectVisualBibleFingerprint(ROOT, referenceBible, input.novel, cards);
  await tauri.writeFileBase64(visualBiblePath(ROOT, referenceBible.styleReferencePath), "ZGlmZmVyZW50");
  const referenceChanged = await computeProjectVisualBibleFingerprint(ROOT, referenceBible, input.novel, cards);
  assert(referenceChanged !== referenceBefore, "reference bytes should alter the current fingerprint");

  value.characters.alice.sourceReferencePath = "character-reference_alice.png";
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.characters.alice.sourceReferencePath), PNG_B64);
  const characterReferenceBefore = await computeProjectVisualBibleFingerprint(ROOT, value, input.novel, cards);
  await tauri.writeFileBase64(visualBiblePath(ROOT, value.characters.alice.sourceReferencePath), "bmV3LXJlZmVyZW5jZQ==");
  const characterReferenceChanged = await computeProjectVisualBibleFingerprint(ROOT, value, input.novel, cards);
  assert(characterReferenceChanged !== characterReferenceBefore, "character reference bytes should alter the current fingerprint");
}

async function testApprovalRequiresAcceptedExistingSheets(): Promise<void> {
  await reset();
  const value = bible();
  const cards = [character("alice"), character("bob")];
  const currentNovel = novel();
  await writeRequiredArtifacts(value);
  value.inputFingerprint = computeVisualBibleFingerprint({
    novel: currentNovel,
    characters: cards,
    styleSource: value.styleSource,
    styleDescription: value.styleDescription,
  });
  await saveVisualBible(ROOT, value);
  const approvalCachePath = `${ROOT}/.novel2vn/cache/images/figure_legacy.png`;
  await tauri.writeFileBase64(approvalCachePath, PNG_B64);
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify({
    bg: { legacy: "bg_legacy.png" },
    cg: {},
    figure: { legacy: "figure_legacy.png" },
    item: {},
    vocal: { line: "line.wav" },
  } satisfies AssetMap));

  const valid = await validateVisualBibleForApproval(ROOT, value, cards.map((card) => card.id));
  assert(valid.valid, `approval should be valid: ${valid.errors.join(", ")}`);
  const approved = await approveVisualBible(ROOT, value, {
    novel: currentNovel,
    characters: cards,
    now: () => "2026-08-08T00:00:00.000Z",
  });
  assert(approved.status === "approved", "approval should persist after all required sheets are accepted and present");
  assert(!(await tauri.pathExists(approvalCachePath)), "approval should remove image caches created before the approved visual bible");
  const approvedAssets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(!Object.keys(approvedAssets.bg).length && !Object.keys(approvedAssets.figure).length, "approval should clear pre-bible visual mappings");
  assert(approvedAssets.vocal.line, "approval invalidation should preserve voice mappings");

  await tauri.removePath(visualBiblePath(ROOT, "threeview_bob.png"));
  const invalid = await validateVisualBibleForApproval(ROOT, value, ["alice", "bob"]);
  assert(!invalid.valid && invalid.errors.some((error) => error.includes("bob")), "missing sheet should block approval");
  let rejected = false;
  try {
    await approveVisualBible(ROOT, value, { novel: currentNovel, characters: cards });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("three-view");
  }
  assert(rejected && value.status === "stale", "approval should reject invalid image artifacts and persist stale state");
}

async function testApprovalRejectsUntrustedFingerprintAndPersistsStaleState(): Promise<void> {
  await reset();
  const value: ProjectVisualBible = { ...bible(), status: "approved" as const, approvedAt: "2026-08-07T00:00:00.000Z" };
  const cards = [character("alice"), character("bob")];
  await writeRequiredArtifacts(value);
  value.inputFingerprint = "caller-controlled";
  await saveVisualBible(ROOT, value);

  let rejected = false;
  try {
    await approveVisualBible(ROOT, value, { novel: novel(), characters: cards });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("fingerprint");
  }
  assert(rejected, "approval must reject a stored fingerprint that does not match actual project inputs");
  assert(value.status === "stale" && !value.approvedAt, "fingerprint mismatch should stale the live bible");
  const loaded = await loadVisualBible(ROOT);
  assert(loaded.visualBible?.status === "stale" && !loaded.visualBible.approvedAt, "fingerprint mismatch should persist stale state");
}

async function testConcurrentApprovalAndReferenceReplacementSerialize(): Promise<void> {
  await reset();
  const value = bible();
  const cards = [character("alice"), character("bob")];
  await writeRequiredArtifacts(value);
  value.inputFingerprint = computeVisualBibleFingerprint({
    novel: novel(),
    characters: cards,
    styleSource: value.styleSource,
    styleDescription: value.styleDescription,
  });
  await saveVisualBible(ROOT, value);

  const originalReadFileBase64 = tauri.readFileBase64;
  let releaseValidation!: () => void;
  let signalValidation!: () => void;
  const validationBlocked = new Promise<void>((resolve) => { signalValidation = resolve; });
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  let blocked = false;
  tauri.readFileBase64 = async (path) => {
    if (!blocked && path === visualBiblePath(ROOT, value.styleReferencePath)) {
      blocked = true;
      signalValidation();
      await validationGate;
    }
    return originalReadFileBase64(path);
  };
  try {
    const approval = approveVisualBible(ROOT, value, { novel: novel(), characters: cards });
    await validationBlocked;
    const replacement = replaceCharacterReference(
      ROOT,
      value,
      cards[0],
      { dataB64: PNG_B64, mime: "image/png" },
    );
    assert(!value.characters.alice.sourceReferencePath, "queued replacement must not mutate state before approval completes");
    releaseValidation();
    await Promise.all([approval, replacement]);
  } finally {
    tauri.readFileBase64 = originalReadFileBase64;
    releaseValidation();
  }
  assert(value.status === "stale" && !value.approvedAt, "reference replacement after approval should be the final serialized state");
  assert(!!value.characters.alice.sourceReferencePath, "serialized replacement should publish its reference path");
  const loaded = await loadVisualBible(ROOT);
  assert(loaded.visualBible?.status === "stale", "serialized final state should persist as stale");
}

async function testScopedInvalidation(): Promise<void> {
  await reset();
  const value: ProjectVisualBible = { ...bible(), status: "approved" as const };
  const imageDir = `${ROOT}/.novel2vn/cache/images`;
  await tauri.writeFileBase64(`${imageDir}/figure_alice_normal.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_happy.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_act_wave.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_act_old.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/threeview_alice.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_bob_normal.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_alt_normal.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_alt_act_wave.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/threeview_alice_alt.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_act_normal.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/bg_room.png`, PNG_B64);
  const assets: AssetMap = {
    bg: { room: "bg_room.png" },
    cg: { moment: "cg_moment.png" },
    figure: {
      alice: "figure_alice_normal.png",
      alice_happy: "figure_alice_happy.png",
      alice_act_wave: "figure_alice_act_wave.png",
      alice_act_old: "figure_alice_act_old.png",
      alice_threeview: "threeview_alice.png",
      bob: "figure_bob_normal.png",
      alice_alt: "figure_alice_alt_normal.png",
      alice_act: "figure_alice_act_normal.png",
    },
    item: { key: "item_key.png" },
    vocal: { line: "line.wav" },
  };
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify(assets));

  const alice = character("alice");
  value.characters.alice.actionIds = ["old"];
  alice.actions = [{ id: "wave", name: "wave", prompt: "wave" }];
  await invalidateCharacterVisualAssets(ROOT, value, alice);
  const characterAssets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(Object.keys(characterAssets.figure).sort().join(",") === "alice_act,alice_alt,bob", "character invalidation should preserve exact adversarial character IDs");
  assert(characterAssets.bg.room && characterAssets.cg.moment && characterAssets.item.key, "character invalidation should preserve scene/item maps");
  assert(characterAssets.vocal.line, "character invalidation should preserve voice mappings");
  assert(await tauri.pathExists(`${imageDir}/figure_bob_normal.png`), "other character cache should remain");
  assert(await tauri.pathExists(`${imageDir}/figure_alice_alt_normal.png`), "prefix-related character cache should remain");
  assert(!(await tauri.pathExists(`${imageDir}/figure_alice_normal.png`)), "target character cache should be removed");
  assert(!(await tauri.pathExists(`${imageDir}/figure_alice_act_wave.png`)), "target action cache should be removed");
  assert(!(await tauri.pathExists(`${imageDir}/figure_alice_act_old.png`)), "historical persisted actions should also be invalidated");
  assert(value.characters.alice.actionIds?.join(",") === "wave", "manifest should retain only current action IDs after invalidation");
  assert(!(await tauri.pathExists(`${imageDir}/threeview_alice.png`)), "target three-view cache should be removed");
  assert(await tauri.pathExists(`${imageDir}/figure_alice_alt_act_wave.png`), "prefix-related action cache should remain");
  assert(await tauri.pathExists(`${imageDir}/threeview_alice_alt.png`), "prefix-related three-view cache should remain");
  assert(await tauri.pathExists(`${imageDir}/figure_alice_act_normal.png`), "alice_act default cache should remain when alice is invalidated");
  assert(value.status === "stale" && !value.characters.alice.approved && value.characters.bob.approved, "only target approval should reset");

  value.characters.alice.approved = true;
  characterAssets.figure.alice = "figure_alice_normal.png";
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify(characterAssets));
  await invalidateCharacterVisualAssets(ROOT, value, character("alice_alt"));
  const altAssets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(altAssets.figure.alice === "figure_alice_normal.png", "invalidating alice_alt should preserve alice's mapping");
  assert(!altAssets.figure.alice_alt, "invalidating alice_alt should remove only its mapping");
  assert(value.characters.alice.approved && !value.characters.alice_alt.approved, "reverse prefix invalidation should preserve alice approval");

  characterAssets.figure.alice_act_wave = "figure_alice_act_wave.png";
  characterAssets.figure.alice_act = "figure_alice_act_normal.png";
  await tauri.writeFileBase64(`${imageDir}/figure_alice_act_wave.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_alice_act_normal.png`, PNG_B64);
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify(characterAssets));
  await invalidateCharacterVisualAssets(ROOT, value, character("alice_act"));
  const adversarialAssets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(adversarialAssets.figure.alice_act_wave, "alice action must survive invalidating the distinct alice_act character");
  assert(!adversarialAssets.figure.alice_act, "alice_act default mapping should be removed exactly");
  assert(await tauri.pathExists(`${imageDir}/figure_alice_act_wave.png`), "alice action cache must survive adversarial invalidation");
  assert(!(await tauri.pathExists(`${imageDir}/figure_alice_act_normal.png`)), "alice_act cache should be removed exactly");

  await invalidateGlobalVisualAssets(ROOT, value);
  const globalAssets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(!Object.keys(globalAssets.bg).length && !Object.keys(globalAssets.cg).length, "global invalidation should clear scene maps");
  assert(!Object.keys(globalAssets.figure).length && !Object.keys(globalAssets.item).length, "global invalidation should clear character/item maps");
  assert(globalAssets.vocal.line, "global invalidation should preserve voices");
  assert(Object.values(value.characters).every((entry) => !entry.approved), "global invalidation should reset every character approval");
}

async function testCharacterOnlyReapprovalPreservesGlobalCaches(): Promise<void> {
  await reset();
  const value = {
    ...bible(),
    status: "approved" as const,
    approvedAt: "2026-08-07T00:00:00.000Z",
    cacheBinding: {
      globalFingerprint: "approved-global-v1",
      characterRevisions: { alice: 1, bob: 1, alice_alt: 1, alice_act: 1 },
    },
  };
  const cards = [character("alice"), character("bob"), character("alice_alt"), character("alice_act")];
  await writeRequiredArtifacts(value);
  value.inputFingerprint = computeVisualBibleFingerprint({
    novel: novel(),
    characters: cards,
    styleSource: value.styleSource,
    styleDescription: value.styleDescription,
  });
  await saveVisualBible(ROOT, value);
  const imageDir = `${ROOT}/.novel2vn/cache/images`;
  await tauri.writeFileBase64(`${imageDir}/bg_room.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/item_key.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_bob_normal.png`, PNG_B64);
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify({
    bg: { room: "bg_room.png" },
    cg: { scene: "cg_scene.png" },
    figure: { bob: "figure_bob_normal.png" },
    item: { key: "item_key.png" },
    vocal: {},
  } satisfies AssetMap));

  await invalidateCharacterVisualAssets(ROOT, value, cards[0]);
  assert(value.pendingInvalidation?.scope === "characters" && value.pendingInvalidation.characterIds?.join(",") === "alice", "character mutation should persist an exact pending invalidation scope");
  await acceptCharacterSheet(ROOT, value, "alice");
  await approveVisualBible(ROOT, value, { novel: novel(), characters: cards, now: () => "2026-08-08T00:00:00.000Z" });

  assert(value.status === "approved" && !value.pendingInvalidation, "successful reapproval should consume the pending character scope");
  assert(value.cacheBinding?.globalFingerprint === "approved-global-v1", "character-only reapproval must preserve the global cache binding");
  assert(value.cacheBinding?.characterRevisions.alice === 2, "character-only reapproval should advance only the target character binding");
  assert(await tauri.pathExists(`${imageDir}/bg_room.png`), "character-only reapproval must preserve background caches");
  assert(await tauri.pathExists(`${imageDir}/item_key.png`), "character-only reapproval must preserve item caches");
  assert(await tauri.pathExists(`${imageDir}/figure_bob_normal.png`), "character-only reapproval must preserve other character caches");
  const assets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(assets.bg.room && assets.cg.scene && assets.item.key && assets.figure.bob, "character-only reapproval must preserve unrelated asset mappings");
}

async function testNovelOnlyFingerprintChangeKeepsExplicitCharacterScope(): Promise<void> {
  await reset();
  const originalNovel = novel();
  const changedNovel = novel("Chapter one\nThe city is now a sunlit coastal village.");
  const cards = [character("alice"), character("bob"), character("alice_alt"), character("alice_act")];
  const value = {
    ...bible(),
    status: "approved" as const,
    approvedAt: "2026-08-07T00:00:00.000Z",
    cacheBinding: {
      globalFingerprint: "approved-global-v1",
      characterRevisions: { alice: 1, bob: 1, alice_alt: 1, alice_act: 1 },
    },
  };
  await writeRequiredArtifacts(value);
  value.inputFingerprint = computeVisualBibleFingerprint({
    novel: originalNovel,
    characters: cards,
    styleSource: value.styleSource,
    styleDescription: value.styleDescription,
  });
  await saveVisualBible(ROOT, value);
  const imageDir = `${ROOT}/.novel2vn/cache/images`;
  await tauri.writeFileBase64(`${imageDir}/bg_room.png`, PNG_B64);
  await tauri.writeFileBase64(`${imageDir}/figure_bob_normal.png`, PNG_B64);
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify({
    bg: { room: "bg_room.png" }, cg: { scene: "cg_scene.png" }, figure: { bob: "figure_bob_normal.png" }, item: { key: "item_key.png" }, vocal: {},
  } satisfies AssetMap));

  await invalidateCharacterVisualAssets(ROOT, value, cards[0]);
  await acceptCharacterSheet(ROOT, value, "alice");
  assert(value.pendingInvalidation?.scope === "characters", "setup should begin with character-only pending invalidation");
  const changedFingerprint = computeVisualBibleFingerprint({
    novel: changedNovel,
    characters: cards,
    styleSource: value.styleSource,
    styleDescription: value.styleDescription,
  });
  await refreshVisualBibleFingerprint(ROOT, value, changedFingerprint, cards);
  // 小说正文变了 → 指纹变；但画图输入没变。绝不能升级成 global：那会把全书图片删掉重画（本次线上事故的根因）。
  assert(
    value.pendingInvalidation?.scope === "characters"
    && value.pendingInvalidation.characterIds?.join(",") === "alice",
    "a novel-only fingerprint change must not promote the explicit character scope to global",
  );

  await approveVisualBible(ROOT, value, { novel: changedNovel, characters: cards });
  assert(await tauri.pathExists(`${imageDir}/bg_room.png`), "novel-only reapproval must keep background caches");
  assert(await tauri.pathExists(`${imageDir}/figure_bob_normal.png`), "novel-only reapproval must keep other-character caches");
  assert(value.cacheBinding?.globalFingerprint === "approved-global-v1", "novel-only reapproval must keep the global cache binding");
  const assets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(assets.bg.room && assets.cg.scene && assets.figure.bob && assets.item.key, "novel-only reapproval must keep every unrelated visual mapping");
}

async function testCharacterReferenceFingerprintRefreshPreservesScope(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  value.pendingInvalidation = { scope: "characters", characterIds: ["alice"] };
  await saveVisualBible(ROOT, value);
  await refreshVisualBibleFingerprint(ROOT, value, "changed-reference-fingerprint", [character("alice")]);
  assert(
    value.pendingInvalidation?.scope === "characters"
    && value.pendingInvalidation.characterIds?.join(",") === "alice",
    "a character-reference fingerprint refresh must preserve the pending character scope",
  );
}

async function testLegacyMigrationKeepsInlineDataOnConflictAndPublishFailure(): Promise<void> {
  await reset();
  const legacy = `data:image/png;base64,${PNG_B64}`;
  const cards = [character("alice", legacy)];
  const value = bible();
  delete value.characters.bob;
  delete value.characters.alice_alt;
  await writeRequiredArtifacts(value);

  const originalWriteFileBase64 = tauri.writeFileBase64;
  tauri.writeFileBase64 = async (path, dataB64) => {
    if (path.includes("character-reference_alice.rev-") && path.endsWith(".png")) {
      throw new Error("injected migration write failure");
    }
    return originalWriteFileBase64(path, dataB64);
  };
  try {
    let writeFailed = false;
    try {
      await saveVisualBible(ROOT, value, cards);
    } catch (error) {
      writeFailed = error instanceof Error && error.message.includes("migration write failure");
    }
    assert(writeFailed, "migration should surface reference write failures");
    assert(cards[0].referenceImage === legacy && !cards[0].referenceImagePath, "failed migration write must preserve inline data");
  } finally {
    tauri.writeFileBase64 = originalWriteFileBase64;
  }

  await tauri.writeFileBase64(visualBiblePath(ROOT, "character-reference_alice.png"), "ZGlmZmVyZW50");

  let conflicted = false;
  try {
    await saveVisualBible(ROOT, value, cards);
  } catch (error) {
    conflicted = error instanceof Error && error.message.includes("conflict");
  }
  assert(conflicted, "migration should reject an existing target with different bytes");
  assert(cards[0].referenceImage === legacy && !cards[0].referenceImagePath, "migration conflict must preserve inline data and path state");

  await tauri.removePath(visualBiblePath(ROOT, "character-reference_alice.png"));
  const originalReplacePath = tauri.replacePath;
  tauri.replacePath = async (src, dst) => {
    if (dst === visualBibleManifestPath(ROOT)) throw new Error("injected publish failure");
    return originalReplacePath(src, dst);
  };
  try {
    let failed = false;
    try {
      await saveVisualBible(ROOT, value, cards);
    } catch (error) {
      failed = error instanceof Error && error.message.includes("injected publish failure");
    }
    assert(failed, "migration should surface directory publication failure");
    assert(cards[0].referenceImage === legacy && !cards[0].referenceImagePath, "failed publication must preserve inline data");
  } finally {
    tauri.replacePath = originalReplacePath;
  }
}

async function testDraftAndManifestFailuresPreservePublishedBible(): Promise<void> {
  await reset();
  const old = { ...bible(), status: "approved" as const, approvedAt: "2026-08-07T00:00:00.000Z" };
  await writeRequiredArtifacts(old);
  await saveVisualBible(ROOT, old);
  const oldManifest = (await tauri.readTextFile(visualBibleManifestPath(ROOT))).text;
  let generationAttempt = 0;
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES") ? "ink wash, muted palette, diffuse light" : "ink wash evidence",
    chatVision: async () => "unused",
    generateImage: async () => {
      generationAttempt += 1;
      if (generationAttempt === 3) throw new Error("injected second-character failure");
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  let generationFailed = false;
  try {
    await createVisualBibleDraft({
      outputDir: ROOT,
      novel: novel(),
      cards: { title: "Book", characters: [character("alice"), character("bob")], scenes: [], items: [] },
      imageCfg: apiConfig("image"),
      styleSource: "novel_analysis",
      llmCfg: apiConfig("text"),
    }, dependencies);
  } catch (error) {
    generationFailed = error instanceof Error && error.message.includes("second-character");
  }
  assert(generationFailed, "draft should surface a character generation failure");
  assert((await tauri.readTextFile(visualBibleManifestPath(ROOT))).text === oldManifest, "failed draft must preserve the approved manifest");
  assert(await tauri.readFileBase64(visualBiblePath(ROOT, old.styleReferencePath)) === PNG_B64, "failed draft must preserve approved artifacts");

  const changed = { ...old, styleDescription: "replacement style" };
  const originalReplacePath = tauri.replacePath;
  tauri.replacePath = async (src, dst) => {
    if (dst === visualBibleManifestPath(ROOT)) throw new Error("injected manifest replace failure");
    return originalReplacePath(src, dst);
  };
  try {
    let publishFailed = false;
    try {
      await saveVisualBible(ROOT, changed);
    } catch (error) {
      publishFailed = error instanceof Error && error.message.includes("manifest replace failure");
    }
    assert(publishFailed, "manifest publication failure should be surfaced");
    assert((await tauri.readTextFile(visualBibleManifestPath(ROOT))).text === oldManifest, "failed publication must preserve the old manifest");
  } finally {
    tauri.replacePath = originalReplacePath;
  }
}

async function testLegacyMigrationIsIdempotent(): Promise<void> {
  await reset();
  const legacy = `data:image/png;base64,${PNG_B64}`;
  const cards = [character("alice", legacy)];
  const value = bible();
  delete value.characters.bob;
  await writeRequiredArtifacts(value);

  await saveVisualBible(ROOT, value, cards);
  const canonical = cards[0].referenceImagePath!;
  assert(cards[0].referenceImage === undefined, "successful migration should clear legacy payload in memory");
  assert(cards[0].referenceImagePath === canonical, "successful migration should set the project-local path");
  assert(value.characters.alice.sourceReferencePath === canonical, "manifest should point at migrated reference");
  assert(await tauri.pathExists(visualBiblePath(ROOT, canonical)), "migrated reference file should exist");

  const firstText = (await tauri.readTextFile(visualBibleManifestPath(ROOT))).text;
  await saveVisualBible(ROOT, value, cards);
  const secondText = (await tauri.readTextFile(visualBibleManifestPath(ROOT))).text;
  assert(firstText === secondText, "repeated saves should not duplicate or rewrite the migration");
  assert(!secondText.includes(PNG_B64), "migrated manifest must remain base64-free");
}

async function testAnalysisUsesBoundedInputs(): Promise<void> {
  const textInputs: string[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => {
      textInputs.push(user);
      return user.includes("STYLE SUMMARIES")
        ? "cinematic anime, cool cyan palette, ink linework, soft rim lighting, 35mm framing"
        : "era: near future; genre: mystery; mood: tense; palette: cyan; medium: anime; lighting: soft";
    },
    chatVision: async () => "watercolor storybook, muted green palette, delicate linework, diffuse daylight",
    generateImage: async () => ({ dataB64: PNG_B64, mime: "image/png" }),
  };
  const longText = "neon rain and quiet streets. ".repeat(1_500);
  const longNovel = novel(longText);
  longNovel.chapters = [
    { index: 0, title: "Long", text: longText, charCount: longText.length, enabled: true },
    { index: 1, title: "Disabled", text: "SHOULD_NOT_APPEAR", charCount: 17, enabled: false },
  ];
  const style = await analyzeNovelStyle(apiConfig("text"), longNovel, dependencies);
  assert(style.startsWith("cinematic anime"), "novel analysis should synthesize one English style suffix");
  assert(textInputs.length > 2, "long novels should be analyzed in multiple bounded chunks plus synthesis");
  assert(textInputs.slice(0, -1).every((input) => input.length < 13_000), "each novel-analysis request should be bounded");
  assert(textInputs.every((input) => !input.includes("SHOULD_NOT_APPEAR")), "disabled chapters must not be analyzed");

  const visual = await analyzeReferenceStyle(
    apiConfig("vision"),
    { dataB64: PNG_B64, mime: "image/png" },
    dependencies,
  );
  assert(visual.includes("watercolor storybook"), "reference analysis should return the visual model description");
}

async function testBothDraftSourcesCreateCanonicalArtifacts(): Promise<void> {
  await reset();
  const generations: { prompt: string; references: ImageReference[] }[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES")
      ? "graphic novel, restrained red and teal palette, crisp inks, dramatic side lighting"
      : "era: contemporary; genre: thriller; mood: tense; palette: red and teal; medium: graphic novel",
    chatVision: async () => "painted animation, blue-gold palette, clean linework, warm cinematic light",
    generateImage: async (_cfg, prompt, options) => {
      generations.push({ prompt, references: options.references ?? [] });
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  const sourcePath = `${ROOT}/uploaded-style.webp`;
  const characterPath = `${ROOT}/uploaded-alice.jpg`;
  await tauri.writeFileBase64(sourcePath, PNG_B64);
  await tauri.writeFileBase64(characterPath, PNG_B64);
  const draftCachePath = `${ROOT}/.novel2vn/cache/images/bg_legacy.png`;
  await tauri.writeFileBase64(draftCachePath, PNG_B64);
  await tauri.writeTextFile(`${ROOT}/.novel2vn/assets.json`, JSON.stringify({
    bg: { legacy: "bg_legacy.png" },
    cg: {},
    figure: {},
    item: { legacy: "item_legacy.png" },
    vocal: { line: "line.wav" },
  } satisfies AssetMap));

  const referenceDraft = await createVisualBibleDraft({
    outputDir: ROOT,
    novel: novel(),
    cards: { title: "Book", characters: [character("alice")], scenes: [], items: [] },
    imageCfg: apiConfig("image"),
    styleSource: "reference_image",
    visionCfg: apiConfig("vision"),
    styleReference: { sourcePath, mime: "image/webp" },
    characterReferences: { alice: { sourcePath: characterPath, mime: "image/jpeg" } },
  }, dependencies);
  assert(/^style-reference\.rev-[A-Za-z0-9-]+\.webp$/.test(referenceDraft.styleReferencePath), "uploaded style should use revisioned canonical storage");
  assert(/^character-reference_alice\.rev-[A-Za-z0-9-]+\.jpg$/.test(referenceDraft.characters.alice.sourceReferencePath ?? ""), "character upload should use revisioned canonical storage");
  assert(await tauri.pathExists(visualBiblePath(ROOT, referenceDraft.characters.alice.threeViewPath)), "reference mode should create the three-view sheet");
  assert(
    generations.length === 1 && generations[0].references.map((reference) => reference.role).join(",") === "identity,style",
    "reference mode should send character identity before global style",
  );
  assert(
    generations[0].references[0].required === true && generations[0].references[1].required === false,
    "character identity should remain required when global style is optional",
  );
  assert(!(await tauri.pathExists(draftCachePath)), "publishing a new visual-bible draft should invalidate pre-bible image caches");
  const draftAssets = JSON.parse((await tauri.readTextFile(`${ROOT}/.novel2vn/assets.json`)).text) as AssetMap;
  assert(!Object.keys(draftAssets.bg).length && !Object.keys(draftAssets.item).length, "draft publication should clear pre-bible visual mappings");
  assert(draftAssets.vocal.line, "draft publication invalidation should preserve voice mappings");

  await reset();
  generations.length = 0;
  const novelAlice = character("alice");
  novelAlice.actions = [{ id: "wave", name: "Wave", prompt: "alice waving" }];
  const novelDraft = await createVisualBibleDraft({
    outputDir: ROOT,
    novel: novel(),
    cards: { title: "Book", characters: [novelAlice, character("bob")], scenes: [], items: [] },
    imageCfg: apiConfig("image"),
    styleSource: "novel_analysis",
    llmCfg: apiConfig("text"),
  }, dependencies);
  assert(/^style-sample\.rev-[A-Za-z0-9-]+\.png$/.test(novelDraft.styleReferencePath), "novel mode should use revisioned canonical storage");
  assert(await tauri.pathExists(visualBiblePath(ROOT, novelDraft.styleReferencePath)), "novel mode should persist the style sample");
  assert(Object.keys(novelDraft.characters).length === 2, "novel mode should create one sheet per main character");
  assert(novelDraft.characters.alice.actionIds?.[0] === "wave", "draft creation should persist production action IDs for reload validation");
  assert(generations.length === 3, "novel mode should generate one sample and two sheets");
  assert(generations[0].prompt.toLowerCase().includes("no people"), "style sample should explicitly exclude characters");
  assert(
    generations.slice(1).every((generation) => generation.references.length === 1
      && generation.references[0].role === "style"
      && generation.references[0].required === true),
    "characters without identity uploads should require the global style reference",
  );
  assert(Object.values(novelDraft.characters).every((entry) => !entry.approved && entry.revision === 1), "new sheets should require review");
}

async function testMissingStyleReferenceRejectsSheetRegeneration(): Promise<void> {
  await reset();
  const value = bible();
  let generationCalled = false;
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async () => "unused",
    chatVision: async () => "unused",
    generateImage: async () => {
      generationCalled = true;
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };

  let missing: unknown;
  try {
    await regenerateCharacterSheet(ROOT, value, {
      character: character("alice"),
      imageCfg: apiConfig("image"),
      dependencies,
    });
  } catch (error) {
    missing = error;
  }
  assert(
    missing instanceof ReferenceImageError && missing.code === "REFERENCE_MISSING",
    "missing global style files should reject sheet regeneration with REFERENCE_MISSING",
  );
  assert(!generationCalled, "sheet regeneration must stop before the image API when global style is missing");
}

async function testRegenerateDescriptionToleratesTrailingChatter(): Promise<void> {
  // 真实故障：模型在 JSON 后跟一段闲聊，以前报 Unexpected non-whitespace character after JSON
  const chatter = `{"imagePrompt": "alice silver hair, black coat, full body", "threeViewPrompt": "alice turnaround sheet"}\n希望这个描述对你有帮助！如需调整请告诉我。`;
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async () => chatter,
    chatVision: async () => "unused",
    generateImage: async () => ({ dataB64: PNG_B64, mime: "image/png" }),
  };
  const result = await regenerateCharacterDescription(apiConfig("text"), character("alice"), dependencies);
  assert(result.imagePrompt.includes("silver hair"), "带尾巴闲聊也应解析出 imagePrompt");
  assert(result.threeViewPrompt.includes("turnaround"), "带尾巴闲聊也应解析出 threeViewPrompt");
}

async function testBatchRegenerationParallelizesAndIsolatesFailures(): Promise<void> {
  await reset();
  const value = bible();
  await writeRequiredArtifacts(value);
  await saveVisualBible(ROOT, value);

  let inFlight = 0;
  let maxInFlight = 0;
  let progressCalls = 0;
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => {
      const name = /ROLE NAME\n(\S+)/.exec(user)?.[1] ?? "unknown";
      return JSON.stringify({ imagePrompt: `${name} regen figure`, threeViewPrompt: `${name} regen turnaround` });
    },
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (prompt.includes("bob regen")) throw new Error("boom-bob");
        return { dataB64: PNG_B64, mime: "image/png" };
      } finally {
        inFlight -= 1;
      }
    },
  };
  const result = await regenerateAllCharacterSheets(ROOT, value, {
    characters: [character("alice"), character("bob"), character("alice_alt")],
    imageCfg: apiConfig("image"),
    visionCfg: apiConfig("text"),
    concurrency: 2,
    onProgress: () => {
      progressCalls += 1;
    },
    dependencies,
  });
  assert(maxInFlight === 2, `批量重建应 2 并发，实际峰值 ${maxInFlight}`);
  assert(progressCalls === 3, `进度应回调 3 次，实际 ${progressCalls}`);
  assert(result.ok.length === 2 && result.failed.length === 1, "2 成功 1 失败");
  assert(result.failed[0].id === "bob" && result.failed[0].reason.includes("boom-bob"), "bob 的失败应被记录");
  const aliceCard = result.updatedCards.find((c) => c.id === "alice")!;
  assert(aliceCard.imagePrompt === "alice regen figure", "成功角色的卡片描述应同步新提示词");

  // 清单一次提交：成功者更新＋打回待确认，失败者原样保留（无丢更新）
  const loaded = await loadVisualBible(ROOT);
  const manifest = loaded.visualBible!;
  assert(/\.rev-[A-Za-z0-9-]+\.png$/.test(manifest.characters.alice.threeViewPath), "alice 应指向新 rev 三视图");
  assert(manifest.characters.alice.approved === false, "alice 应打回待确认");
  assert(manifest.characters.alice_alt.approved === false, "alice_alt 应打回待确认");
  assert(manifest.characters.bob.threeViewPath === "threeview_bob.png", "失败的 bob 条目不应被碰");
  assert(manifest.characters.bob.approved === true, "失败的 bob 应保持已确认");
}

async function testBatchRegenerationRebuildsCostumeSheets(): Promise<void> {
  await reset();
  const value = bible();
  // 预置一个已不存在的旧服装锚点：卡片去掉该服装后，全局重建应删掉它（与单角色重建同语义）
  value.characters.alice.costumeSheets = {
    old: { threeViewPath: "threeview_alice_ct_old.png", prompt: "alice old outfit", revision: 1, approved: true },
  };
  await writeRequiredArtifacts(value);
  await tauri.writeFileBase64(visualBiblePath(ROOT, "threeview_alice_ct_old.png"), PNG_B64);
  await saveVisualBible(ROOT, value);

  const generations: { prompt: string; references: ImageReference[] }[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async () => JSON.stringify({ imagePrompt: "alice regen figure", threeViewPrompt: "alice regen turnaround" }),
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt, options) => {
      generations.push({ prompt, references: options.references ?? [] });
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  const aliceWithCostume = character("alice");
  aliceWithCostume.costumes = [
    { id: "battle", name: "战斗服", prompt: "alice wearing battle armor, full body, anime style" },
  ];
  const result = await regenerateAllCharacterSheets(ROOT, value, {
    characters: [aliceWithCostume],
    imageCfg: apiConfig("image"),
    visionCfg: apiConfig("text"),
    dependencies,
  });
  assert(result.ok.length === 1 && result.failed.length === 0, "批量重建应成功");

  const loaded = await loadVisualBible(ROOT);
  const sheets = loaded.visualBible!.characters.alice.costumeSheets;
  assert(sheets?.["battle"] !== undefined, "全局重建应为现存服装生成三视图锚点（与单角色重建一致）");
  assert(sheets?.["old"] === undefined, "卡片已无的服装锚点应在全局重建后被清除");
  assert(
    await tauri.pathExists(visualBiblePath(ROOT, sheets!.battle.threeViewPath)),
    "重建的服装锚点文件应落盘",
  );
  const costumeGeneration = generations.find((generation) => generation.prompt.includes("battle armor"));
  assert(costumeGeneration !== undefined, "服装锚点生成应被调用");
  assert(
    costumeGeneration.references[0]?.role === "identity" && costumeGeneration.references[1]?.role === "style",
    "服装锚点应以新默认装三视图为身份参考＋全局风格",
  );
  assert(loaded.visualBible!.characters.alice.approved === false, "重建后角色应打回待确认");
}

async function testLifecycleOperationsRequireFreshReview(): Promise<void> {
  await reset();
  const value: ProjectVisualBible = { ...bible(), status: "approved" as const, approvedAt: "2026-08-07T00:00:00.000Z" };
  await writeRequiredArtifacts(value);
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async () => "hand-painted cel animation, moss and crimson palette, textured inks, low-key lighting",
    chatVision: async () => "unused",
    generateImage: async () => ({ dataB64: PNG_B64, mime: "image/png" }),
  };

  await updateStyleDescription(ROOT, value, "edited style", "fingerprint-2");
  assert(value.status === "stale" && !value.approvedAt, "editing global style should stale an approved bible");
  assert(Object.values(value.characters).every((entry) => !entry.approved), "editing global style should reset all character approvals");
  assert(value.inputFingerprint === "fingerprint-2", "style edits should refresh the supplied fingerprint");

  const rewritten = await rewriteStyleDescription(ROOT, value, {
    llmCfg: apiConfig("text"),
    instruction: "make it moodier",
    dependencies,
  });
  assert(rewritten.startsWith("hand-painted cel animation"), "rewrite should apply the text model result");
  await regenerateStyleSample(ROOT, value, apiConfig("image"), dependencies);
  assert(/^style-sample\.rev-[A-Za-z0-9-]+\.png$/.test(value.styleReferencePath), "sample regeneration should publish a revisioned sample");

  const beforeAlice = value.characters.alice.revision;
  const beforeBob = value.characters.bob.revision;
  const alice = character("alice");
  await regenerateCharacterSheet(ROOT, value, { character: alice, imageCfg: apiConfig("image"), dependencies });
  assert(value.characters.alice.revision === beforeAlice + 1, "target sheet revision should increment");
  assert(value.characters.bob.revision === beforeBob, "other character revisions should remain unchanged");
  await acceptCharacterSheet(ROOT, value, "alice");
  assert(value.characters.alice.approved, "accepting an existing sheet should mark only that character approved");
  const accepted = await loadVisualBible(ROOT);
  assert(accepted.visualBible?.characters.alice.approved, "sheet acceptance should persist without relying on a store watcher");

  await replaceCharacterReference(ROOT, value, alice, { dataB64: PNG_B64, mime: "image/png" });
  assert(
    value.characters.alice.sourceRevision !== value.characters.alice.sheetSourceRevision,
    "replacing a source should leave the old sheet tied to the prior source revision",
  );
  let staleSheetRejected = false;
  try {
    await acceptCharacterSheet(ROOT, value, "alice");
  } catch (error) {
    staleSheetRejected = error instanceof Error && error.message.includes("source revision");
  }
  assert(staleSheetRejected, "a sheet generated from an older source must not be accepted");

  await regenerateCharacterSheet(ROOT, value, { character: alice, imageCfg: apiConfig("image"), dependencies });
  assert(
    value.characters.alice.sourceRevision === value.characters.alice.sheetSourceRevision,
    "regenerating a sheet should bind it to the current source revision",
  );
  await acceptCharacterSheet(ROOT, value, "alice");
}

async function testCostumeSheetsGeneratedAndFingerprinted(): Promise<void> {
  await reset();
  const generations: { prompt: string; references: ImageReference[] }[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES")
      ? "graphic novel, restrained red and teal palette, crisp inks"
      : "era: contemporary; genre: thriller; mood: tense",
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt, options) => {
      generations.push({ prompt, references: options.references ?? [] });
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  const aliceWithCostume = character("alice");
  aliceWithCostume.costumes = [
    { id: "battle", name: "战斗服", prompt: "alice wearing battle armor, full body, anime style" },
    { id: "formal", name: "礼服", prompt: "alice wearing a formal dress, full body, anime style" },
  ];

  const draft = await createVisualBibleDraft({
    outputDir: ROOT,
    novel: novel(),
    cards: { title: "Book", characters: [aliceWithCostume], scenes: [], items: [] },
    imageCfg: apiConfig("image"),
    styleSource: "novel_analysis",
    llmCfg: apiConfig("text"),
  }, dependencies);

  // #1518：守门草稿只出「一个角色一张三视图」——守门的职责是确认人物形象，一个角色一张图。
  // 换装三视图锚点属于正式生成的内容，草稿里不再生成。
  // （784e8e2 曾在此为每套服装多画一张：25 角色 + 92 套服装 = 118 张，全部发生在点「批准」之前。）
  assert(
    draft.characters.alice.costumeSheets === undefined,
    "守门草稿不得生成换装三视图锚点（应留到正式生成阶段）",
  );
  assert(
    generations.filter((g) => g.prompt.includes("battle armor") || g.prompt.includes("formal dress")).length === 0,
    "守门草稿不得为服装发起任何图像请求",
  );

  // 锚点改由正式生成阶段的 ensureCostumeAnchors 按需补建
  // 走真实批准流程：接受角色三视图 → 批准守门（ensureCostumeAnchors 只在已批准时工作）
  await acceptCharacterSheet(ROOT, draft, "alice");
  await approveVisualBible(ROOT, draft, { novel: novel(), characters: [aliceWithCostume] });
  const ensured = await ensureCostumeAnchors(ROOT, [aliceWithCostume], apiConfig("image"), dependencies);
  assert(ensured.created === 2, `应为 2 套服装补建锚点，实际 ${ensured.created}`);

  const loaded = await loadVisualBible(ROOT);
  const battleSheet = loaded.visualBible?.characters.alice.costumeSheets?.["battle"];
  assert(battleSheet !== undefined, "ensureCostumeAnchors 应为每套服装补建锚点");
  assert(
    /^threeview_alice_ct_battle\.rev-[A-Za-z0-9-]+\.png$/.test(battleSheet.threeViewPath),
    `costume sheet should use canonical path: ${battleSheet.threeViewPath}`,
  );
  assert(battleSheet.prompt.includes("battle armor"), "costume sheet prompt should be the costume prompt");
  assert(await tauri.pathExists(visualBiblePath(ROOT, battleSheet.threeViewPath)), "costume sheet artifact should exist on disk");
  assert(canonicalCostumeSheetPath("alice", "battle") === "threeview_alice_ct_battle.png", "canonical costume sheet path helper");
  assert(loaded.visualBible?.characters.alice.costumeSheets?.["formal"] !== undefined, "all costumes should get a sheet");

  // 换装三视图的身份参考 = 默认装三视图（role identity 在前、style 在后）
  const costumeGeneration = generations.find((generation) => generation.prompt.includes("battle armor"));
  assert(costumeGeneration !== undefined, "costume sheet generation should have been called");
  assert(
    costumeGeneration.references[0]?.role === "identity" && costumeGeneration.references[1]?.role === "style",
    "costume sheet should reference base three-view identity + global style",
  );

  // 幂等：已有锚点时必须跳过，不得重复付费
  const again = await ensureCostumeAnchors(ROOT, [aliceWithCostume], apiConfig("image"), dependencies);
  assert(again.created === 0, "已有锚点时必须跳过，不得重复付费生成");

  // 服装三视图纳入指纹：存在时改变指纹
  const cards = [aliceWithCostume];
  const approvedBible = loaded.visualBible!;
  const fpWith = await computeProjectVisualBibleFingerprint(ROOT, approvedBible, novel(), cards);
  const withoutSheets = {
    ...approvedBible,
    characters: { alice: { ...approvedBible.characters.alice, costumeSheets: undefined } },
  };
  const fpWithout = await computeProjectVisualBibleFingerprint(ROOT, withoutSheets, novel(), cards);
  assert(fpWith !== fpWithout, "costume sheets should alter the visual-bible fingerprint");
}

/** #1519 回归：草稿阶段必须认领孤儿三视图，否则「上一次草稿失败 → 重跑」要再付一遍全款。 */
async function testDraftAdoptsOrphanThreeViewsWithoutRegenerating(): Promise<void> {
  await reset();
  const generations: string[] = [];
  const progress: { done: number; total: number }[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES")
      ? "graphic novel, restrained red and teal palette, crisp inks"
      : "era: contemporary; genre: thriller; mood: tense",
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt) => {
      generations.push(prompt);
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  const cards = { title: "Book", characters: [character("alice"), character("bob")], scenes: [], items: [] };
  const draftInput = {
    outputDir: ROOT,
    novel: novel(),
    cards,
    imageCfg: apiConfig("image"),
    styleSource: "novel_analysis" as const,
    llmCfg: apiConfig("text"),
  };

  const first = await createVisualBibleDraft(draftInput, dependencies);
  assert(generations.length === 3, `首次草稿应为 1 张风格 + 2 张三视图，实际 ${generations.length}`);
  const aliceSheet = first.characters.alice.threeViewPath;
  assert(await tauri.pathExists(visualBiblePath(ROOT, aliceSheet)), "首次草稿的三视图应落盘");

  // 模拟「上一次草稿因某张图失败而整份丢弃」：清单从未落盘，已付费的产物留在磁盘上
  await tauri.removePath(visualBibleManifestPath(ROOT));
  assert(!(await tauri.pathExists(visualBibleManifestPath(ROOT))), "清单应已被删除以复现失败场景");
  generations.length = 0;

  const second = await createVisualBibleDraft({
    ...draftInput,
    onImageProgress: (done, total) => progress.push({ done, total }),
  }, dependencies);

  assert(
    generations.length === 1,
    `重跑草稿只应重出风格图（孤儿三视图免费认领），实际出图 ${generations.length} 张`,
  );
  assert(
    second.characters.alice.threeViewPath === aliceSheet,
    `认领后应沿用原文件而不是新 revision：${second.characters.alice.threeViewPath} vs ${aliceSheet}`,
  );
  assert(second.characters.alice.approved === false, "认领的条目必须仍是待确认（不得顺带认领 approved）");
  assert(
    progress.every((p) => p.total === 1),
    `认领后进度总数应只剩风格图 1 张，实际 ${JSON.stringify(progress)}`,
  );
  assert(
    await tauri.pathExists(visualBiblePath(ROOT, second.characters.bob.threeViewPath)),
    "bob 的三视图也应被认领且文件可读",
  );
}

/** #1520 回归：单角色出图失败不得作废整份草稿（旧实现一失全丢，且该角色一直失败就永远拿不到草稿）。 */
async function testDraftSurvivesSingleCharacterFailure(): Promise<void> {
  await reset();
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES")
      ? "graphic novel, restrained red and teal palette, crisp inks"
      : "era: contemporary; genre: thriller; mood: tense",
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt) => {
      if (prompt.includes("bob")) throw new Error("API 错误 400: 内容政策");
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  const draft = await createVisualBibleDraft({
    outputDir: ROOT,
    novel: novel(),
    cards: { title: "Book", characters: [character("alice"), character("bob"), character("carol")], scenes: [], items: [] },
    imageCfg: apiConfig("image"),
    styleSource: "novel_analysis",
    llmCfg: apiConfig("text"),
  }, dependencies);

  assert(draft.characters.alice !== undefined, "失败角色之前的条目必须保留");
  assert(
    draft.characters.carol !== undefined,
    "失败角色之后的角色也必须照常出图（单角色失败不得中断整批）",
  );
  assert(draft.characters.bob === undefined, "失败的角色不应建条目");
  assert(
    await tauri.pathExists(visualBibleManifestPath(ROOT)),
    "整份草稿必须落盘——旧实现在这里磁盘上什么都没有，已付费的图全成孤儿",
  );
  const loaded = await loadVisualBible(ROOT);
  assert(loaded.visualBible?.characters.carol !== undefined, "落盘的清单必须包含成功的角色");
  assert(loaded.visualBible?.characters.bob === undefined, "落盘的清单不得含失败角色");
}

/** #1519 回归：换装锚点也必须认领磁盘上的孤儿，否则上次整单未落盘就重复付费。 */
async function testEnsureCostumeAnchorsAdoptsOrphans(): Promise<void> {
  await reset();
  const generations: string[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES")
      ? "graphic novel, restrained red and teal palette, crisp inks"
      : "era: contemporary; genre: thriller; mood: tense",
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt) => {
      generations.push(prompt);
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  const alice = character("alice");
  alice.costumes = [
    { id: "battle", name: "战斗服", prompt: "alice wearing battle armor, full body, anime style" },
    { id: "formal", name: "礼服", prompt: "alice wearing a formal dress, full body, anime style" },
  ];
  const draft = await createVisualBibleDraft({
    outputDir: ROOT,
    novel: novel(),
    cards: { title: "Book", characters: [alice], scenes: [], items: [] },
    imageCfg: apiConfig("image"),
    styleSource: "novel_analysis",
    llmCfg: apiConfig("text"),
  }, dependencies);
  await acceptCharacterSheet(ROOT, draft, "alice");
  await approveVisualBible(ROOT, draft, { novel: novel(), characters: [alice] });

  // 模拟「上一次补建整单未落盘」：清单里没有锚点，但已付费的文件留在产物目录里
  await tauri.writeFileBase64(visualBiblePath(ROOT, "threeview_alice_ct_battle.rev-probe1.png"), PNG_B64);
  await tauri.writeFileBase64(visualBiblePath(ROOT, "threeview_alice_ct_formal.rev-probe1.png"), PNG_B64);
  generations.length = 0;

  const result = await ensureCostumeAnchors(ROOT, [alice], apiConfig("image"), dependencies);
  assert(generations.length === 0, `孤儿锚点应被全部认领、不得重新出图，实际出图 ${generations.length} 张`);
  assert(result.adopted === 2, `应认领 2 张，实际 ${result.adopted}`);
  assert(result.created === 0, `不应新建，实际新建 ${result.created}`);

  const loaded = await loadVisualBible(ROOT);
  assert(
    loaded.visualBible?.characters.alice.costumeSheets?.["battle"]?.threeViewPath ===
      "threeview_alice_ct_battle.rev-probe1.png",
    "认领后清单应指向已有文件",
  );
}

/**
 * 画风一致性回归：参考图是以「裸 base64 数组」发给模型的（api/universal.ts 只发图、不发 role），
 * 模型看不到哪张是人物、哪张是画风。提示词若只说 "the same person"，两张图一起给时它会取折中，
 * 于是**带参考图的角色被那张参考图自己的配色/笔触带跑，画风与不带参考图的角色不一致**。
 */
async function testThreeViewPromptSeparatesIdentityFromStyle(): Promise<void> {
  await reset();
  const prompts: string[] = [];
  const dependencies: VisualBibleServiceDependencies = {
    chatText: async (_cfg, _system, user) => user.includes("STYLE SUMMARIES")
      ? "graphic novel, restrained red and teal palette, crisp inks"
      : "era: contemporary; genre: thriller; mood: tense",
    chatVision: async () => "unused",
    generateImage: async (_cfg, prompt) => {
      prompts.push(prompt);
      return { dataB64: PNG_B64, mime: "image/png" };
    },
  };
  // 带参考图的角色：身份图 + 画风图两张一起发，正是会互相污染的情形
  await createVisualBibleDraft({
    outputDir: ROOT,
    novel: novel(),
    cards: { title: "Book", characters: [character("alice", PNG_B64)], scenes: [], items: [] },
    imageCfg: apiConfig("image"),
    styleSource: "novel_analysis",
    llmCfg: apiConfig("text"),
  }, dependencies);

  const threeView = prompts.find((p) => p.includes("Character turnaround sheet"));
  assert(!!threeView, "应当生成过三视图");
  assert(
    threeView!.includes("art-style reference last"),
    "必须按发送顺序告诉模型画风图是最后一张（模型看不到 role 标签）",
  );
  assert(
    threeView!.includes("Take ONLY the person's face, hair, build and clothing from the identity reference"),
    "必须限定身份图只提供长相/服装，不提供画风",
  );
  assert(
    threeView!.includes("do not let the identity image's own art style, palette or lighting influence the result"),
    "必须显式禁止身份图自己的画风影响结果——这正是画风不一致的成因",
  );
}

async function main(): Promise<void> {
  await testManifestRoundTripAndRecovery();
  await testManifestRejectsIncompleteCharacterCacheBinding();
  await testInterruptedDirectoryPublicationRecoversOnRestart();
  await testDirectSaveRecoversSoleDirectoryBackup();
  await testMutationRejectsUnverifiableRetainedBackup();
  await testInterruptedManifestPublicationRecoversOnRestart();
  await testCharacterAssetKeyCollisionsAreRejectedBeforeUse();
  await testManifestPersistsActionIdsAndRejectsReloadedCollisions();
  await testApprovedBibleWithInvalidArtifactsLoadsStale();
  await testFingerprintTracksBodiesStyleAndReferenceBytes();
  await testApprovalRequiresAcceptedExistingSheets();
  await testApprovalRejectsUntrustedFingerprintAndPersistsStaleState();
  await testConcurrentApprovalAndReferenceReplacementSerialize();
  await testScopedInvalidation();
  await testCharacterOnlyReapprovalPreservesGlobalCaches();
  await testNovelOnlyFingerprintChangeKeepsExplicitCharacterScope();
  await testCharacterReferenceFingerprintRefreshPreservesScope();
  await testLegacyMigrationIsIdempotent();
  await testLegacyMigrationKeepsInlineDataOnConflictAndPublishFailure();
  await testDraftAndManifestFailuresPreservePublishedBible();
  await testAnalysisUsesBoundedInputs();
  await testBothDraftSourcesCreateCanonicalArtifacts();
  await testDraftAdoptsOrphanThreeViewsWithoutRegenerating();
  await testDraftSurvivesSingleCharacterFailure();
  await testEnsureCostumeAnchorsAdoptsOrphans();
  await testThreeViewPromptSeparatesIdentityFromStyle();
  await testCostumeSheetsGeneratedAndFingerprinted();
  await testMissingStyleReferenceRejectsSheetRegeneration();
  await testRegenerateDescriptionToleratesTrailingChatter();
  await testBatchRegenerationParallelizesAndIsolatesFailures();
  await testBatchRegenerationRebuildsCostumeSheets();
  await testLifecycleOperationsRequireFreshReview();
  await tauri.removePath(ROOT).catch(() => {});
  console.log("=== visual bible unit tests passed ===");
}

main().catch((error) => {
  console.error("visual bible unit tests failed:", error);
  process.exit(1);
});
