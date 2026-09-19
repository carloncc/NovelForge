import type { ChapterInfo, CostStats, ExtractionResult, GenerationOptions, MaterialAsset, NovelDoc, ProjectMeta, ProjectVisualBible } from "../core/types";
import { importNovelFile, importNovelFiles } from "../core/chapters";
import { splitChaptersForFallback } from "../core/split";
import {
  computeProjectVisualBibleFingerprint,
  loadVisualBible,
  refreshVisualBibleFingerprint,
  saveVisualBible,
  validateCharacterAssetKeys,
} from "../core/visualBible";
import { tauri } from "./tauri";

interface PersistedState {
  novel?: {
    sourcePath: string;
    sourcePaths?: string[];
    fileName: string;
    encoding: string;
    chapters: { index: number; title: string; enabled?: boolean }[];
    /** AI 分章快照：仅当分章结果无法从源文件重建时保存（正文 + 源文件全文指纹）。恢复时指纹匹配才使用 */
    splitChapters?: {
      fp: string;
      chapters: { index: number; title: string; text: string; enabled?: boolean }[];
    };
  };
  materials: MaterialAsset[];
  outputDir: string;
  options: GenerationOptions;
  lastResult?: {
    meta: ProjectMeta;
    cards: ExtractionResult;
    cost: CostStats;
  };
}

function persistedRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function persistedMaterials(input: unknown): MaterialAsset[] {
  const materials = input ?? [];
  if (!Array.isArray(materials)) throw new Error("project state materials must be an array");
  for (const materialInput of materials) {
    const material = persistedRecord(materialInput, "project material");
    const validKind = material.kind === "character" || material.kind === "item" || material.kind === "background";
    if (typeof material.name !== "string" || typeof material.path !== "string" || !validKind || typeof material.mime !== "string") {
      throw new Error("project state contains an invalid material");
    }
  }
  return materials as MaterialAsset[];
}

function validatePersistedNovel(input: unknown): void {
  if (input === undefined) return;
  const novel = persistedRecord(input, "project novel");
  if (!Array.isArray(novel.chapters)) throw new Error("project novel chapters must be an array");
  for (const chapterInput of novel.chapters) {
    const chapter = persistedRecord(chapterInput, "project novel chapter");
    if (!Number.isInteger(chapter.index) || typeof chapter.title !== "string") throw new Error("project novel contains an invalid chapter");
  }
}

function validatePersistedResult(input: unknown): void {
  if (input === undefined) return;
  const lastResult = persistedRecord(input, "project result");
  persistedRecord(lastResult.meta, "project result meta");
  persistedRecord(lastResult.cost, "project result cost");
  const cards = persistedRecord(lastResult.cards, "project result cards");
  if (!Array.isArray(cards.characters) || !Array.isArray(cards.scenes) || !Array.isArray(cards.items)) throw new Error("project result cards are invalid");
}

function parsePersistedState(input: unknown): PersistedState {
  const state = persistedRecord(input, "project state");
  const materials = persistedMaterials(state.materials);
  if (state.options !== undefined) persistedRecord(state.options, "project options");
  validatePersistedNovel(state.novel);
  validatePersistedResult(state.lastResult);
  return { ...state, materials } as unknown as PersistedState;
}

export function stateFile(outputDir: string): string {
  return `${outputDir}/.novel2vn/project_state.json`;
}

/**
 * 磁盘上的 cards.json / cards_demo.json 是本次运行的「工作副本」：提取阶段、卡片编辑页、
 * 追加合并、id 对齐都只写这里。project_state.json 里的 cards 只是上次保存时的快照，
 * 可能与它不一致；而视觉守门的批准与图像阶段的复算都以卡片为输入，
 * 两边各读一份就会出现「刚批准就被判输入已变化 → 视觉守门失效 → 图片永远生成不出来」。
 * 读取顺序与 pipeline.loadCards 保持一致。
 */
export async function readWorkingCards(outputDir: string): Promise<ExtractionResult | null> {
  for (const name of ["cards.json", "cards_demo.json"]) {
    try {
      const path = `${outputDir}/.novel2vn/${name}`;
      if (!(await tauri.pathExists(path))) continue;
      const { text } = await tauri.readTextFile(path);
      const cards = JSON.parse(text) as ExtractionResult;
      if (cards && Array.isArray(cards.characters) && cards.characters.length) return cards;
    } catch {
      /* 读不到就退回快照 */
    }
  }
  return null;
}

/**
 * 源文件不可读时的兜底：用 .novel2vn/split.json（分章缓存，含每章正文）重建小说。
 * 没有它，重启/「加载该项目」后 projectState.novel 会是 null，
 * 「单章节生成」与「本次重跑 / 分章节生成章节」整块消失（页面只剩「还没有小说」提示），
 * 而分章/提取/剧本/图像其实都还在磁盘上、本该可以继续逐章生成。
 */
async function restoreNovelFromSplitCache(
  outputDir: string,
  fallbackFileName: string,
  fallbackEncoding: string,
  savedChapters?: { index: number; title: string; enabled?: boolean }[],
): Promise<NovelDoc | null> {
  const path = `${outputDir}/.novel2vn/split.json`;
  if (!(await tauri.pathExists(path).catch(() => false))) return null;
  let raw: unknown;
  try {
    raw = (JSON.parse((await tauri.readTextFile(path)).text) as { chapters?: unknown }).chapters;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const saved = new Map((savedChapters ?? []).map((chapter) => [chapter.index, chapter]));
  const chapters: ChapterInfo[] = [];
  for (const [position, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    if (!text) continue;
    const index = Number.isInteger(record.index) ? (record.index as number) : position;
    const restored = saved.get(index);
    chapters.push({
      index,
      title: restored?.title || (typeof record.title === "string" && record.title ? record.title : `第 ${position + 1} 章`),
      text,
      charCount: text.length,
      enabled: restored ? restored.enabled : record.enabled !== false,
    });
  }
  if (!chapters.length) return null;
  return {
    fileName: fallbackFileName,
    sourcePath: "",
    encoding: fallbackEncoding,
    fullText: chapters.map((chapter) => chapter.text).join("\n\n"),
    chapters,
  };
}

export async function saveProjectState(state: {
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  outputDir: string;
  options: GenerationOptions;
  lastResult: { meta: ProjectMeta; cards: ExtractionResult; cost: CostStats } | null;
  visualBible?: ProjectVisualBible | null;
}): Promise<void> {
  if (!state.outputDir) return;
  if (state.visualBible) {
    await saveVisualBible(state.outputDir, state.visualBible, state.lastResult?.cards.characters ?? []);
  }
  const persistedState: PersistedState = {
    materials: state.materials,
    outputDir: state.outputDir,
    options: state.options,
  };
  if (state.novel?.sourcePath) {
    persistedState.novel = {
      sourcePath: state.novel.sourcePath,
      sourcePaths: state.novel.sourcePaths,
      fileName: state.novel.fileName,
      encoding: state.novel.encoding,
      chapters: state.novel.chapters.map((c) => ({ index: c.index, title: c.title, enabled: c.enabled })),
    };
    // AI 分章快照：当分章结果无法用正则从源文件重建时保存（如 AI 分章丢弃了杂项、边界与正则不同）。
    // 附带源文件全文指纹，恢复时指纹匹配才使用，保证源文件改动后视觉守门仍能正确降级。
    if (shouldPersistSplitChapters(state.novel)) {
      persistedState.novel.splitChapters = {
        fp: splitSnapshotFingerprint(state.novel),
        chapters: state.novel.chapters.map((c) => ({
          index: c.index,
          title: c.title,
          text: c.text,
          enabled: c.enabled,
        })),
      };
    }
  } else {
    // 无 sourcePath（示例小说/资产阶段占位/源文件恢复失败）时不能把磁盘上已保存的 novel 段抹掉：
    // 旧实现整文件覆盖，会丢失 sourcePaths/章节标题/enabled 停用标记，导致换项目后无法恢复。
    try {
      const file = stateFile(state.outputDir);
      if (await tauri.pathExists(file)) {
        const { text } = await tauri.readTextFile(file);
        const existing = JSON.parse(text) as PersistedState;
        if (existing && typeof existing === "object" && existing.novel) persistedState.novel = existing.novel;
      }
    } catch {
      /* 读不出旧状态时按无 novel 处理 */
    }
  }
  if (state.lastResult) {
    // B33：无条件剥离卡片内联参考图。旧实现只在有 visualBible 时剥离，
    // 没有 visualBible 的项目会把每个角色的 base64 参考图重复写进 project_state.json
    //（几十 MB 的 JSON，保存/加载都卡）；参考图本身已以路径（referenceImagePath）或在磁盘卡片工作副本里持久化。
    // 恢复侧对 referenceImage 缺失本来就有兼容（字段可选，视觉圣经迁移会按 path 处理）。
    persistedState.lastResult = {
      ...state.lastResult,
      cards: withoutInlineReferences(state.lastResult.cards),
    };
  }
  await tauri.writeTextFile(stateFile(state.outputDir), JSON.stringify(persistedState, null, 2));
}

function withoutInlineReferences(cards: ExtractionResult): ExtractionResult {
  return {
    ...cards,
    characters: cards.characters.map(({ referenceImage: _legacyReference, ...character }) => ({ ...character })),
  };
}

export async function restoreProjectState(outputDir: string): Promise<{
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  options: GenerationOptions | null;
  lastResult: PersistedState["lastResult"] | null;
  visualBible: ProjectVisualBible | null;
  warnings: string[];
  loadError?: string;
}> {
  const workingCards = await readWorkingCards(outputDir);
  const loadedBible = await loadVisualBible(outputDir, workingCards?.characters.map((character) => character.id));
  const empty = {
    novel: null as NovelDoc | null,
    materials: [] as MaterialAsset[],
    options: null as GenerationOptions | null,
    lastResult: null as PersistedState["lastResult"] | null,
    visualBible: loadedBible.visualBible,
    warnings: loadedBible.warnings,
  };
  try {
    if (!(await tauri.pathExists(stateFile(outputDir)))) return empty;
    const { text } = await tauri.readTextFile(stateFile(outputDir));
    const persistedState = parsePersistedState(JSON.parse(text));

    let novel: NovelDoc | null = null;
    let importError: string | undefined;
    const sourcePaths = persistedState.novel?.sourcePaths?.length
      ? persistedState.novel.sourcePaths
      : persistedState.novel?.sourcePath
        ? [persistedState.novel.sourcePath]
        : [];
    const existingPaths = sourcePaths.filter((p) => p);
    if (existingPaths.length && (await Promise.all(existingPaths.map((p) => tauri.pathExists(p)))).every(Boolean)) {
      try {
        const fresh = existingPaths.length > 1
          ? await importNovelFiles(existingPaths)
          : await importNovelFile(existingPaths[0]);
        const snapshot = persistedState.novel?.splitChapters;
        // 快照指纹匹配 → 使用 AI 分章快照恢复（源文件未变化）；否则重新正则切分 + 应用保存的标题/启用
        if (snapshot && snapshot.chapters?.length && snapshot.fp === splitSnapshotFingerprint(fresh)) {
          fresh.chapters = snapshot.chapters.map((c) => ({
            index: c.index,
            title: c.title,
            text: c.text,
            charCount: c.text.length,
            enabled: c.enabled,
          }));
        } else {
          const saved = new Map(persistedState.novel!.chapters.map((c) => [c.index, c]));
          fresh.chapters = fresh.chapters.map((ch, i) => {
            const s = saved.get(ch.index);
            if (s) {
              ch.title = s.title || ch.title;
              ch.enabled = s.enabled;
            }
            return ch;
          });
        }
        fresh.fileName = persistedState.novel!.fileName || fresh.fileName;
        fresh.encoding = persistedState.novel!.encoding || fresh.encoding;
        novel = fresh;
      } catch (error) {
        // B100：源文件"存在"但导入失败（编码损坏/读取竞态）时不能把它抛进外层 catch 直接返回 loadError：
        // 那会跳过下面的分章缓存兜底，重启后逐章生成入口整块消失。这里降级到缓存并把错误附在 warning 上。
        importError = error instanceof Error ? error.message : String(error);
      }
    }

    // 源文件缺失/不可读（重命名、移动、清理过下载目录，或导入时就没有真实路径）时，
    // 用分章缓存把小说重建出来，而不是让重启后的生成页丢掉整个「按章节生成」入口。
    let novelRestoredFromSplitCache = false;
    if (!novel) {
      novel = await restoreNovelFromSplitCache(
        outputDir,
        persistedState.novel?.fileName || "已生成项目",
        persistedState.novel?.encoding || "utf-8",
        persistedState.novel?.chapters,
      );
      novelRestoredFromSplitCache = !!novel;
    }

    const warnings = [...loadedBible.warnings];
    if (novelRestoredFromSplitCache) {
      warnings.push(
        importError
          ? `源小说文件导入失败（${importError}），已用分章缓存重建小说：分章/剧本/图像/逐章生成可继续使用，但「重新分章」等依赖原文的操作需要重新导入小说`
          : "源小说文件不可读，已用分章缓存重建小说：分章/剧本/图像/逐章生成可继续使用，但「重新分章」等依赖原文的操作需要重新导入小说",
      );
    } else if (!novel && (importError || persistedState.novel)) {
      // B100：完全无缓存时给出明确 warning（旧实现静默返回 novel=null，用户只看到「还没有小说」）
      warnings.push(
        importError
          ? `源小说文件导入失败（${importError}），且没有可用的分章缓存，逐章生成不可用：请重新导入小说`
          : "源小说文件不可读，且没有可用的分章缓存，逐章生成不可用：请重新导入小说",
      );
    }
    const persistedCards = workingCards ?? persistedState.lastResult?.cards;
    let visualBible = loadedBible.visualBible;
    if (visualBible && persistedCards) {
      try {
        validateCharacterAssetKeys(persistedCards.characters);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Visual bible could not be restored because character asset keys conflict: ${message}`);
        visualBible = null;
      }
    }
    if (visualBible && novel && persistedCards) {
      try {
        const currentFingerprint = await computeProjectVisualBibleFingerprint(
          outputDir,
          visualBible,
          novel,
          persistedCards.characters,
        );
        await refreshVisualBibleFingerprint(
          outputDir,
          visualBible,
          currentFingerprint,
          persistedCards.characters,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Visual-bible fingerprint refresh failed; approval state was not changed: ${message}`);
      }
    }

    return {
      novel,
      materials: persistedState.materials ?? [],
      options: persistedState.options ?? null,
      lastResult: persistedState.lastResult ?? null,
      visualBible,
      warnings,
    };
  } catch (error) {
    return {
      ...empty,
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 是否应持久化 AI 分章快照：非占位单章，且章节正文与正则切分结果不同（说明是 AI 分章） */
function shouldPersistSplitChapters(novel: NovelDoc): boolean {
  const { chapters, fullText } = novel;
  const isPlaceholder = chapters.length === 1 && chapters[0].title === "全文";
  if (chapters.length <= 1 || isPlaceholder) return false;
  // 与正则切分对比正文：正文结构不同 → AI 分章（丢弃杂项/自定义边界），无法重建
  try {
    const regexSplit = splitChaptersForFallback(fullText);
    if (regexSplit.length !== chapters.length) return true;
    return regexSplit.some((c, i) => c.text !== chapters[i]?.text);
  } catch {
    return true;
  }
}

/** 源文件全文指纹：用于校验分章快照是否仍与当前源文件一致 */
function splitSnapshotFingerprint(novel: NovelDoc): string {
  let h = 5381;
  const fullText = novel.fullText;
  for (const ch of fullText) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return `${fullText.length}:${h.toString(36)}`;
}
