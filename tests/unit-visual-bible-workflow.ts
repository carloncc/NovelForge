import "fake-indexeddb/auto";
import { Pipeline } from "../src/core/pipeline";
import type {
  CharacterCard,
  GenerationOptions,
  NovelDoc,
  ProjectVisualBible,
  StageKey,
} from "../src/core/types";
import {
  VisualBibleApprovalRequiredError,
  assertVisualBibleReadyForImages,
} from "../src/core/visualBible";
import {
  imageRunPreparationStages,
  resumeStagesAfterVisualApproval,
  visualBibleErrorMessage,
} from "../src/core/visualBibleWorkflow";
import { ReferenceImageError } from "../src/api/providers";
import { VisionApiError } from "../src/api/openaiCompatible";
import { tauri } from "../src/utils/tauri";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-visual-bible-workflow`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";

function novel(): NovelDoc {
  return {
    sourcePath: "/app/novel.txt",
    fileName: "novel.txt",
    encoding: "UTF-8",
    fullText: "Chapter one",
    chapters: [{ index: 0, title: "One", text: "Chapter one", charCount: 11, enabled: true }],
  };
}

function character(): CharacterCard {
  return {
    id: "alice",
    name: "Alice",
    appearance: "dark hair",
    clothing: "coat",
    personality: "calm",
    voiceDesc: "quiet",
    imagePrompt: "dark-haired woman in a coat",
    threeViewPrompt: "dark-haired woman in a coat",
    color: "#222222",
  };
}

function bible(status: ProjectVisualBible["status"]): ProjectVisualBible {
  return {
    version: 1,
    status,
    styleSource: "novel_analysis",
    styleDescription: "clean ink linework, muted colors",
    styleReferencePath: "style-sample.png",
    characters: {
      alice: {
        threeViewPath: "threeview_alice.png",
        prompt: "dark-haired woman in a coat",
        approved: true,
        revision: 1,
        sourceRevision: 0,
        sheetSourceRevision: 0,
      },
    },
    inputFingerprint: "pending",
  };
}

const OPTIONS: GenerationOptions = {
  useImage: true,
  useTts: false,
  useVideoPoints: false,
  useBgm: false,
  figureEmotions: false,
  figureActions: false,
  characterPoses: false,
  imageSelfCheck: false,
  imageBudgetPerChapter: 1,
  cgPerChapter: 0,
  skipCache: false,
  maxConcurrent: 1,
  videoPointsPerChapter: 0,
  characterIntroCard: false,
  imageStyle: "",
  imageSeed: 0,
  styleAnchor: false,
  scriptStyle: "",
  language: "",
};

async function testStageSplit(): Promise<void> {
  const selected: StageKey[] = ["translate", "image", "voice", "assemble"];
  const preparation = imageRunPreparationStages(selected, false);
  assert(
    preparation.join(",") === "translate,extract,script",
    "image runs without prepared cards must complete the text stages before review",
  );
  assert(
    resumeStagesAfterVisualApproval(selected).join(",") === "image,voice,assemble",
    "approval must resume only image and downstream selected stages",
  );
  assert(
    imageRunPreparationStages(["image", "assemble"], true).length === 0,
    "an existing prepared result must not rerun text stages for an image-only rerun",
  );
}

async function testGateAndFingerprint(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => undefined);
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style-sample.png`, PNG_B64);
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/threeview_alice.png`, PNG_B64);

  let missingError: unknown;
  try {
    await assertVisualBibleReadyForImages(ROOT, null, novel(), [character()]);
  } catch (error) {
    missingError = error;
  }
  assert(
    missingError instanceof VisualBibleApprovalRequiredError,
    "a direct image call without a visual bible must fail with the approval code",
  );

  const approved = bible("approved");
  approved.inputFingerprint = "stale-fingerprint";
  let staleError: unknown;
  try {
    await assertVisualBibleReadyForImages(ROOT, approved, novel(), [character()]);
  } catch (error) {
    staleError = error;
  }
  assert(staleError instanceof VisualBibleApprovalRequiredError, "fingerprint drift must block direct image calls");
  assert(approved.status === "stale", "fingerprint drift must be persisted into visible stale state");
}

async function testPipelineGateWritesNoImages(): Promise<void> {
  const outputDir = `${ROOT}/pipeline`;
  await tauri.removePath(outputDir).catch(() => undefined);
  const cards = { title: "Gate", characters: [character()], scenes: [], items: [] };
  const pipeline = new Pipeline({
    novel: novel(),
    cards,
    materials: [],
    outputDir,
    templateDir: "/app/template",
    options: OPTIONS,
    stages: ["image"],
    log: () => undefined,
  });
  let blocked: unknown;
  try {
    await pipeline.run();
  } catch (error) {
    blocked = error;
  }
  assert(blocked instanceof VisualBibleApprovalRequiredError, "Pipeline image reruns must enforce the same approval gate");
  assert(
    !(await tauri.pathExists(`${outputDir}/.novel2vn/assets.json`)),
    "a blocked image rerun must not publish partial image assets",
  );
}

async function testActionableErrors(): Promise<void> {
  const unsupported = visualBibleErrorMessage(
    new ReferenceImageError("reference slots exhausted", "REFERENCE_UNSUPPORTED"),
    { imageModel: "text-to-image-only", visionModel: "vision-model" },
  );
  assert(unsupported.includes("text-to-image-only") && unsupported.includes("参考图数量"), "unsupported errors must name the image model and setting");

  const missing = visualBibleErrorMessage(
    new ReferenceImageError("missing /project/style.png", "REFERENCE_MISSING"),
    { imageModel: "image-model", visionModel: "vision-model" },
  );
  assert(missing.includes("missing /project/style.png") && missing.includes("重新上传"), "missing errors must retain the path and recovery action");

  const vision = visualBibleErrorMessage(
    new VisionApiError("model rejected image_url", "VISION_CAPABILITY_UNSUPPORTED"),
    { imageModel: "image-model", visionModel: "text-only-model" },
  );
  assert(vision.includes("text-only-model") && vision.includes("图片识别"), "vision errors must name the independent vision channel");
}

async function main(): Promise<void> {
  await testStageSplit();
  await testGateAndFingerprint();
  await testPipelineGateWritesNoImages();
  await testActionableErrors();
  console.log("unit-visual-bible-workflow: all tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
