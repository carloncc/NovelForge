import { generateImage, ReferenceImageError } from "../src/api/openaiCompatible";
import { resolveImageModelCapabilities, routeImageReferences } from "../src/api/providers";
import { buildImageTasks, generateImages, resolveImageTaskReferences, runImageTask } from "../src/core/images";
import {
  imageTaskMatchesSelectionKey,
  regenerateCharacterFigures,
  regenerateCharacterThreeView,
  regenerateImages,
  selectCharacterThreeViewRegenerationTasks,
  type RegenContext,
} from "../src/core/regenerate";
import { verifyImage } from "../src/core/selfcheck";
import type { ApiConfig, CharacterCard, ImageReference, ImageTask, MaterialAsset, ProjectVisualBible } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-image-references`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function qwenConfig(): ApiConfig {
  return {
    id: "qwen",
    name: "Qwen Image Edit",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "test",
    model: "Qwen/Qwen-Image-Edit-2509",
    extra: { provider: "siliconflow", protocol: "siliconflow-image" },
  };
}

function reference(role: ImageReference["role"], dataB64: string, mime = "image/png"): ImageReference {
  return { role, dataB64, mime };
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
    actions: [{ id: "wave", name: "Wave", prompt: `${id} wave` }],
    color: "#fff",
  };
}

async function testQwenUsesThreeOrderedDataUrls(): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requests.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>);
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await generateImage(qwenConfig(), "character", {
      references: [
        reference("identity", "aWRlbnRpdHk="),
        reference("style", "data:image/jpeg;base64,c3R5bGU=", "image/jpeg"),
        reference("structure", "c3RydWN0dXJl", "image/webp"),
      ],
      size: "1024x1024",
      seed: 7,
    });
  } finally {
    tauri.http = originalHttp;
  }
  assert(requests.length === 1, "Qwen generation should issue one request");
  assert(requests[0].image === "data:image/png;base64,aWRlbnRpdHk=", "identity should be the first Qwen image");
  assert(requests[0].image2 === "data:image/jpeg;base64,c3R5bGU=", "style should be the second Qwen image without double-prefixing");
  assert(requests[0].image3 === "data:image/webp;base64,c3RydWN0dXJl", "structure should be the third Qwen image");
  assert(requests[0].seed === 7, "known Qwen capabilities should retain a deterministic seed");
}

async function testCustomAdapterReceivesRawBase64(): Promise<void> {
  const cfg: ApiConfig = {
    id: "local",
    name: "Local IP Adapter",
    baseUrl: "http://127.0.0.1:8100",
    apiKey: "local",
    model: "sdxl",
    extra: {
      imageCapabilities: {
        maxReferenceImages: 1,
        supportsSeed: true,
        supportsImageEdit: true,
        referenceEncoding: "raw-base64",
      },
      customTemplate: JSON.stringify({
        id: "local-image",
        name: "Local image",
        capability: "image",
        mode: "sync",
        endpoint: "/v1/images/generations",
        requestMap: { model: "$model", prompt: "$prompt", image: "$refImageRaw", seed: "$seed" },
        response: { path: "data", encoding: "base64", mime: "image/png" },
      }),
    },
  };
  let body: Record<string, unknown> = {};
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await generateImage(cfg, "character", { references: [reference("identity", "cmF3LWltYWdl")] });
  } finally {
    tauri.http = originalHttp;
  }
  assert(body.image === "cmF3LWltYWdl", "custom raw-base64 adapters should receive an unprefixed reference");
}

function testCapabilitiesDedupAndLimits(): void {
  const qwen = resolveImageModelCapabilities(qwenConfig());
  assert(qwen.maxReferenceImages === 3 && qwen.supportsImageEdit && qwen.referenceEncoding === "data-url", "Qwen should use the known three-reference capability table");

  const oneRefCfg: ApiConfig = {
    ...qwenConfig(),
    model: "custom-one-ref",
    extra: { imageCapabilities: { maxReferenceImages: 1, supportsSeed: false, supportsImageEdit: true, referenceEncoding: "raw-base64" } },
  };
  const shared = reference("identity", "c2FtZQ==");
  const deduped = routeImageReferences(oneRefCfg, [shared, { ...shared, role: "style" }]);
  assert(deduped.length === 1, "identical reference content should be deduplicated before applying model limits");

  let unsupported: unknown;
  try {
    routeImageReferences(oneRefCfg, [reference("identity", "aQ=="), reference("style", "cw==")]);
  } catch (error) {
    unsupported = error;
  }
  assert(unsupported instanceof ReferenceImageError && unsupported.code === "REFERENCE_UNSUPPORTED", "discarding a required reference should throw REFERENCE_UNSUPPORTED");

  const optionalStructure = routeImageReferences(oneRefCfg, [reference("identity", "aQ=="), reference("structure", "cA==")]);
  assert(optionalStructure.length === 1 && optionalStructure[0].role === "identity", "optional structure references may be discarded after required roles are preserved");

  const noRefCfg = { ...oneRefCfg, model: "unknown-no-ref", extra: {} };
  const noOptionalReferences = routeImageReferences(noRefCfg, [
    { ...reference("structure", "bGF5b3V0"), required: false },
  ]);
  assert(noOptionalReferences.length === 0, "models without image edit may discard references explicitly marked optional");

  let mergedRequired: unknown;
  try {
    routeImageReferences(noRefCfg, [
      { ...reference("identity", "c2FtZS1pbWFnZQ=="), sourcePath: "shared.png", required: false },
      { ...reference("style", "c2FtZS1pbWFnZQ=="), sourcePath: "shared.png", required: true },
    ]);
  } catch (error) {
    mergedRequired = error;
  }
  assert(
    mergedRequired instanceof ReferenceImageError && mergedRequired.code === "REFERENCE_UNSUPPORTED",
    "deduplication across roles must OR-merge required metadata before zero-reference capability checks",
  );

  const requiredIdentity = { ...reference("identity", "aWRlbnRpdHk="), required: true };
  const optionalStyle = { ...reference("style", "c3R5bGU="), required: false };
  const identityOnly = routeImageReferences(oneRefCfg, [optionalStyle, requiredIdentity]);
  assert(
    identityOnly.length === 1 && identityOnly[0].role === "identity",
    "one-reference models should keep required identity and discard optional character style",
  );

  let droppedRequired: unknown;
  try {
    routeImageReferences(oneRefCfg, [
      { ...reference("identity", "b3B0aW9uYWw="), required: false },
      { ...reference("identity", "cmVxdWlyZWQ="), required: true },
    ]);
  } catch (error) {
    droppedRequired = error;
  }
  assert(
    droppedRequired instanceof ReferenceImageError && droppedRequired.code === "REFERENCE_UNSUPPORTED",
    "reference limits must reject any ordering that would discard a required reference",
  );

  let contradictory: unknown;
  try {
    resolveImageModelCapabilities({
      ...oneRefCfg,
      extra: { imageCapabilities: { maxReferenceImages: 1, supportsSeed: false, supportsImageEdit: false, referenceEncoding: "raw-base64" } },
    });
  } catch (error) {
    contradictory = error;
  }
  assert(contradictory instanceof ReferenceImageError && contradictory.code === "REFERENCE_UNSUPPORTED", "contradictory custom capability settings should be rejected");
}

async function testMissingReferencesAndNoFallback(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "missing-style.png",
    characters: {
      alice: { threeViewPath: "missing-alice.png", prompt: "alice", approved: true, revision: 1 },
    },
    inputFingerprint: "v1",
  };
  const task: ImageTask = {
    kind: "figure",
    id: "alice",
    characterId: "alice",
    prompt: "alice",
    refFromTask: "alice_threeview",
    fileName: "figure_alice_normal.png",
    width: 1024,
    height: 1024,
  };
  let missing: unknown;
  try {
    await resolveImageTaskReferences(task, { outputDir: ROOT, visualBible: bible, figureBase: {} });
  } catch (error) {
    missing = error;
  }
  assert(missing instanceof ReferenceImageError && missing.code === "REFERENCE_MISSING", "declared missing paths should throw REFERENCE_MISSING");

  const requests: Record<string, unknown>[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requests.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>);
    return {
      status: 400,
      bodyBase64: Buffer.from(JSON.stringify({ error: { message: "bad reference" } })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    let failed = false;
    try {
      await generateImage(qwenConfig(), "character", { references: [reference("identity", "aWRlbnRpdHk=")] });
    } catch {
      failed = true;
    }
    assert(failed, "provider reference failures should propagate");
  } finally {
    tauri.http = originalHttp;
  }
  assert(requests.length === 1 && typeof requests[0].image === "string", "a failed required-reference request must never retry as text-to-image");
}

async function testLocalReferenceCapabilityErrorIsTypedAndNotRetried(): Promise<void> {
  const cfg: ApiConfig = {
    id: "local",
    name: "Local IP Adapter",
    baseUrl: "http://127.0.0.1:8100",
    apiKey: "local",
    model: "sdxl",
    extra: {
      imageCapabilities: {
        maxReferenceImages: 1,
        supportsSeed: true,
        supportsImageEdit: true,
        referenceEncoding: "raw-base64",
      },
      customTemplate: JSON.stringify({
        id: "local-image",
        name: "Local image",
        capability: "image",
        mode: "sync",
        endpoint: "/v1/images/generations",
        requestMap: { model: "$model", prompt: "$prompt", image: "$refImageRaw" },
        response: { path: "data", encoding: "base64", mime: "image/png" },
      }),
    },
  };
  let requestCount = 0;
  let capabilityError: unknown;
  const originalHttp = tauri.http;
  tauri.http = async () => {
    requestCount++;
    return {
      status: 503,
      bodyBase64: Buffer.from(JSON.stringify({ error: { message: "REFERENCE_UNSUPPORTED: IP-Adapter is not ready" } })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await generateImage(cfg, "character", { references: [reference("identity", "aWRlbnRpdHk=")] });
  } catch (error) {
    capabilityError = error;
  } finally {
    tauri.http = originalHttp;
  }
  assert(
    capabilityError instanceof ReferenceImageError && capabilityError.code === "REFERENCE_UNSUPPORTED",
    "local reference capability failures should preserve the actionable typed error",
  );
  assert(requestCount === 1, "typed local reference capability failures must not be retried");
}

async function testSelfCheckSendsEveryReferenceInRoleOrder(): Promise<void> {
  let requestBody: Record<string, any> = {};
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requestBody = JSON.parse(request.body ?? "{}") as Record<string, any>;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ choices: [{ message: { content: "符合：一致" } }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await verifyImage(qwenConfig(), "Z2VuZXJhdGVk", "character", {
      references: [
        reference("style", "c3R5bGU=", "image/jpeg"),
        reference("structure", "c3RydWN0dXJl", "image/webp"),
        reference("identity", "aWRlbnRpdHk=", "image/png"),
      ],
    });
  } finally {
    tauri.http = originalHttp;
  }
  const content = requestBody.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
  const imageUrls = content.filter((part) => part.type === "image_url").map((part) => part.image_url?.url);
  assert(imageUrls.length === 4, "self-check should send the generated image plus every supplied reference");
  assert(imageUrls[1] === "data:image/png;base64,aWRlbnRpdHk=", "self-check identity reference should be first");
  assert(imageUrls[2] === "data:image/jpeg;base64,c3R5bGU=", "self-check style reference should preserve MIME and order");
  assert(imageUrls[3] === "data:image/webp;base64,c3RydWN0dXJl", "self-check structure reference should be last");
  const prompt = content.find((part) => part.type === "text") as { text?: string } | undefined;
  assert(prompt?.text?.includes("REFERENCE IMAGE 1 ROLE: IDENTITY"), "self-check must label the identity reference role");
  assert(prompt?.text?.includes("REFERENCE IMAGE 2 ROLE: STYLE"), "self-check must label the style reference role");
  assert(prompt?.text?.includes("REFERENCE IMAGE 3 ROLE: STRUCTURE"), "self-check must label the structure reference role");
  assert(prompt?.text?.includes("Do not judge identity from STYLE or STRUCTURE"), "self-check must not treat style/structure images as identity evidence");
}

async function testApprovedIdentityIsUsedWhenPoseGenerationIsDisabled(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const threeViewB64 = Buffer.from("approved-three-view").toString("base64");
  const styleB64 = Buffer.from("approved-style").toString("base64");
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice-threeview.png`, threeViewB64);
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, styleB64);
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {
      alice: { threeViewPath: "alice-threeview.png", prompt: "alice", approved: true, revision: 1 },
    },
    inputFingerprint: "identity-v1",
  };
  const tasks = buildImageTasks([], {
    title: "Book",
    characters: [character("alice")],
    scenes: [],
    items: [],
  }, { threeView: false, actions: false, figureEmotions: false, styleAnchor: false });
  assert(!tasks.some((task) => task.kind === "threeview"), "pose option should still disable new three-view tasks");
  const figure = tasks.find((task) => task.kind === "figure")!;
  let requestBody: Record<string, unknown> = {};
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requestBody = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await runImageTask(qwenConfig(), figure, `${ROOT}/.novel2vn/cache`, () => {}, {
      visualBible: bible,
      outputDir: ROOT,
      force: true,
    });
  } finally {
    tauri.http = originalHttp;
  }
  assert(requestBody.image === `data:image/png;base64,${threeViewB64}`, "approved three-view identity must be used by batch figures even when poses are disabled");
}

async function testZeroReferenceModelRejectsApprovedIdentityBeforeRequest(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice-threeview.png`, Buffer.from("approved-three-view").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, Buffer.from("approved-style").toString("base64"));
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {
      alice: { threeViewPath: "alice-threeview.png", prompt: "alice", approved: true, revision: 1 },
    },
    inputFingerprint: "identity-v1",
  };
  const figure = buildImageTasks([], {
    title: "Book",
    characters: [character("alice")],
    scenes: [],
    items: [],
  }, { threeView: false, actions: false, figureEmotions: false, styleAnchor: false })[0];
  let unsupported: unknown;
  let unknownModelRequests = 0;
  const originalHttp = tauri.http;
  tauri.http = async () => {
    unknownModelRequests++;
    throw new Error("unknown models must fail before HTTP");
  };
  try {
    await runImageTask({ ...qwenConfig(), model: "unknown-zero-reference-model", extra: {} }, figure, `${ROOT}/.novel2vn/cache`, () => {}, {
      visualBible: bible,
      outputDir: ROOT,
      force: true,
    });
  } catch (error) {
    unsupported = error;
  } finally {
    tauri.http = originalHttp;
  }
  assert(unsupported instanceof ReferenceImageError && unsupported.code === "REFERENCE_UNSUPPORTED", "zero-reference models must reject required approved identity");
  assert(unknownModelRequests === 0, "zero-reference models must fail before issuing a generation request");
}

function testSelectionCascadeUsesExactTaskOwnership(): void {
  const aliceFigure: ImageTask = {
    kind: "figure", id: "alice_happy", characterId: "alice", prompt: "", fileName: "alice.png", width: 1, height: 1, usage: "alice",
  };
  const prefixCharacterFigure: ImageTask = {
    kind: "figure", id: "alice_alt", characterId: "alice_alt", prompt: "", fileName: "alice-alt.png", width: 1, height: 1, usage: "alice alt",
  };
  const exactThreeView: ImageTask = {
    kind: "threeview", id: "alice_threeview", characterId: "alice", prompt: "", fileName: "alice-threeview.png", width: 1, height: 1, usage: "alice three-view",
  };
  assert(imageTaskMatchesSelectionKey(aliceFigure, "threeview:alice"), "three-view selection should include target-owned figures");
  assert(imageTaskMatchesSelectionKey(exactThreeView, "threeview:alice"), "three-view selection should include only the exact target sheet");
  assert(!imageTaskMatchesSelectionKey(prefixCharacterFigure, "threeview:alice"), "three-view selection must not include prefix-related character IDs");
}

async function testSingleRegenerationLoadsDependenciesFromAllTasks(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const defaultFigureB64 = Buffer.from("legacy-default-figure").toString("base64");
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/cache/images/figure_alice_normal.png`, defaultFigureB64);
  let requestBody: Record<string, unknown> = {};
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requestBody = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    const results = await regenerateImages({
      cfg: qwenConfig(),
      chapters: [],
      cards: { title: "Book", characters: [character("alice")], scenes: [], items: [] },
      materials: [],
      outputDir: ROOT,
      log: () => {},
      figureEmotions: true,
      threeView: true,
      actions: false,
    }, (task) => task.kind === "figure" && task.id === "alice_happy");
    assert(results.length === 1, "single emotion regeneration should complete in a legacy project");
  } finally {
    tauri.http = originalHttp;
  }
  assert(requestBody.image === `data:image/png;base64,${defaultFigureB64}`, "filtered regeneration must load the existing default figure dependency from the complete task graph");
}

async function testCharacterFigureRegenerationUsesExactOwnership(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, Buffer.from("style").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice.png`, Buffer.from("alice").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice-alt.png`, Buffer.from("alice-alt").toString("base64"));
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {
      alice: { threeViewPath: "alice.png", prompt: "alice", approved: true, revision: 1 },
      alice_alt: { threeViewPath: "alice-alt.png", prompt: "alice alt", approved: true, revision: 1 },
    },
    inputFingerprint: "exact-owner-v1",
  };
  const originalHttp = tauri.http;
  tauri.http = async () => ({
    status: 200,
    bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
    contentType: "application/json",
    headers: {},
  });
  let results;
  try {
    results = await regenerateCharacterFigures({
      cfg: qwenConfig(),
      chapters: [],
      cards: { title: "Book", characters: [character("alice"), character("alice_alt")], scenes: [], items: [] },
      materials: [],
      outputDir: ROOT,
      log: () => {},
      figureEmotions: false,
      threeView: false,
      actions: false,
      visualBible: bible,
    }, "alice");
  } finally {
    tauri.http = originalHttp;
  }
  assert(results.length === 1 && results[0].task.characterId === "alice", "public figure regeneration must not include prefix-related character IDs");
}

async function testCacheBindingForcesOnlyChangedCharacter(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const cacheRoot = `${ROOT}/.novel2vn/cache`;
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, Buffer.from("style").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice.png`, Buffer.from("alice-id").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/bob.png`, Buffer.from("bob-id").toString("base64"));
  await tauri.writeFileBase64(`${cacheRoot}/images/figure_alice_normal.png`, Buffer.from("old-alice").toString("base64"));
  await tauri.writeFileBase64(`${cacheRoot}/images/figure_bob_normal.png`, Buffer.from("old-bob").toString("base64"));
  await tauri.writeFileBase64(`${cacheRoot}/images/item_relic.png`, Buffer.from("old-item").toString("base64"));
  await tauri.writeTextFile(`${cacheRoot}/images/.visual-bible-fingerprint`, JSON.stringify({
    globalFingerprint: "global-v1",
    characterRevisions: { alice: 1, bob: 1 },
  }));
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {
      alice: { threeViewPath: "alice.png", prompt: "alice", approved: true, revision: 2 },
      bob: { threeViewPath: "bob.png", prompt: "bob", approved: true, revision: 1 },
    },
    inputFingerprint: "project-v2",
    cacheBinding: { globalFingerprint: "global-v1", characterRevisions: { alice: 2, bob: 1 } },
  };
  let requestCount = 0;
  const originalHttp = tauri.http;
  tauri.http = async () => {
    requestCount++;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await generateImages(qwenConfig(), [], {
      title: "Book",
      characters: [character("alice"), character("bob")],
      scenes: [],
      items: [{ id: "relic", name: "Relic", description: "", imagePrompt: "relic", importance: "major" }],
    }, [], cacheRoot, () => {}, 1, false, undefined, undefined, false, false, false, undefined, undefined, true, undefined, bible);
  } finally {
    tauri.http = originalHttp;
  }
  assert(requestCount === 1, "character-only cache binding changes must preserve other characters and item caches");
}

async function testIncompleteManifestCacheBindingForcesMissingCharacter(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const cacheRoot = `${ROOT}/.novel2vn/cache`;
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, Buffer.from("style").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice.png`, Buffer.from("alice-id").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/bob.png`, Buffer.from("bob-id").toString("base64"));
  await tauri.writeFileBase64(`${cacheRoot}/images/figure_alice_normal.png`, Buffer.from("old-alice").toString("base64"));
  await tauri.writeFileBase64(`${cacheRoot}/images/figure_bob_normal.png`, Buffer.from("old-bob").toString("base64"));
  await tauri.writeTextFile(`${cacheRoot}/images/.visual-bible-fingerprint`, JSON.stringify({
    globalFingerprint: "global-v1",
    characterRevisions: { alice: 1 },
  }));
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {
      alice: { threeViewPath: "alice.png", prompt: "alice", approved: true, revision: 1 },
      bob: { threeViewPath: "bob.png", prompt: "bob", approved: true, revision: 1 },
    },
    inputFingerprint: "global-v1",
    cacheBinding: { globalFingerprint: "global-v1", characterRevisions: { alice: 1 } },
  };
  let requestCount = 0;
  const originalHttp = tauri.http;
  tauri.http = async () => {
    requestCount++;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await generateImages(qwenConfig(), [], {
      title: "Book", characters: [character("alice"), character("bob")], scenes: [], items: [],
    }, [], cacheRoot, () => {}, 1, false, undefined, undefined, false, false, false, undefined, undefined, true, undefined, bible);
  } finally {
    tauri.http = originalHttp;
  }
  assert(requestCount === 1, "a missing manifest cache revision must force exactly that character instead of treating undefined as current");
}

async function itemReferenceFixture(): Promise<{
  bible: ProjectVisualBible;
  task: ImageTask;
  material: MaterialAsset;
}> {
  await tauri.removePath(ROOT).catch(() => {});
  const stylePath = `${ROOT}/.novel2vn/visual-bible/style.png`;
  const materialPath = `${ROOT}/materials/relic.png`;
  await tauri.writeFileBase64(stylePath, "c3R5bGU=");
  await tauri.writeFileBase64(materialPath, "bWF0ZXJpYWw=");
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {},
    inputFingerprint: "item-bible-v1",
  };
  const task: ImageTask = {
    kind: "item",
    id: "relic",
    prompt: "ancient relic",
    fileName: "item_relic.png",
    width: 1024,
    height: 1024,
    usage: "item relic",
  };
  const material: MaterialAsset = { name: "relic", path: materialPath, kind: "item", mime: "image/png", extra: { mapTo: "relic" } };
  return { bible, task, material };
}

async function testApprovedItemMaterialBecomesIdentityReference(): Promise<void> {
  const { bible, task, material } = await itemReferenceFixture();
  const requests: Record<string, unknown>[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requests.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>);
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await runImageTask(qwenConfig(), task, `${ROOT}/.novel2vn/cache`, () => {}, {
      materials: [material],
      visualBible: bible,
      outputDir: ROOT,
      force: true,
    });
  } finally {
    tauri.http = originalHttp;
  }
  assert(requests.length === 1, "approved item material should enter the AI reference workflow");
  assert(requests[0].image === "data:image/png;base64,bWF0ZXJpYWw=", "item material should be the first identity reference");
  assert(requests[0].image2 === "data:image/png;base64,c3R5bGU=", "approved global style should follow item identity");
}

async function testSingleReferenceItemUsesIdentityAndApprovedStyleText(): Promise<void> {
  const { bible, task, material } = await itemReferenceFixture();
  const config: ApiConfig = {
    ...qwenConfig(),
    model: "custom-single-reference",
    extra: {
      provider: "siliconflow",
      protocol: "siliconflow-image",
      imageCapabilities: {
        maxReferenceImages: 1,
        supportsSeed: false,
        supportsImageEdit: true,
        referenceEncoding: "data-url",
      },
    },
  };
  let requestBody: Record<string, unknown> = {};
  const messages: string[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requestBody = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await runImageTask(config, task, `${ROOT}/.novel2vn/cache`, (event) => messages.push(event.message), {
      materials: [material],
      visualBible: bible,
      outputDir: ROOT,
      force: true,
    });
  } finally {
    tauri.http = originalHttp;
  }
  assert(requestBody.image === "data:image/png;base64,bWF0ZXJpYWw=", "single-reference item generation must prioritize identity");
  assert(!requestBody.image2, "single-reference item generation should constrain style through approved prompt text");
  assert(messages.some((message) => message.includes("模型仅支持单参考图")), "single-reference identity-plus-style-text mode must be explicitly logged");
}

async function testMissingApprovedItemMaterialStopsBeforeGeneration(): Promise<void> {
  const { bible, task, material } = await itemReferenceFixture();
  const missingMaterial = { ...material, path: `${ROOT}/materials/missing.png` };
  let missing: unknown;
  const originalMissingHttp = tauri.http;
  let missingRequestCount = 0;
  tauri.http = async () => {
    missingRequestCount++;
    throw new Error("image API must not be called");
  };
  try {
    await runImageTask(qwenConfig(), { ...task, id: "missing", fileName: "item_missing.png" }, `${ROOT}/.novel2vn/cache`, () => {}, {
      materials: [{ ...missingMaterial, extra: { mapTo: "missing" } }],
      visualBible: bible,
      outputDir: ROOT,
      force: true,
    });
  } catch (error) {
    missing = error;
  } finally {
    tauri.http = originalMissingHttp;
  }
  assert(missing instanceof ReferenceImageError && missing.code === "REFERENCE_MISSING", "missing declared item materials should be typed REFERENCE_MISSING");
  assert(missingRequestCount === 0, "missing item materials must stop before image generation");
}

async function testMaterialCopyFailureDoesNotFallThroughToGeneration(): Promise<void> {
  const { task, material } = await itemReferenceFixture();
  const missingMaterial = { ...material, path: `${ROOT}/materials/missing.png` };
  let copyFallback: unknown;
  const originalCopyFallbackHttp = tauri.http;
  let copyFallbackRequests = 0;
  tauri.http = async () => {
    copyFallbackRequests++;
    throw new Error("copy failure must not fall through to text-to-image");
  };
  try {
    await runImageTask(qwenConfig(), { ...task, id: "legacy-missing", fileName: "item_legacy_missing.png" }, `${ROOT}/.novel2vn/cache`, () => {}, {
      materials: [{ ...missingMaterial, extra: { mapTo: "legacy-missing" } }],
      outputDir: ROOT,
      force: true,
    });
  } catch (error) {
    copyFallback = error;
  } finally {
    tauri.http = originalCopyFallbackHttp;
  }
  assert(copyFallback instanceof ReferenceImageError && copyFallback.code === "REFERENCE_MISSING", "material copy failures should remain typed missing-reference errors");
  assert(copyFallbackRequests === 0, "material copy failures must not silently fall through to text-to-image");
}

async function testApprovedBibleFingerprintPreventsOldCacheBypass(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const cacheRoot = `${ROOT}/.novel2vn/cache`;
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, "c3R5bGU=");
  await tauri.writeFileBase64(`${cacheRoot}/images/item_relic.png`, "b2xkLWNhY2hl");
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {},
    inputFingerprint: "cache-bible-v1",
  };
  const cards = {
    title: "Book",
    characters: [],
    scenes: [],
    items: [{ id: "relic", name: "Relic", description: "", imagePrompt: "ancient relic", importance: "major" as const }],
  };
  let requestCount = 0;
  const originalHttp = tauri.http;
  tauri.http = async () => {
    requestCount++;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await generateImages(qwenConfig(), [], cards, [], cacheRoot, () => {}, 1, false, undefined, undefined, false, false, false, undefined, undefined, true, undefined, bible);
    assert(requestCount === 1, "an unbound pre-bible cache must not bypass approved style references");
    await generateImages(qwenConfig(), [], cards, [], cacheRoot, () => {}, 1, false, undefined, undefined, false, false, false, undefined, undefined, true, undefined, bible);
  } finally {
    tauri.http = originalHttp;
  }
  assert(requestCount === 1, "cache reuse should resume after it is bound to the approved visual-bible fingerprint");
}

function testExactThreeViewCascadeWithPosesDisabled(): void {
  const ctx = {
    cfg: undefined,
    chapters: [],
    cards: { title: "", characters: [character("alice"), character("alice_alt")], scenes: [], items: [] },
    materials: [],
    outputDir: ROOT,
    log: () => {},
    figureEmotions: true,
    threeView: false,
    actions: false,
  } satisfies RegenContext;
  const tasks = selectCharacterThreeViewRegenerationTasks(ctx, "alice");
  assert(tasks[0]?.id === "alice_threeview", "explicit regeneration should start with the exact target three-view");
  assert(tasks[1]?.id === "alice" && tasks[1].kind === "figure", "default figure should run immediately after the three-view");
  assert(tasks.slice(2, 6).every((task) => task.kind === "figure" && task.id.startsWith("alice_")), "expressions should run after the default figure");
  assert(tasks.at(-1)?.id === "alice_act_wave", "actions should run last even when batch poses are disabled");
  assert(tasks.every((task) => task.characterId === "alice"), "prefix-related characters must not enter the target cascade");
}

async function testThreeViewRegenerationExecutesReferenceCascadeInOrder(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  const sourceB64 = Buffer.from("source-identity").toString("base64");
  const styleB64 = Buffer.from("global-style").toString("base64");
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice-source.png`, sourceB64);
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/alice-threeview.png`, Buffer.from("old-threeview").toString("base64"));
  await tauri.writeFileBase64(`${ROOT}/.novel2vn/visual-bible/style.png`, styleB64);
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: "ink wash",
    styleReferencePath: "style.png",
    characters: {
      alice: {
        sourceReferencePath: "alice-source.png",
        threeViewPath: "alice-threeview.png",
        prompt: "alice",
        approved: true,
        revision: 1,
      },
    },
    inputFingerprint: "regen-v1",
  };
  const requests: Record<string, unknown>[] = [];
  const generatedPayloads: string[] = [];
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requests.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>);
    const generated = Buffer.from(`generated-${requests.length}`).toString("base64");
    generatedPayloads.push(generated);
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: generated }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    await regenerateCharacterThreeView({
      cfg: qwenConfig(),
      chapters: [],
      cards: { title: "", characters: [character("alice"), character("alice_alt")], scenes: [], items: [] },
      materials: [],
      outputDir: ROOT,
      log: () => {},
      figureEmotions: true,
      threeView: false,
      actions: false,
      visualBible: bible,
    }, "alice");
  } finally {
    tauri.http = originalHttp;
  }
  assert(requests.length === 7, "execution should regenerate three-view, default figure, four expressions, and actions");
  assert(requests[0].image === `data:image/png;base64,${sourceB64}`, "three-view generation should start from the uploaded identity");
  assert(requests[1].image === `data:image/png;base64,${generatedPayloads[0]}`, "default figure should depend on the newly generated three-view");
  assert(requests.slice(2, 6).every((request) => request.image === `data:image/png;base64,${generatedPayloads[1]}`), "expressions should depend on the newly generated default figure");
  assert(requests[6].image === `data:image/png;base64,${generatedPayloads[0]}`, "actions should depend on the newly generated three-view");
  // 角色图（三视图/立绘/动作）不再传全局风格参考图，避免 style_reference 参数的人物特征污染。
  // 风格一致性改为由文字 styleDescription 合入提示词保证。
  assert(requests.every((request) => !request.image2), "character images should not include global style reference to avoid subject contamination");
}

async function main(): Promise<void> {
  await testQwenUsesThreeOrderedDataUrls();
  await testCustomAdapterReceivesRawBase64();
  testCapabilitiesDedupAndLimits();
  await testMissingReferencesAndNoFallback();
  await testLocalReferenceCapabilityErrorIsTypedAndNotRetried();
  await testSelfCheckSendsEveryReferenceInRoleOrder();
  await testApprovedIdentityIsUsedWhenPoseGenerationIsDisabled();
  await testZeroReferenceModelRejectsApprovedIdentityBeforeRequest();
  testSelectionCascadeUsesExactTaskOwnership();
  await testSingleRegenerationLoadsDependenciesFromAllTasks();
  await testCharacterFigureRegenerationUsesExactOwnership();
  await testCacheBindingForcesOnlyChangedCharacter();
  await testIncompleteManifestCacheBindingForcesMissingCharacter();
  await testApprovedItemMaterialBecomesIdentityReference();
  await testSingleReferenceItemUsesIdentityAndApprovedStyleText();
  await testMissingApprovedItemMaterialStopsBeforeGeneration();
  await testMaterialCopyFailureDoesNotFallThroughToGeneration();
  await testApprovedBibleFingerprintPreventsOldCacheBypass();
  testExactThreeViewCascadeWithPosesDisabled();
  await testThreeViewRegenerationExecutesReferenceCascadeInOrder();
  await tauri.removePath(ROOT).catch(() => {});
  console.log("=== image reference contract tests passed ===");
}

main().catch((error) => {
  console.error("image reference contract tests failed:", error);
  process.exit(1);
});
