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

export function stateFile(outputDir: string): string {
  return `${outputDir}/.novel2vn/project_state.json`;
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
    // 附带源文件全文指纹，恢复时指纹匹配才使用，保证源文件改动后视觉圣经仍能正确降级。
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
  }
  if (state.lastResult) {
    persistedState.lastResult = {
      ...state.lastResult,
      cards: state.visualBible ? withoutInlineReferences(state.lastResult.cards) : state.lastResult.cards,
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
}> {
  const loadedBible = await loadVisualBible(outputDir);
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
    const persistedState = JSON.parse(text) as PersistedState;

    let novel: NovelDoc | null = null;
    const sourcePaths = persistedState.novel?.sourcePaths?.length
      ? persistedState.novel.sourcePaths
      : persistedState.novel?.sourcePath
        ? [persistedState.novel.sourcePath]
        : [];
    const existingPaths = sourcePaths.filter((p) => p);
    if (existingPaths.length && (await Promise.all(existingPaths.map((p) => tauri.pathExists(p)))).every(Boolean)) {
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
    }

    const warnings = [...loadedBible.warnings];
    let visualBible = loadedBible.visualBible;
    if (visualBible && persistedState.lastResult) {
      try {
        validateCharacterAssetKeys(persistedState.lastResult.cards.characters);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Visual bible could not be restored because character asset keys conflict: ${message}`);
        visualBible = null;
      }
    }
    if (visualBible && novel && persistedState.lastResult) {
      try {
        const currentFingerprint = await computeProjectVisualBibleFingerprint(
          outputDir,
          visualBible,
          novel,
          persistedState.lastResult.cards.characters,
        );
        await refreshVisualBibleFingerprint(
          outputDir,
          visualBible,
          currentFingerprint,
          persistedState.lastResult.cards.characters,
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
  } catch {
    return empty;
  }
}

export function splitChaptersForRestore(text: string, title: string): ChapterInfo[] {
  const chapters = splitChaptersForFallback(text);
  if (chapters.length === 1 && !/^第.+章/.test(chapters[0].title)) {
    chapters[0].title = title;
  }
  return chapters;
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
