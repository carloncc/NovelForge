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
      const fresh =
        existingPaths.length > 1
          ? await importNovelFiles(existingPaths)
          : await importNovelFile(existingPaths[0]);
      const saved = new Map(persistedState.novel!.chapters.map((c) => [c.index, c]));
      fresh.chapters = fresh.chapters.map((ch, i) => {
        const s = saved.get(ch.index);
        if (s) {
          ch.title = s.title || ch.title;
          ch.enabled = s.enabled;
        }
        return ch;
      });
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
