/**
 * nb-nD 1443（草稿中止窗口）回归单测：
 * - 风格分析阶段中止信号透传：isAborted=true 时不调 LLM 直接抛「已中止」
 * - 最后一个角色窗口：三视图生成期间点中止 → 整单不落盘（此前完整发布却报「未保存任何内容」）
 */
import { analyzeNovelStyle, createVisualBibleDraft, visualBibleManifestPath } from "../src/core/visualBible";
import type { NovelDoc } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-nb-nd-abort`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function novel(): NovelDoc {
  const text = "Chapter one\nA rainy neon city withлектрички.";
  return {
    fileName: "novel.txt",
    sourcePath: `${ROOT}/novel.txt`,
    encoding: "utf-8",
    fullText: text,
    chapters: [{ index: 0, title: "One", text, charCount: text.length, enabled: true }],
  };
}

function cards() {
  return {
    title: "t",
    characters: [
      {
        id: "alice",
        name: "alice",
        appearance: "silver hair",
        clothing: "black coat",
        personality: "calm",
        voiceDesc: "soft",
        imagePrompt: "alice, silver hair, black coat",
        threeViewPrompt: "alice character turnaround",
        color: "#fff",
      },
    ],
    scenes: [],
    items: [],
  };
}

const imageCfg = { id: "image", name: "image", baseUrl: "https://example.invalid/v1", apiKey: "test", model: "image" };
const llmCfg = { id: "llm", name: "llm", baseUrl: "https://example.invalid/v1", apiKey: "test", model: "llm" };

async function testStyleAbortShortCircuits(): Promise<void> {
  let calls = 0;
  let aborted = false;
  try {
    await analyzeNovelStyle(llmCfg, novel(), {
      chatText: async () => {
        calls++;
        return "style";
      },
      chatVision: async () => "style",
      generateImage: async () => ({ dataB64: PNG_B64, mime: "image/png" }),
    }, 2, undefined, () => true);
  } catch (e) {
    aborted = e instanceof Error && e.message.includes("已中止");
  }
  assert(aborted, "风格分析阶段中止应抛「已中止」");
  assert(calls === 0, "中止后不应再发起 LLM 调用");
}

async function testLastCharacterWindowAbortsPublish(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(ROOT);
  let abort = false;
  try {
    await createVisualBibleDraft(
      {
        outputDir: ROOT,
        novel: novel(),
        cards: cards() as never,
        imageCfg,
        styleSource: "novel_analysis",
        llmCfg,
        // 最后一个角色的三视图生成期间点「中止」：prompt 含 turnaround 即角色图，
        // 此时置位；新补的落盘前检查应拦截发布。
        isAborted: () => abort,
      },
      {
        chatText: async () => "cinematic anime style",
        chatVision: async () => "style",
        generateImage: async (_cfg, prompt) => {
          if (prompt.includes("turnaround sheet")) abort = true;
          return { dataB64: PNG_B64, mime: "image/png" };
        },
      },
    );
    assert(false, "最后一个角色窗口中止后应抛「已中止」，不能静默发布");
  } catch (e) {
    assert(e instanceof Error && e.message.includes("已中止"), `应抛「已中止」，实际：${String(e).slice(0, 120)}`);
  }
  assert(!(await tauri.pathExists(visualBibleManifestPath(ROOT))), "中止后草稿不得落盘（与面板「未保存任何内容」一致，不留静默双份）");
  await tauri.removePath(ROOT).catch(() => {});
}

async function main(): Promise<void> {
  await testStyleAbortShortCircuits();
  await testLastCharacterWindowAbortsPublish();
  console.log("=== nb-nD abort (1443) unit tests passed ===");
}

main().catch((error) => {
  console.error("nb-nD abort unit tests failed:", error);
  process.exit(1);
});
