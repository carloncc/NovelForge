import { generateImages, runImageTask } from "../src/core/images";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { splitChapters } from "../src/core/chapters";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { regenerateCharacterThreeView, type RegenContext } from "../src/core/regenerate";
import type { ApiConfig, CharacterCard, ImageTask, ProjectVisualBible } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-image-abort`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

// 必须选一个「支持参考图」的模型：不支持参考图时 generateImage 会在本地直接拒绝，测试就碰不到付费请求路径
const IMAGE_MODEL = "Qwen/Qwen-Image-Edit-2509";
const VISION_MODEL = "abort-probe-vision-model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function imageConfig(): ApiConfig {
  return {
    id: "image",
    name: "Image",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "test",
    model: IMAGE_MODEL,
    extra: { provider: "siliconflow", protocol: "siliconflow-image" },
  };
}

function visionConfig(): ApiConfig {
  return {
    id: "vision",
    name: "Vision",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test",
    model: VISION_MODEL,
  };
}

function imageResponse(): { status: number; bodyBase64: string; contentType: string; headers: Record<string, string> } {
  return {
    status: 200,
    bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
    contentType: "application/json",
    headers: {},
  };
}

/** 复现用户日志：视觉描述返回一段画风/外观文字，被合入提示词 */
function visionResponse(): { status: number; bodyBase64: string; contentType: string; headers: Record<string, string> } {
  return {
    status: 200,
    bodyBase64: Buffer.from(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ prompt: "blue hair, sailor uniform, cel shading" }) } }],
    })).toString("base64"),
    contentType: "application/json",
    headers: {},
  };
}

function task(overrides: Partial<ImageTask> = {}): ImageTask {
  return {
    kind: "threeview",
    id: "alice",
    characterId: "alice",
    usage: "三视图-alice",
    prompt: "alice standing",
    fileName: "threeview_alice.png",
    width: 1024,
    height: 1024,
    ...overrides,
  };
}

function character(id: string): CharacterCard {
  return {
    id,
    name: id,
    appearance: "",
    clothing: "",
    personality: "",
    voiceDesc: "",
    imagePrompt: id,
    actions: [],
    color: "#fff",
  };
}

/** 中止信号已置位：任务必须直接跳过，一个付费请求都不许发，连缓存目录都不许建。 */
async function testAbortBeforeStartIssuesNothing(): Promise<void> {
  const cacheRoot = `${ROOT}/case-before/.novel2vn/cache`;
  await tauri.removePath(`${ROOT}/case-before`).catch(() => {});
  let httpCalls = 0;
  const originalHttp = tauri.http;
  tauri.http = async () => {
    httpCalls++;
    return imageResponse();
  };
  let path: string | null = "sentinel";
  try {
    path = await runImageTask(imageConfig(), task(), cacheRoot, () => {}, {
      force: true,
      outputDir: ROOT,
      visionCfg: visionConfig(),
      isAborted: () => true,
    });
  } finally {
    tauri.http = originalHttp;
  }
  assert(path === null, "已中止时 runImageTask 必须直接返回 null，而不是继续生成");
  assert(httpCalls === 0, "已中止时不允许发起任何付费 HTTP 请求");
  assert(
    !(await tauri.pathExists(`${cacheRoot}/images`)),
    "已中止时不应创建缓存目录（中止必须是零副作用的快速返回）",
  );
}

/**
 * 用户实测场景：日志已打印「已按参考图描述增强提示词：三视图-xxx」，此刻点「停止」。
 * 视觉描述本身在途无法撤回，但之后的付费图像生成必须一个都不发。
 */
async function testAbortDuringReferenceDescribeSkipsPaidImageRequest(): Promise<void> {
  const cacheRoot = `${ROOT}/case-describe/.novel2vn/cache`;
  await tauri.removePath(`${ROOT}/case-describe`).catch(() => {});
  let aborted = false;
  const models: string[] = [];
  const messages: string[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    const payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    models.push(String(payload.model ?? ""));
    if (payload.model === VISION_MODEL) {
      // 正是在这一步用户点了「停止」
      aborted = true;
      return visionResponse();
    }
    return imageResponse();
  };
  let path: string | null = "sentinel";
  try {
    path = await runImageTask(
      imageConfig(),
      task({
        references: [{
          role: "identity",
          dataB64: Buffer.from(`identity-${Math.random()}`).toString("base64"),
          mime: "image/png",
        }],
      }),
      cacheRoot,
      (event) => messages.push(event.message),
      { force: true, outputDir: ROOT, visionCfg: visionConfig(), isAborted: () => aborted },
    );
  } finally {
    tauri.http = originalHttp;
  }
  assert(models.filter((m) => m === VISION_MODEL).length === 1, "在途的参考图描述请求会跑完（无法撤回）");
  assert(models.filter((m) => m === IMAGE_MODEL).length === 0, "参考图描述在途中止后，不允许再发起付费的图像生成请求");
  assert(path === null, "中止后该任务不产出结果");
  assert(messages.some((m) => m.includes("已按参考图描述增强提示词")), "应复现用户日志里的参考图增强步骤");
}

/** 在途付费请求已经发出：结果必须保留落盘，不能既花了钱又丢图。 */
async function testInFlightPaidResultIsKept(): Promise<void> {
  const cacheRoot = `${ROOT}/case-inflight/.novel2vn/cache`;
  await tauri.removePath(`${ROOT}/case-inflight`).catch(() => {});
  let aborted = false;
  let imageRequests = 0;
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    const payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    if (payload.model === IMAGE_MODEL) {
      imageRequests++;
      // 请求已在途，此刻用户点了「停止」
      aborted = true;
    }
    return imageResponse();
  };
  let path: string | null = null;
  try {
    path = await runImageTask(
      imageConfig(),
      task({ kind: "background", id: "s1", characterId: undefined, fileName: "bg_s1.png", usage: "背景-s1" }),
      cacheRoot,
      () => {},
      { force: true, outputDir: ROOT, isAborted: () => aborted },
    );
  } finally {
    tauri.http = originalHttp;
  }
  assert(imageRequests === 1, "在途请求无法撤回，只会跑完这一次");
  assert(!!path && (await tauri.pathExists(path)), "已付费的在途结果必须保留落盘，不能既花钱又丢图");
}

/**
 * 素材页「重新生成三视图」走的正是这一条路（regenerate.ts）。
 * 角色级联原本有 7 次请求；中止发生在第 1 次在途时，后续 6 次必须全部不再发出。
 */
async function testRegenerateCascadeStopsAfterAbort(): Promise<void> {
  const caseRoot = `${ROOT}/case-cascade`;
  await tauri.removePath(caseRoot).catch(() => {});
  const sourceB64 = Buffer.from("cascade-identity").toString("base64");
  await tauri.writeFileBase64(`${caseRoot}/.novel2vn/visual-bible/alice-source.png`, sourceB64);
  await tauri.writeFileBase64(`${caseRoot}/.novel2vn/visual-bible/alice-threeview.png`, Buffer.from("old").toString("base64"));
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    characters: {
      alice: { sourceReferencePath: "alice-source.png", threeViewPath: "alice-threeview.png", prompt: "alice", approved: true, revision: 1 },
    },
    inputFingerprint: "cascade-v1",
  };
  let aborted = false;
  const models: string[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    const payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    models.push(String(payload.model ?? ""));
    // 第一张图刚生成完，用户就点了「停止」
    aborted = true;
    return imageResponse();
  };
  const progress: number[] = [];
  const ctx = {
    cfg: imageConfig(),
    chapters: [],
    cards: { title: "", characters: [character("alice")], scenes: [], items: [] },
    materials: [],
    outputDir: caseRoot,
    log: () => {},
    figureEmotions: true,
    threeView: false,
    actions: false,
    visualBible: bible,
  } satisfies RegenContext;
  try {
    await regenerateCharacterThreeView(
      ctx,
      "alice",
      undefined,
      { aborted: () => aborted },
      (done) => progress.push(done),
    );
  } finally {
    tauri.http = originalHttp;
  }
  assert(models.length === 1, `中止后必须只保留在途的那 1 次请求，实际发出 ${models.length} 次`);
  assert(models[0] === IMAGE_MODEL, "唯一发出的请求应当是在途的图像生成请求");
  assert(progress.every((done) => done <= 1), "被中止跳过的任务不应计入进度（避免停止后进度条继续涨）");
}

/**
 * 整书生成（pipeline）这条路：第一张图刚发出就点「停止」，之后整批都不许再派发新任务。
 */
async function testGenerateImagesBatchStopsAfterAbort(): Promise<void> {
  const caseRoot = `${ROOT}/case-batch`;
  await tauri.removePath(caseRoot).catch(() => {});
  const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
  const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
  const scripts = demoScriptAll(chapters, cards);
  assert(scripts.length >= 2, "示例小说应切出至少 2 章，否则本用例失去意义");
  let aborted = false;
  let imageRequests = 0;
  const messages: string[] = [];
  const originalHttp = tauri.http;
  tauri.http = async () => {
    imageRequests++;
    // 第一张刚发出去，用户就点了「停止」
    aborted = true;
    return imageResponse();
  };
  try {
    await generateImages(
      imageConfig(),
      scripts,
      cards,
      [],
      `${caseRoot}/.novel2vn/cache`,
      (event) => messages.push(event.message),
      1,
      false,
      undefined,
      undefined,
      true,
      true,
      true,
      undefined,
      undefined,
      true,
      () => aborted,
    );
  } finally {
    tauri.http = originalHttp;
  }
  assert(imageRequests === 1, `中止后必须立即停止派发新任务：实际发出 ${imageRequests} 次付费请求`);
  assert(messages.some((m) => m.includes("已中止")), "应明确告知用户后续图片任务不再继续，已生成的保留");
}

async function main(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await testAbortBeforeStartIssuesNothing();
  await testAbortDuringReferenceDescribeSkipsPaidImageRequest();
  await testInFlightPaidResultIsKept();
  await testRegenerateCascadeStopsAfterAbort();
  await testGenerateImagesBatchStopsAfterAbort();
  await tauri.removePath(ROOT).catch(() => {});
  console.log("=== image abort tests passed ===");
}

main().catch((error) => {
  console.error("image abort tests failed:", error);
  process.exit(1);
});
