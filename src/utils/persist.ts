import type { ChapterInfo, CostStats, ExtractionResult, GenerationOptions, MaterialAsset, NovelDoc, ProjectMeta } from "../core/types";
import { importNovelFile, splitChapters } from "../core/chapters";
import { tauri } from "./tauri";

interface PersistedState {
  novel?: {
    sourcePath: string;
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
}): Promise<void> {
  if (!state.outputDir) return;
  const data: PersistedState = {
    materials: state.materials,
    outputDir: state.outputDir,
    options: state.options,
  };
  if (state.novel?.sourcePath) {
    data.novel = {
      sourcePath: state.novel.sourcePath,
      fileName: state.novel.fileName,
      encoding: state.novel.encoding,
      chapters: state.novel.chapters.map((c) => ({ index: c.index, title: c.title, enabled: c.enabled })),
    };
  }
  if (state.lastResult) {
    data.lastResult = state.lastResult;
  }
  try {
    await tauri.writeTextFile(stateFile(state.outputDir), JSON.stringify(data, null, 2));
  } catch {
    /* 忽略保存失败 */
  }
}

export async function restoreProjectState(outputDir: string): Promise<{
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  options: GenerationOptions | null;
  lastResult: PersistedState["lastResult"] | null;
}> {
  const empty = { novel: null as NovelDoc | null, materials: [] as MaterialAsset[], options: null as GenerationOptions | null, lastResult: null as PersistedState["lastResult"] | null };
  try {
    if (!(await tauri.pathExists(stateFile(outputDir)))) return empty;
    const { text } = await tauri.readTextFile(stateFile(outputDir));
    const data = JSON.parse(text) as PersistedState;

    let novel: NovelDoc | null = null;
    if (data.novel?.sourcePath && (await tauri.pathExists(data.novel.sourcePath))) {
      const fresh = await importNovelFile(data.novel.sourcePath);
      const saved = new Map(data.novel.chapters.map((c) => [c.index, c]));
      fresh.chapters = fresh.chapters.map((ch, i) => {
        const s = saved.get(ch.index);
        if (s) {
          ch.title = s.title || ch.title;
          ch.enabled = s.enabled;
        }
        return ch;
      });
      fresh.fileName = data.novel.fileName || fresh.fileName;
      fresh.encoding = data.novel.encoding || fresh.encoding;
      novel = fresh;
    }

    return {
      novel,
      materials: data.materials ?? [],
      options: data.options ?? null,
      lastResult: data.lastResult ?? null,
    };
  } catch {
    return empty;
  }
}

export function splitChaptersForRestore(text: string, title: string): ChapterInfo[] {
  return splitChapters(text, title);
}
