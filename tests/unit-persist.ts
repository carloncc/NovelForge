import { saveProjectState, restoreProjectState } from "../src/utils/persist";
import { computeProjectVisualBibleFingerprint } from "../src/core/visualBible";
import { tauri } from "../src/utils/tauri";
import type { MaterialAsset, ProjectVisualBible } from "../src/core/types";
import { writeFile } from "node:fs/promises";

const DIR = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-persist-${process.pid}`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  await tauri.removePath(DIR).catch(() => {});
  await tauri.mkdirAll(DIR);

  // 准备一个真实的小说源文件
  const novelPath = `${DIR}/小说.txt`;
  await writeFile(novelPath, "第一章 初见\n林澈:你好;\n第二章 再见\n苏晚晴:再见;", "utf-8");
  const { importNovelFile, splitChapters } = await import("../src/core/chapters");

  const novel = await importNovelFile(novelPath);
  novel.chapters[0].title = "第一章 改过的标题";
  novel.chapters[1].enabled = false;

  const materials: MaterialAsset[] = [
    { name: "林澈.png", path: `${DIR}/林澈.png`, kind: "character", mime: "image/png", extra: { mapTo: "linche" } },
  ];
  const options = {
    useImage: true,
    useTts: false,
    imageBudgetPerChapter: 12,
    cgPerChapter: 3,
    skipCache: false,
    maxConcurrent: 2,
    videoPointsPerChapter: 2,
    characterIntroCard: true,
  };

  const visualBible: ProjectVisualBible = {
    version: 1,
    status: "draft",
    styleSource: "novel_analysis",
    styleDescription: "painted animation, cool palette",
    styleReferencePath: "style-sample.png",
    characters: {
      alice: {
        threeViewPath: "threeview_alice.png",
        prompt: "alice turnaround",
        approved: false,
        revision: 1,
      },
    },
    inputFingerprint: "v1-test",
  };
  await tauri.writeFileBase64(`${DIR}/.novel2vn/visual-bible/style-sample.png`, PNG_B64);
  await tauri.writeFileBase64(`${DIR}/.novel2vn/visual-bible/threeview_alice.png`, PNG_B64);

  const lastResult = {
    meta: {
      title: "Book",
      gameKey: "book",
      chapterCount: 2,
      charCount: 1,
      sceneCount: 0,
      lineCount: 0,
      outputDir: DIR,
      webgalVersion: "test",
      generatedAt: "2026-08-08T00:00:00.000Z",
    },
    cards: {
      title: "Book",
      characters: [{
        id: "alice",
        name: "Alice",
        appearance: "silver hair",
        clothing: "black coat",
        personality: "calm",
        voiceDesc: "soft",
        imagePrompt: "alice, silver hair",
        referenceImage: `data:image/png;base64,${PNG_B64}`,
        color: "#fff",
      }],
      scenes: [],
      items: [],
    },
    cost: {
      llmTokens: 0,
      imageCount: 0,
      ttsChars: 0,
      llmCostYuan: 0,
      imageCostYuan: 0,
      ttsCostYuan: 0,
    },
  };

  await saveProjectState({ novel, materials, outputDir: DIR, options, lastResult, visualBible });

  // 模拟重新启动：重新读文件并恢复
  const restored = await restoreProjectState(DIR);
  assert(restored.novel !== null, "小说应恢复");
  assert(restored.novel!.chapters[0].title === "第一章 改过的标题", "章节标题编辑应保留");
  assert(restored.novel!.chapters[1].enabled === false, "章节启用状态应保留");
  assert(restored.novel!.chapters.length === 2, "章节数应保留");
  assert(restored.materials.length === 1 && restored.materials[0].extra?.mapTo === "linche", "素材与映射应保留");
  assert(restored.options?.cgPerChapter === 3, "选项应保留");
  assert(restored.options?.videoPointsPerChapter === 2, "新增选项应保留");

  // 源文件不存在时安全返回空
  assert(restored.visualBible?.styleDescription === visualBible.styleDescription, "visual bible should restore from its canonical manifest");
  const projectJson = (await tauri.readTextFile(`${DIR}/.novel2vn/project_state.json`)).text;
  assert(!projectJson.includes(PNG_B64) && !projectJson.includes("visualBible"), "project JSON should not duplicate the visual-bible manifest or image data");
  assert(
    /^character-reference_alice\.rev-[A-Za-z0-9-]+\.png$/.test(restored.lastResult?.cards.characters[0].referenceImagePath ?? ""),
    "legacy character references should restore as revisioned project-local paths",
  );

  assert(restored.visualBible && restored.novel && restored.lastResult, "restored project should contain the inputs needed to approve its visual bible");
  restored.visualBible.status = "approved";
  restored.visualBible.approvedAt = "2026-08-08T00:00:00.000Z";
  restored.visualBible.characters.alice.approved = true;
  restored.visualBible.characters.alice.sheetSourceRevision = restored.visualBible.characters.alice.sourceRevision;
  restored.visualBible.inputFingerprint = await computeProjectVisualBibleFingerprint(
    DIR,
    restored.visualBible,
    restored.novel,
    restored.lastResult.cards.characters,
  );
  await saveProjectState({
    novel: restored.novel,
    materials: restored.materials,
    outputDir: DIR,
    options: restored.options!,
    lastResult: restored.lastResult,
    visualBible: restored.visualBible,
  });
  await writeFile(novelPath, "changed chapter body after visual-bible approval", "utf-8");
  const staleRestore = await restoreProjectState(DIR);
  assert(staleRestore.visualBible?.status === "stale", "restoring changed chapter bodies should stale an approved visual bible");
  const persistedBible = JSON.parse((await tauri.readTextFile(`${DIR}/.novel2vn/visual-bible/visual-bible.json`)).text) as ProjectVisualBible;
  assert(persistedBible.status === "stale" && !persistedBible.approvedAt, "restore-time fingerprint refresh should persist the stale state");

  const originalWriteTextFile = tauri.writeTextFile;
  tauri.writeTextFile = async (path, content) => {
    if (path.endsWith("/.novel2vn/project_state.json")) throw new Error("injected project-state write failure");
    return originalWriteTextFile(path, content);
  };
  try {
    let saveFailed = false;
    try {
      await saveProjectState({ novel, materials, outputDir: DIR, options, lastResult, visualBible });
    } catch (error) {
      saveFailed = error instanceof Error && error.message.includes("project-state write failure");
    }
    assert(saveFailed, "project-state persistence should surface write failures");
  } finally {
    tauri.writeTextFile = originalWriteTextFile;
  }

  (globalThis as unknown as { window: { setTimeout: () => number } }).window = { setTimeout: () => 1 };
  const { persistCurrentProjectState, projectState, restoreProject } = await import("../src/stores/project");
  projectState.outputDir = DIR;

  await tauri.mkdirAll(`${DIR}/.novel2vn/cache`);
  const cachedChapter = JSON.stringify({ chapter: 0, title: "cached", scenes: [] });
  await tauri.writeTextFile(`${DIR}/.novel2vn/cache/script_ch1_a.json`, cachedChapter);
  await tauri.writeTextFile(`${DIR}/.novel2vn/cache/script_ch1_z.json`, cachedChapter);
  await tauri.writeTextFile(`${DIR}/.novel2vn/cache/script_ch2_a.json`, JSON.stringify({ chapter: 1, title: "cached 2", scenes: [] }));
  await tauri.writeTextFile(`${DIR}/.novel2vn/cache/script_ch3_a.json`, JSON.stringify({ chapter: 2, title: [], scenes: {} }));
  const originalReadTextFile = tauri.readTextFile;
  let scriptCacheReads = 0;
  tauri.readTextFile = async (path) => {
    if (/\/cache\/script/.test(path)) scriptCacheReads++;
    return originalReadTextFile(path);
  };
  try {
    await restoreProject(DIR);
  } finally {
    tauri.readTextFile = originalReadTextFile;
  }
  assert(scriptCacheReads === 3, `project restore should inspect one script cache per chapter, got ${scriptCacheReads}`);
  assert(projectState.lastResult?.chapters.length === 2, "structurally invalid chapter caches must be skipped");

  tauri.writeTextFile = async (path, content) => {
    if (path.endsWith("/.novel2vn/project_state.json")) throw new Error("visible project-state failure");
    return originalWriteTextFile(path, content);
  };
  try {
    const saved = await persistCurrentProjectState();
    assert(!saved, "project-state wrapper should report save failure");
    assert(projectState.saveError?.includes("visible project-state failure") === true, "project state should expose the save error");
  } finally {
    tauri.writeTextFile = originalWriteTextFile;
  }

  const gone = await restoreProjectState(`${DIR}-missing`);
  assert(gone.novel === null && gone.materials.length === 0, "无状态目录应返回空");

  projectState.novel = novel;
  projectState.materials = materials;
  await restoreProject(`${DIR}-missing`);
  assert(projectState.novel === null, "加载空项目时不应保留上一个项目的小说");
  assert(projectState.materials.length === 0, "加载空项目时不应保留上一个项目的素材");

  const corruptDir = `${DIR}-corrupt`;
  await tauri.mkdirAll(`${corruptDir}/.novel2vn`);
  await tauri.writeTextFile(`${corruptDir}/.novel2vn/project_state.json`, "{broken");
  projectState.novel = novel;
  let corruptRejected = false;
  try {
    await restoreProject(corruptDir);
  } catch {
    corruptRejected = true;
  }
  assert(corruptRejected, "损坏的项目状态必须显式拒绝加载");
  assert(projectState.novel?.fileName === novel.fileName, "加载损坏项目失败时必须保留当前项目");

  const malformedDir = `${DIR}-malformed`;
  await tauri.mkdirAll(`${malformedDir}/.novel2vn`);
  await tauri.writeTextFile(`${malformedDir}/.novel2vn/project_state.json`, JSON.stringify({
    materials: { unexpected: true },
    outputDir: malformedDir,
    options: {},
  }));
  const malformed = await restoreProjectState(malformedDir);
  assert(Boolean(malformed.loadError), "结构错误但语法合法的项目状态必须拒绝加载");
  assert(Array.isArray(malformed.materials) && malformed.materials.length === 0, "结构错误状态不得泄漏伪造的素材集合");

  await tauri.removePath(DIR);
  await tauri.removePath(corruptDir);
  await tauri.removePath(malformedDir);
  console.log("=== 状态持久化测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
