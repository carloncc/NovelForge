import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useStageStatus } from "../src/composables/useStageStatus";
import type { GenerationOptions } from "../src/core/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const options: GenerationOptions = {
  useImage: true,
  useTts: false,
  useVideoPoints: false,
  useBgm: false,
  figureEmotions: false,
  figureActions: false,
  characterPoses: false,
  imageSelfCheck: false,
  imageBudgetPerChapter: 0,
  cgPerChapter: 0,
  skipCache: false,
  videoPointsPerChapter: 0,
  characterIntroCard: false,
  imageStyle: "",
  imageSeed: 0,
  styleAnchor: false,
  scriptStyle: "",
  language: "",
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "novelforge-stage-status-"));
  try {
    const metaDir = join(root, ".novel2vn");
    const cacheDir = join(metaDir, "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(metaDir, "cards.json"), "{}");
    await writeFile(join(metaDir, "meta.json"), "{}");
    await writeFile(join(cacheDir, "script_ch1_old.json"), "{}");
    await writeFile(join(cacheDir, "script_ch1_new.json"), "{}");
    await writeFile(join(metaDir, "assets.json"), JSON.stringify({ bg: { unrelated: "x" }, cg: {}, figure: {}, item: {}, vocal: {} }));

    const chapter = {
      chapter: 0,
      title: "one",
      scenes: [{ id: "scene-one", title: "scene", summary: "", lines: [], itemEvents: [] }],
    };
    const cards = { title: "test", characters: [], scenes: [], items: [] };

    const status = useStageStatus({
      getOutputDir: () => root.replace(/\\/g, "/"),
      getNovel: () => ({
        fileName: "test.txt",
        sourcePath: "",
        encoding: "UTF-8",
        fullText: "one\ntwo",
        chapters: [
          { index: 0, title: "one", text: "one", charCount: 3, enabled: true },
          { index: 1, title: "two", text: "two", charCount: 3, enabled: true },
        ],
      }),
      getLanguage: () => "",
      getFailedTasks: () => [],
      getLogFailedStages: () => new Set(),
      getBusy: () => false,
      getRunningStages: () => [],
      getResult: () => ({
        meta: { title: "test", gameKey: "test", chapterCount: 1, charCount: 0, sceneCount: 1, lineCount: 0, outputDir: root, webgalVersion: "test", generatedAt: "now" },
        cards,
        chapters: [chapter],
        assets: {},
        cost: { inputTokens: 0, outputTokens: 0, imageCount: 0, ttsChars: 0, llmCostYuan: 0, imageCostYuan: 0, ttsCostYuan: 0, totalYuan: 0 },
        failedTasks: [],
      }),
      getOptions: () => options,
      getTtsConfig: () => undefined,
    });

    await status.refresh();
    assert(status.base.assemble, "meta.json must mark assembly as complete");
    assert(!status.base.script, "multiple caches for one chapter must not mark every chapter complete");
    assert(!status.base.image, "an unrelated image must not mark all expected image tasks complete");
    assert(status.base.voice, "a disabled voice stage must be treated as not required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("=== stage status tests passed ===");
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
