import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useStageStatus } from "../src/composables/useStageStatus";
import { cardsFingerprint, scriptCacheRest } from "../src/core/cache";
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
      scenes: [{ id: "scene-one", location: "", atmosphere: "", time: "", bgPrompt: "", lines: [], itemEvents: [], figures: [] }],
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
        cost: { llmTokens: 0, imageCount: 0, ttsChars: 0, llmCostYuan: 0, imageCostYuan: 0, ttsCostYuan: 0 },
        failedTasks: [],
      }),
      getOptions: () => options,
      getTtsConfig: () => undefined,
      getLlmAvailable: () => false,
    });

    await status.refresh();
    assert(status.base.assemble, "meta.json must mark assembly as complete");
    assert(!status.base.script, "multiple caches for one chapter must not mark every chapter complete");
    assert(!status.base.image, "an unrelated image must not mark all expected image tasks complete");
    assert(status.base.voice, "a disabled voice stage must be treated as not required");

    // ---- #1501：看板的剧本阶段必须按当前模式取代码（demo vs 正式）----
    // 旧实现两个前缀都认，于是"未配置文本 API 时跑过一次演示"之后，
    // 正式模式下看板会被演示缓存点绿（看板与真实产物不符）。
    const styleFrag = options.scriptStyle ?? "";
    const chapters = [
      { index: 0, title: "one", text: "one" },
      { index: 1, title: "two", text: "two" },
    ];
    const fresh = (title: string, text: string): string => scriptCacheRest(title, text, styleFrag);
    // 清掉上面那两个不匹配的缓存，只留演示变体
    await rm(join(cacheDir, "script_ch1_old.json"), { force: true });
    await rm(join(cacheDir, "script_ch1_new.json"), { force: true });
    await writeFile(join(cacheDir, `script_demo_ch1_${fresh("one", "one")}.json`), JSON.stringify({ chapter: 0, title: "one", scenes: [] }));
    await writeFile(join(cacheDir, `script_demo_ch2_${fresh("two", "two")}.json`), JSON.stringify({ chapter: 1, title: "two", scenes: [] }));
    await writeFile(join(metaDir, "cards_demo.json"), "{}");
    await writeFile(join(metaDir, "cards.json"), "{}");

    const mkStatus = (llmAvailable: boolean) =>
      useStageStatus({
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
          meta: { title: "test", gameKey: "test", chapterCount: 2, charCount: 0, sceneCount: 1, lineCount: 0, outputDir: root, webgalVersion: "test", generatedAt: "now" },
          cards,
          chapters: [chapter],
          assets: {},
          cost: { llmTokens: 0, imageCount: 0, ttsChars: 0, llmCostYuan: 0, imageCostYuan: 0, ttsCostYuan: 0 },
          failedTasks: [],
        }),
        getOptions: () => options,
        getTtsConfig: () => undefined,
        getLlmAvailable: () => llmAvailable,
      });

    // 演示模式：两章演示缓存都在 → 剧本阶段应为完成
    const demoStatus = mkStatus(false);
    await demoStatus.refresh();
    assert(demoStatus.base.script, "演示模式下，匹配的演示剧本缓存应把剧本阶段点绿");

    // 正式模式：只有演示缓存、没有正式缓存 → 不得点绿（这正是旧实现的 bug：两个前缀都认）
    const formalStatus = mkStatus(true);
    await formalStatus.refresh();
    assert(
      !formalStatus.base.script,
      "正式模式下不得用演示剧本缓存把剧本阶段点绿（看板必须与真实产物一致）",
    );

    // 反向：只有正式缓存时，演示模式可以作为兜底（有真剧本好过整章显示未完成）
    await rm(join(cacheDir, `script_demo_ch1_${fresh("one", "one")}.json`), { force: true });
    await rm(join(cacheDir, `script_demo_ch2_${fresh("two", "two")}.json`), { force: true });
    await writeFile(join(cacheDir, `script_ch1_${fresh("one", "one")}.json`), JSON.stringify({ chapter: 0, title: "one", scenes: [] }));
    await writeFile(join(cacheDir, `script_ch2_${fresh("two", "two")}.json`), JSON.stringify({ chapter: 1, title: "two", scenes: [] }));
    const demoStatus2 = mkStatus(false);
    await demoStatus2.refresh();
    assert(demoStatus2.base.script, "演示模式下正式缓存应可作为兜底，避免整章误报未完成");
    void cardsFingerprint;
    void chapters;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("=== stage status tests passed ===");
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
