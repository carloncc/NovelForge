/**
 * 单阶段重跑后的「下游自动补齐」判定：只补资产阶段（图像/配音/组装），
 * 只补缺失（缓存命中的不重跑），且任何动过剧本/资产的一轮都必须重新组装刷新预览。
 */
import type {
  ApiConfig,
  AssetMap,
  ChapterScript,
  CharacterCard,
  ExtractionResult,
  GenerationOptions,
  StageKey,
} from "../src/core/types";
import { STAGE_ORDER } from "../src/core/types";
import { buildVoiceJobs } from "../src/core/voice";
import { imageTaskHasAsset, missingAssetStages, planStageCascade, statusImageTasks } from "../src/core/stageCascade";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const options: GenerationOptions = {
  useImage: true,
  useTts: true,
  useVideoPoints: false,
  useBgm: false,
  figureEmotions: false,
  figureDetail: "core",
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

const tts: ApiConfig = {
  id: "tts-1",
  name: "语音模型",
  baseUrl: "https://example.invalid/v1",
  apiKey: "test",
  model: "speech-1",
  extra: { voiceLibrary: ["female-shaonv", "default"] },
};

const alice: CharacterCard = {
  id: "alice",
  name: "爱丽丝",
  appearance: "银发少女",
  clothing: "校服",
  personality: "开朗",
  voiceDesc: "少女音",
  voiceName: "female-shaonv",
  imagePrompt: "alice, silver hair, school uniform",
  color: "#9ca3af",
};

const cards: ExtractionResult = { title: "测试", characters: [alice], scenes: [], items: [] };

const chapters: ChapterScript[] = [
  {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "scene_1",
        location: "教室",
        atmosphere: "日常",
        time: "白天",
        bgPrompt: "classroom, daylight",
        itemEvents: [],
        figures: ["alice"],
        lines: [
          { type: "dialogue", characterId: "alice", text: "早上好。" },
          { type: "narration", text: "窗外下着雨。" },
        ],
      },
    ],
  },
];

// 夹具规模：1 张立绘（figureEmotions=false → 只有 normal）+ 1 张背景 = 2 张图；1 句对话 + 1 句旁白 = 2 句配音
const EXPECTED_IMAGES = 2;
const EXPECTED_VOICES = 2;

function completed(map: Partial<Record<StageKey, boolean>>): Record<StageKey, boolean> {
  const out = {} as Record<StageKey, boolean>;
  for (const key of STAGE_ORDER) out[key] = map[key] ?? false;
  return out;
}

const TEXT_DONE = completed({ split: true, translate: true, extract: true, script: true });
const ALL_DONE = completed({ split: true, translate: true, extract: true, script: true, image: true, voice: true, assemble: true });

/** 按产出规则造一份「素材齐全」的映射（与 imageTaskHasAsset 同口径） */
function fullAssetMap(): AssetMap {
  const map: AssetMap = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
  for (const task of statusImageTasks(chapters, cards, options)) {
    if (task.kind === "anchor") continue;
    if (task.kind === "background") map.bg[task.id] = "done";
    else if (task.kind === "cg") map.cg[task.id] = "done";
    else if (task.kind === "item") map.item[task.id] = "done";
    else map.figure[task.id] = "done";
  }
  for (const job of buildVoiceJobs(tts, chapters, cards.characters)) map.vocal[job.key] = "done";
  return map;
}

function testMissingAssetStages(): void {
  const enabled = { image: true, voice: true };

  assert(
    missingAssetStages(TEXT_DONE, enabled, "script").join(",") === "image,voice,assemble",
    "剧本重跑后应补齐 图像→配音→组装",
  );

  assert(missingAssetStages(ALL_DONE, enabled).length === 0, "全部完成且无触发阶段时不应补任何阶段");
  assert(
    missingAssetStages(ALL_DONE, enabled, "script").join(",") === "assemble",
    "剧本刚重跑过，即使各阶段灯全绿也必须重新组装刷新预览",
  );

  assert(
    !missingAssetStages(TEXT_DONE, { image: false, voice: true }, "script").includes("image"),
    "关闭图像开关时不应补图像",
  );
  assert(
    !missingAssetStages(TEXT_DONE, { image: true, voice: false }, "script").includes("voice"),
    "关闭配音开关时不应补配音",
  );

  const imageTrigger = missingAssetStages(TEXT_DONE, enabled, "image");
  assert(!imageTrigger.includes("image"), "触发阶段自身不应被级联重跑（否则白烧一次钱）");
  assert(imageTrigger.join(",") === "voice,assemble", "图像重跑后应补配音并重新组装");

  assert(
    !missingAssetStages(completed({ script: true }), enabled, "assemble").includes("assemble"),
    "组装自身触发时不应再级联组装",
  );
  assert(
    missingAssetStages(completed({ script: true, image: true, voice: true }), enabled, "assemble").length === 0,
    "组装自身触发且资产齐全时不应级联出任何阶段",
  );

  const assembleGreen = completed({ script: true, assemble: true });
  assert(
    missingAssetStages(assembleGreen, enabled, "script").join(",") === "image,voice,assemble",
    "本轮补了图像/配音时，组装即使已绿也必须重跑",
  );
  assert(
    !missingAssetStages(TEXT_DONE, { image: true, voice: true, assemble: false }, "script").includes("assemble"),
    "assemble=false 时不应补组装",
  );

  const ordered = missingAssetStages(TEXT_DONE, enabled, "script");
  assert(
    ordered.every((stage, i) => i === 0 || STAGE_ORDER.indexOf(ordered[i - 1]) < STAGE_ORDER.indexOf(stage)),
    "级联阶段必须按 STAGE_ORDER 排序",
  );
}

function testPlanStageCascade(): void {
  const enabled = { image: true, voice: true };
  const plan = planStageCascade({
    completed: TEXT_DONE,
    enabled,
    trigger: "script",
    chapters,
    cards,
    options,
    assets: undefined,
    tts,
  });
  assert(plan.stages.join(",") === "image,voice,assemble", "剧本重跑后的计划应含 图像/配音/组装");
  assert(plan.images === EXPECTED_IMAGES, `应统计出 ${EXPECTED_IMAGES} 张缺失图片，实际 ${plan.images}`);
  assert(plan.voices === EXPECTED_VOICES, `应统计出 ${EXPECTED_VOICES} 句缺失配音，实际 ${plan.voices}`);
  assert(
    plan.images === statusImageTasks(chapters, cards, options).filter((t) => !imageTaskHasAsset(t, undefined)).length,
    "图像张数必须与「缺失任务」同口径",
  );

  // 素材齐全：没有要生成的图/配音，但组装照跑
  const done = planStageCascade({
    completed: ALL_DONE,
    enabled,
    trigger: "script",
    chapters,
    cards,
    options,
    assets: fullAssetMap(),
    tts,
  });
  assert(done.stages.join(",") === "assemble", "素材齐全时只应重新组装");
  assert(done.images === 0 && done.voices === 0, "素材齐全时不应再统计费用规模");

  const noVoice = planStageCascade({
    completed: TEXT_DONE,
    enabled: { image: true, voice: false },
    trigger: "script",
    chapters,
    cards,
    options,
    assets: undefined,
    tts,
  });
  assert(noVoice.voices === 0 && !noVoice.stages.includes("voice"), "关闭配音时既不补也不统计配音");

  const noImage = planStageCascade({
    completed: TEXT_DONE,
    enabled: { image: false, voice: true },
    trigger: "script",
    chapters,
    cards,
    options,
    assets: undefined,
    tts,
  });
  assert(noImage.images === 0 && !noImage.stages.includes("image"), "关闭图像时既不补也不统计图像");

  const noTts = planStageCascade({
    completed: TEXT_DONE,
    enabled,
    trigger: "script",
    chapters,
    cards,
    options,
    assets: undefined,
  });
  assert(noTts.voices === 0, "未配置 TTS 时配音句数应为 0");
  assert(noTts.images === EXPECTED_IMAGES, "未配置 TTS 不应影响图像统计");

  const imageTrigger = planStageCascade({
    completed: TEXT_DONE,
    enabled,
    trigger: "image",
    chapters,
    cards,
    options,
    assets: undefined,
    tts,
  });
  assert(imageTrigger.images === 0, "图像是触发阶段，统计口径下不应再计图像张数");
  assert(imageTrigger.voices === EXPECTED_VOICES, "图像重跑后仍应统计缺失配音");
}

function main(): void {
  testMissingAssetStages();
  testPlanStageCascade();
  console.log("=== stage cascade tests passed ===");
}

try {
  main();
} catch (error) {
  console.error("failed:", error);
  process.exit(1);
}
