import { chatCompletion, chatVision, generateImage, ReferenceImageError } from "../api/openaiCompatible";
import { setLlmConcurrency } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { extname, normalizePath, safeFilename } from "../utils/path";
import { buildImageTasks, stripBackground } from "./images";
import { concurrencyFor } from "../stores/configMigration";
import type {
  ApiConfig,
  AssetMap,
  CharacterCard,
  ExtractionResult,
  ImageReference,
  NovelDoc,
  ProjectVisualBible,
  StyleSource,
  VisualBibleCacheBinding,
  VisualBibleCharacter,
  VisualBiblePendingInvalidation,
} from "./types";

const VISUAL_BIBLE_VERSION = 1 as const;
const NOVEL_CHUNK_LIMIT = 12_000;
const SUMMARY_BATCH_LIMIT = 12_000;
const MAX_IMAGE_BASE64_LENGTH = 48_000_000;
const DEFAULT_ASSET_MAP: AssetMap = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };

export interface VisualBibleLoadResult {
  visualBible: ProjectVisualBible | null;
  warnings: string[];
}

export interface VisualBibleFingerprintInput {
  novel: NovelDoc;
  characters: CharacterCard[];
  styleSource: StyleSource;
  styleDescription: string;
  sourceReferenceB64?: string;
  characterReferenceB64?: Record<string, string>;
}

export interface VisualBibleApprovalResult {
  valid: boolean;
  errors: string[];
}

export class VisualBibleApprovalRequiredError extends Error {
  readonly code = "VISUAL_BIBLE_APPROVAL_REQUIRED" as const;

  constructor(message = "视觉圣经尚未确认或已经失效，请先完成风格与角色三视图确认") {
    super(`VISUAL_BIBLE_APPROVAL_REQUIRED: ${message}`);
    this.name = "VisualBibleApprovalRequiredError";
  }
}

export class CharacterAssetKeyConflictError extends Error {
  readonly code = "CHARACTER_ASSET_KEY_CONFLICT" as const;

  constructor(message: string) {
    super(`CHARACTER_ASSET_KEY_CONFLICT: ${message}`);
    this.name = "CharacterAssetKeyConflictError";
  }
}

export interface VisualBibleImageInput {
  sourcePath?: string;
  dataB64?: string;
  mime: string;
}

export interface VisualBibleServiceDependencies {
  chatText: (
    cfg: ApiConfig,
    system: string,
    user: string,
    options?: { maxTokens?: number; temperature?: number },
  ) => Promise<string>;
  chatVision: (
    cfg: ApiConfig,
    system: string,
    user: string,
    imageB64: string,
    options?: { imageMime?: string; maxTokens?: number; temperature?: number },
  ) => Promise<string>;
  generateImage: (
    cfg: ApiConfig,
    prompt: string,
    options: { references?: ImageReference[]; size?: string; seed?: number; negativePrompt?: string },
  ) => Promise<{ dataB64: string; mime: string }>;
}

interface VisualBibleDraftBase {
  outputDir: string;
  novel: NovelDoc;
  cards: ExtractionResult;
  imageCfg: ApiConfig;
  characterReferences?: Record<string, VisualBibleImageInput>;
  /** 生成进度回调：phase 为 "style"（风格分析）| "threeview"（角色三视图） */
  onProgress?: (phase: "style" | "threeview", done: number, total: number) => void;
}

export type CreateVisualBibleDraftInput = VisualBibleDraftBase & (
  | {
    styleSource: "reference_image";
    visionCfg: ApiConfig;
    styleReference: VisualBibleImageInput;
  }
  | {
    styleSource: "novel_analysis";
    llmCfg: ApiConfig;
  }
);

export interface StyleRewriteRequest {
  llmCfg: ApiConfig;
  instruction?: string;
  dependencies?: VisualBibleServiceDependencies;
  currentFingerprint?: string;
}

export interface CharacterSheetRegenerationRequest {
  character: CharacterCard;
  imageCfg: ApiConfig;
  dependencies?: VisualBibleServiceDependencies;
}

export interface StyleReferenceReplacementRequest {
  visionCfg: ApiConfig;
  image: VisualBibleImageInput;
  dependencies?: VisualBibleServiceDependencies;
  currentFingerprint?: string;
}

export interface VisualBibleApprovalRequest {
  novel: NovelDoc;
  characters: CharacterCard[];
  now?: () => string;
}

interface LegacyMigration {
  card: CharacterCard;
  relativePath: string;
}

interface VisualBibleMutation {
  bible: ProjectVisualBible;
  cards?: CharacterCard[];
  afterPublish?: () => Promise<void>;
}

let artifactSequence = 0;
const visualBiblePublishQueues = new Map<string, Promise<ProjectVisualBible>>();

const CHARACTER_TASK_OPTIONS = {
  styleAnchor: false,
  figureEmotions: true,
  threeView: true,
  actions: true,
} as const;

interface CharacterAssetKeyOwner {
  index: number;
  characterId: string;
}

const DEFAULT_DEPENDENCIES: VisualBibleServiceDependencies = {
  async chatText(cfg, system, user, options) {
    const response = await chatCompletion(cfg, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], options);
    return response.content;
  },
  chatVision,
  generateImage,
};

export function visualBibleDir(outputDir: string): string {
  const normalized = normalizePath(outputDir).replace(/\/$/, "");
  if (!normalized) throw new Error("Visual bible output directory is empty");
  return `${normalized}/.novel2vn/visual-bible`;
}

export function visualBibleManifestPath(outputDir: string): string {
  return `${visualBibleDir(outputDir)}/visual-bible.json`;
}

export function visualBiblePath(outputDir: string, storedPath: string): string {
  return visualBibleArtifactPath(visualBibleDir(outputDir), storedPath);
}

function visualBibleArtifactPath(artifactDir: string, storedPath: string): string {
  const normalized = normalizePath(storedPath.trim());
  if (!isProjectLocalPath(normalized)) throw new Error(`Visual bible path must be project-local: ${storedPath}`);
  return `${normalizePath(artifactDir).replace(/\/$/, "")}/${normalized.replace(/^\.\//, "")}`;
}

export function sanitizeVisualBibleId(id: string): string {
  return safeFilename(id, 80) || "character";
}

export function canonicalThreeViewPath(characterId: string): string {
  return `threeview_${sanitizeVisualBibleId(characterId)}.png`;
}

export function canonicalCharacterReferencePath(characterId: string, extension: string): string {
  return `character-reference_${sanitizeVisualBibleId(characterId)}${normalizeImageExtension(extension)}`;
}

export function canonicalStyleReferencePath(extension: string): string {
  return `style-reference${normalizeImageExtension(extension)}`;
}

function revisionedArtifactPath(basePath: string, revision: string): string {
  const extension = extname(basePath);
  return `${basePath.slice(0, -extension.length)}.rev-${revision}${extension}`;
}

export function normalizeStyleDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ");
}

function requireNonEmptyStyle(styleText: string, operation: string): string {
  const normalized = normalizeStyleDescription(styleText);
  if (!normalized) throw new Error(`${operation} returned an empty style description`);
  if (normalized.length > 4_000) throw new Error(`${operation} returned an excessively long style description`);
  return normalized;
}

async function resolveImageInput(image: VisualBibleImageInput): Promise<{ dataB64: string; mime: string }> {
  const hasPath = !!image.sourcePath?.trim();
  const hasData = !!image.dataB64?.trim();
  if (hasPath === hasData) throw new Error("An image input must provide exactly one of sourcePath or dataB64");
  const parsed = hasPath
    ? parseLegacyImage(await tauri.readFileBase64(image.sourcePath!))
    : parseLegacyImage(image.dataB64!);
  const mime = normalizeImageMime(image.mime || parsed.mime);
  return { dataB64: parsed.dataB64, mime };
}

function imageExtension(image: VisualBibleImageInput): string {
  const pathExtension = image.sourcePath ? extname(image.sourcePath) : "";
  return normalizeImageExtension(pathExtension || image.mime);
}

function imageMimeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "image/png";
}

async function readReferenceFile(path: string, label: string): Promise<{ dataB64: string; mime: string }> {
  if (!(await tauri.pathExists(path).catch(() => false))) {
    throw new ReferenceImageError(`${label} is missing: ${path}`, "REFERENCE_MISSING");
  }
  try {
    const dataB64 = await tauri.readFileBase64(path);
    if (!dataB64.trim()) throw new Error("empty file");
    return { dataB64, mime: imageMimeForPath(path) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReferenceImageError(`${label} could not be read: ${path} (${reason})`, "REFERENCE_MISSING");
  }
}

async function persistImageInput(artifactDir: string, relativePath: string, image: VisualBibleImageInput): Promise<string> {
  const destination = visualBibleArtifactPath(artifactDir, relativePath);
  if (await tauri.pathExists(destination).catch(() => false)) {
    throw new Error(`Refusing to overwrite immutable visual-bible artifact: ${relativePath}`);
  }
  const resolved = await resolveImageInput(image);
  if (!hasSupportedImageSignature(resolved.dataB64)) throw new Error(`Image input is not a supported PNG, JPEG, or WebP image: ${relativePath}`);
  if (image.sourcePath && normalizePath(image.sourcePath) !== normalizePath(destination)) {
    await tauri.copyFile(image.sourcePath, destination);
  } else {
    await tauri.writeFileBase64(destination, resolved.dataB64);
  }
  if (!(await tauri.pathExists(destination).catch(() => false))) throw new Error(`Failed to persist image: ${relativePath}`);
  return destination;
}

async function writeGeneratedImage(path: string, image: { dataB64: string; mime: string }): Promise<void> {
  normalizeImageMime(image.mime);
  const parsed = parseLegacyImage(image.dataB64);
  if (!hasSupportedImageSignature(parsed.dataB64)) throw new Error(`Generated artifact is not a supported PNG, JPEG, or WebP image: ${path}`);
  if (await tauri.pathExists(path).catch(() => false)) throw new Error(`Refusing to overwrite immutable visual-bible artifact: ${path}`);
  await tauri.writeFileBase64(path, parsed.dataB64);
}

export async function analyzeReferenceStyle(
  visionCfg: ApiConfig,
  image: VisualBibleImageInput,
  dependencies: VisualBibleServiceDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const resolved = await resolveImageInput(image);
  const description = await dependencies.chatVision(
    visionCfg,
    "You are an art director. Analyze only visible style, never infer story facts or identify people.",
    "Return one concise English image-generation prompt suffix covering medium, linework, color treatment, palette, lighting, texture, and camera language. Do not describe the depicted people or objects.",
    resolved.dataB64,
    { imageMime: resolved.mime, maxTokens: 800, temperature: 0.1 },
  );
  return requireNonEmptyStyle(description, "Reference-image analysis");
}

export function chunkNovelForStyleAnalysis(novel: NovelDoc, maxChars = NOVEL_CHUNK_LIMIT): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 500) throw new Error("Novel style chunk limit must be at least 500 characters");
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const chapter of novel.chapters.filter((entry) => entry.enabled !== false).sort((a, b) => a.index - b.index)) {
    const heading = `[Chapter ${chapter.index + 1}: ${chapter.title}]\n`;
    const text = chapter.text.replace(/\r\n/g, "\n");
    if (!text.trim()) continue;
    let offset = 0;
    while (offset < text.length || (text.length === 0 && offset === 0)) {
      const prefix = offset === 0 ? heading : `[Chapter ${chapter.index + 1} continued]\n`;
      const capacity = Math.max(1, maxChars - prefix.length);
      const piece = text.slice(offset, offset + capacity);
      const section = prefix + piece;
      if (current && current.length + 2 + section.length > maxChars) flush();
      if (section.length >= maxChars) {
        flush();
        chunks.push(section.slice(0, maxChars));
      } else {
        current += `${current ? "\n\n" : ""}${section}`;
      }
      if (!text.length) offset = 1;
      else offset += piece.length;
    }
  }
  flush();
  return chunks;
}

function styleSummaryBatches(summaries: string[]): string[] {
  const batches: string[] = [];
  let current = "";
  for (const summary of summaries) {
    const numbered = `${current ? "\n" : ""}${summary}`;
    if (current && current.length + numbered.length > SUMMARY_BATCH_LIMIT) {
      batches.push(current);
      current = summary;
    } else {
      current += numbered;
    }
  }
  if (current) batches.push(current);
  return batches;
}

async function reduceStyleSummaries(
  llmCfg: ApiConfig,
  initialSummaries: string[],
  dependencies: VisualBibleServiceDependencies,
  concurrency = concurrencyFor(llmCfg, "llm"),
): Promise<string[]> {
  let summaries = initialSummaries;
  while (summaries.join("\n").length > SUMMARY_BATCH_LIMIT) {
    const batches = styleSummaryBatches(summaries);
    const reduced: string[] = new Array(batches.length);
    let batchIdx = 0;
    const worker = async (): Promise<void> => {
      while (batchIdx < batches.length) {
        const i = batchIdx++;
        const merged = await dependencies.chatText(
          llmCfg,
          "You merge visual-development evidence. Preserve recurring and distinctive traits; do not add plot or characters.",
          `STYLE EVIDENCE BATCH\n${batches[i]}\n\nReturn a terse English list covering era, genre, mood, palette, medium, linework, color treatment, lighting, texture, and camera traits.`,
          { maxTokens: 1200, temperature: 0.1 },
        );
        reduced[i] = requireNonEmptyStyle(merged, "Novel style evidence reduction").slice(0, 800);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
    summaries = reduced;
  }
  return summaries;
}

export async function analyzeNovelStyle(
  llmCfg: ApiConfig,
  novel: NovelDoc,
  dependencies: VisualBibleServiceDependencies = DEFAULT_DEPENDENCIES,
  concurrency = concurrencyFor(llmCfg, "llm"),
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const chunks = chunkNovelForStyleAnalysis(novel);
  if (!chunks.length) throw new Error("The novel has no enabled chapter text to analyze");
  // 分段分析并发生成（并发数来自文本 API 配置），避免超长小说串行分析耗时十几分钟
  const summaries: string[] = new Array(chunks.length);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < chunks.length) {
      const index = idx++;
      const summary = await dependencies.chatText(
        llmCfg,
        "You extract visual direction from fiction for a production art bible. Do not summarize plot.",
        `Analyze excerpt ${index + 1}/${chunks.length}. Extract only era, genre, mood, recurring palette, medium, linework, color treatment, lighting, texture, and camera traits. Be terse.\n\nNOVEL EXCERPT\n${chunks[index]}`,
        { maxTokens: 1200, temperature: 0.1 },
      );
      summaries[index] = requireNonEmptyStyle(summary, `Novel style analysis chunk ${index + 1}`).slice(0, 800);
      onProgress?.(index + 1, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  const reducedSummaries = await reduceStyleSummaries(llmCfg, summaries, dependencies, concurrency);
  const synthesisInput = reducedSummaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n");
  const finalStyle = await dependencies.chatText(
    llmCfg,
    "You are a visual-development lead. Consolidate evidence without inventing characters, plot, or branded artist names.",
    `STYLE SUMMARIES\n${synthesisInput}\n\nReturn exactly one concise English image-generation prompt suffix (maximum 80 words). Cover medium, linework, color treatment, palette, lighting, texture, and camera language. No headings or explanation.`,
    { maxTokens: 800, temperature: 0.15 },
  );
  return requireNonEmptyStyle(finalStyle, "Novel style synthesis");
}

async function resolveCharacterReference(
  input: CreateVisualBibleDraftInput,
  card: CharacterCard,
  artifactDir: string,
  artifactRevision: string,
): Promise<{ relativePath?: string; dataB64?: string; mime?: string }> {
  const uploaded = input.characterReferences?.[card.id];
  if (uploaded) {
    const relativePath = revisionedArtifactPath(
      canonicalCharacterReferencePath(card.id, imageExtension(uploaded)),
      artifactRevision,
    );
    await persistImageInput(artifactDir, relativePath, uploaded);
    return { relativePath, dataB64: (await resolveImageInput(uploaded)).dataB64, mime: uploaded.mime };
  }
  if (card.referenceImagePath) {
    const sourcePath = visualBiblePath(input.outputDir, card.referenceImagePath);
    const sourceReference = await readReferenceFile(sourcePath, `Character reference for ${card.id}`);
    const relativePath = revisionedArtifactPath(
      canonicalCharacterReferencePath(card.id, extname(card.referenceImagePath)),
      artifactRevision,
    );
    await tauri.copyFile(sourcePath, visualBibleArtifactPath(artifactDir, relativePath));
    return {
      relativePath,
      dataB64: sourceReference.dataB64,
      mime: sourceReference.mime,
    };
  }
  if (card.referenceImage) {
    const parsed = parseLegacyImage(card.referenceImage);
    const relativePath = revisionedArtifactPath(
      canonicalCharacterReferencePath(card.id, parsed.mime),
      artifactRevision,
    );
    await tauri.writeFileBase64(visualBibleArtifactPath(artifactDir, relativePath), parsed.dataB64);
    return {
      relativePath,
      dataB64: parsed.dataB64,
      mime: parsed.mime,
    };
  }
  return {};
}

function characterThreeViewPrompt(identityPrompt: string, styleDescription: string): string {
  const identity = stripBackground(normalizeStyleDescription(identityPrompt));
  return `${identity}. ${styleDescription}. Character turnaround sheet showing exactly the same person in front, side, and back orthographic full-body views, neutral pose, consistent proportions and clothing, solid chroma key green background (pure #00FF00 green filling the entire background, no gradient, no pattern, no text), no extra figures, no text.`;
}

function characterImageTasks(character: CharacterCard) {
  return buildImageTasks([], {
    title: "",
    characters: [character],
    scenes: [],
    items: [],
  }, CHARACTER_TASK_OPTIONS);
}

export function validateCharacterAssetKeys(characters: CharacterCard[]): void {
  const taskOwners = new Map<string, CharacterAssetKeyOwner>();
  const fileOwners = new Map<string, CharacterAssetKeyOwner>();
  const storageOwners = new Map<string, CharacterAssetKeyOwner>();
  characters.forEach((character, index) => {
    productionActionIds(character);
    const currentOwner = { index, characterId: character.id };
    registerCharacterAssetKey(storageOwners, sanitizeVisualBibleId(character.id), "storage ID", currentOwner);
    for (const task of characterImageTasks(character)) {
      registerCharacterAssetKey(taskOwners, task.id, "task ID", currentOwner);
      registerCharacterAssetKey(fileOwners, task.fileName, "file name", currentOwner);
    }
  });
}

function registerCharacterAssetKey(
  owners: Map<string, CharacterAssetKeyOwner>,
  key: string,
  keyType: "task ID" | "file name" | "storage ID",
  currentOwner: CharacterAssetKeyOwner,
): void {
  const existingOwner = owners.get(key);
  if (existingOwner && existingOwner.index !== currentOwner.index) {
    throw new CharacterAssetKeyConflictError(
      `${keyType} "${key}" is produced by character "${existingOwner.characterId}" at index ${existingOwner.index} and character "${currentOwner.characterId}" at index ${currentOwner.index}`,
    );
  }
  owners.set(key, currentOwner);
}

function productionActionIds(character: CharacterCard): string[] {
  const actionIds = character.actions?.map((action) => action.id) ?? [];
  if (new Set(actionIds).size !== actionIds.length) {
    throw new CharacterAssetKeyConflictError(`task action IDs are duplicated within character "${character.id}"`);
  }
  return actionIds;
}

function characterWithHistoricalActions(bible: ProjectVisualBible, character: CharacterCard): CharacterCard {
  const currentActions = character.actions ?? [];
  productionActionIds(character);
  const currentIds = new Set(currentActions.map((action) => action.id));
  const historicalActions = (bible.characters[character.id]?.actionIds ?? [])
    .filter((actionId) => !currentIds.has(actionId))
    .map((actionId) => ({ id: actionId, name: actionId, prompt: actionId }));
  return { ...character, actions: [...currentActions, ...historicalActions] };
}

function characterCardFromVisualBible(characterId: string, character: VisualBibleCharacter): CharacterCard {
  return {
    id: characterId,
    name: characterId,
    appearance: "",
    clothing: "",
    personality: "",
    voiceDesc: "",
    imagePrompt: character.prompt,
    threeViewPrompt: character.prompt,
    actions: character.actionIds?.map((actionId) => ({ id: actionId, name: actionId, prompt: actionId })),
    color: "#000000",
  };
}

function characterCardsFromVisualBible(
  bible: Pick<ProjectVisualBible, "characters">,
  replacement?: CharacterCard,
): CharacterCard[] {
  return Object.entries(bible.characters).map(([characterId, character]) => (
    replacement?.id === characterId ? replacement : characterCardFromVisualBible(characterId, character)
  ));
}

async function createDraftStyle(
  input: CreateVisualBibleDraftInput,
  dependencies: VisualBibleServiceDependencies,
  artifactDir: string,
  artifactRevision: string,
): Promise<{ description: string; referencePath: string; sourceReferenceB64?: string }> {
  if (input.styleSource === "reference_image") {
    const resolved = await resolveImageInput(input.styleReference);
    const referencePath = revisionedArtifactPath(
      canonicalStyleReferencePath(imageExtension(input.styleReference)),
      artifactRevision,
    );
    await persistImageInput(artifactDir, referencePath, input.styleReference);
    const description = await analyzeReferenceStyle(input.visionCfg, input.styleReference, dependencies);
    return { description, referencePath, sourceReferenceB64: resolved.dataB64 };
  }

  const description = await analyzeNovelStyle(
    input.llmCfg,
    input.novel,
    dependencies,
    concurrencyFor(input.llmCfg, "llm"),
    (done, total) => input.onProgress?.("style", done, total),
  );
  const referencePath = revisionedArtifactPath("style-sample.png", artifactRevision);
  const sample = await dependencies.generateImage(
    input.imageCfg,
    `${description}. Environment-only visual style sample, no people, no characters, no faces, no text, coherent palette and lighting.`,
    { size: "1024x576" },
  );
  await writeGeneratedImage(visualBibleArtifactPath(artifactDir, referencePath), sample);
  return { description, referencePath };
}

async function createDraftCharacters(
  input: CreateVisualBibleDraftInput,
  styleDescription: string,
  styleReferencePath: string,
  dependencies: VisualBibleServiceDependencies,
  artifactDir: string,
  artifactRevision: string,
): Promise<Record<string, VisualBibleCharacter>> {
  const characters: Record<string, VisualBibleCharacter> = {};
  const canonicalIds = new Set<string>();
  for (const card of input.cards.characters) {
    if (characters[card.id]) throw new Error(`Duplicate character ID in visual bible draft: ${card.id}`);
    const canonicalId = sanitizeVisualBibleId(card.id);
    if (canonicalIds.has(canonicalId)) throw new Error(`Character IDs collide in canonical storage: ${card.id}`);
    canonicalIds.add(canonicalId);
  }
  const styleArtifactPath = visualBibleArtifactPath(artifactDir, styleReferencePath);
  const styleArtifact = await readReferenceFile(styleArtifactPath, "Global style reference");
  const styleReference: ImageReference = {
    role: "style",
    ...styleArtifact,
    sourcePath: styleArtifactPath,
  };
  const concurrency = concurrencyFor(input.imageCfg, "image");
  const cards = input.cards.characters;
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < cards.length) {
      const pos = idx++;
      const card = cards[pos];
      const reference = await resolveCharacterReference(input, card, artifactDir, artifactRevision);
      const prompt = normalizeStyleDescription(card.threeViewPrompt || card.imagePrompt);
      const references: ImageReference[] = [
        ...(reference.dataB64 ? [{
          role: "identity" as const,
          dataB64: reference.dataB64,
          mime: reference.mime ?? "image/png",
          sourcePath: reference.relativePath,
          required: true,
        }] : []),
        { ...styleReference, required: !reference.dataB64 },
      ];
      const generated = await dependencies.generateImage(input.imageCfg, characterThreeViewPrompt(prompt, styleDescription), {
        references,
        size: "1024x1024",
      });
      const threeViewPath = revisionedArtifactPath(canonicalThreeViewPath(card.id), artifactRevision);
      await writeGeneratedImage(visualBibleArtifactPath(artifactDir, threeViewPath), generated);
      const sourceRevision = reference.relativePath ? 1 : 0;
      const actionIds = productionActionIds(card);
      characters[card.id] = {
        ...(reference.relativePath ? { sourceReferencePath: reference.relativePath } : {}),
        threeViewPath,
        prompt,
        ...(actionIds.length ? { actionIds } : {}),
        approved: false,
        revision: 1,
        sourceRevision,
        sheetSourceRevision: sourceRevision,
      };
      input.onProgress?.("threeview", pos + 1, cards.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cards.length) }, () => worker()));
  return characters;
}

export async function createVisualBibleDraft(
  input: CreateVisualBibleDraftInput,
  dependencies: VisualBibleServiceDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProjectVisualBible> {
  // 文本/视觉请求限流跟随各 API 自己的并发配置（各 API 互不影响）
  if (input.styleSource === "novel_analysis") {
    setLlmConcurrency(input.llmCfg, concurrencyFor(input.llmCfg, "llm"));
  } else if (input.styleSource === "reference_image") {
    setLlmConcurrency(input.visionCfg, concurrencyFor(input.visionCfg, "vision"));
  }
  validateCharacterAssetKeys(input.cards.characters);
  const published = await mutateAndPublishVisualBible(input.outputDir, async (artifactDir, artifactRevision) => {
    const style = await createDraftStyle(input, dependencies, artifactDir, artifactRevision);
    const characters = await createDraftCharacters(
      input,
      style.description,
      style.referencePath,
      dependencies,
      artifactDir,
      artifactRevision,
    );
    const draft: ProjectVisualBible = {
      version: VISUAL_BIBLE_VERSION,
      status: "draft",
      styleSource: input.styleSource,
      styleDescription: style.description,
      styleReferencePath: style.referencePath,
      characters,
      inputFingerprint: computeVisualBibleFingerprint({
        novel: input.novel,
        characters: input.cards.characters,
        styleSource: input.styleSource,
        styleDescription: style.description,
        sourceReferenceB64: style.sourceReferenceB64,
        characterReferenceB64: await readCharacterReferencePayloads(artifactDir, characters),
      }),
      pendingInvalidation: { scope: "global" },
    };
    return {
      bible: draft,
      cards: input.cards.characters,
      afterPublish: () => invalidateGlobalCaches(input.outputDir),
    };
  });
  return published;
}

export async function updateStyleDescription(
  outputDir: string,
  bible: ProjectVisualBible,
  description: string,
  currentFingerprint?: string,
): Promise<ProjectVisualBible> {
  const normalized = requireNonEmptyStyle(description, "Style edit");
  await mutateAndPublishVisualBible(outputDir, async () => {
    const next = cloneVisualBible(bible);
    markGlobalBibleChanged(next);
    next.styleDescription = normalized;
    if (currentFingerprint) next.inputFingerprint = currentFingerprint;
    return { bible: next, afterPublish: () => invalidateGlobalCaches(outputDir) };
  }, bible);
  return bible;
}

export async function rewriteStyleDescription(
  outputDir: string,
  bible: ProjectVisualBible,
  request: StyleRewriteRequest,
): Promise<string> {
  const dependencies = request.dependencies ?? DEFAULT_DEPENDENCIES;
  let rewrittenStyle = "";
  await mutateAndPublishVisualBible(outputDir, async () => {
    const rewritten = await dependencies.chatText(
      request.llmCfg,
      "You rewrite visual-development prompts. Preserve concrete visual traits and do not add plot or characters.",
      `CURRENT STYLE\n${bible.styleDescription}\n\nREVISION REQUEST\n${request.instruction ?? "Make this style prompt concise and production-ready."}\n\nReturn one concise English image-generation prompt suffix, maximum 80 words, with no heading or explanation.`,
      { maxTokens: 800, temperature: 0.2 },
    );
    rewrittenStyle = requireNonEmptyStyle(rewritten, "Style rewrite");
    const next = cloneVisualBible(bible);
    markGlobalBibleChanged(next);
    next.styleDescription = rewrittenStyle;
    if (request.currentFingerprint) next.inputFingerprint = request.currentFingerprint;
    return { bible: next, afterPublish: () => invalidateGlobalCaches(outputDir) };
  }, bible);
  return rewrittenStyle;
}

export async function regenerateStyleSample(
  outputDir: string,
  bible: ProjectVisualBible,
  imageCfg: ApiConfig,
  dependencies: VisualBibleServiceDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const published = await mutateAndPublishVisualBible(outputDir, async (artifactDir, artifactRevision) => {
    if (bible.styleSource !== "novel_analysis") throw new Error("Uploaded style references cannot be regenerated as samples");
    const generated = await dependencies.generateImage(
      imageCfg,
      `${bible.styleDescription}. Environment-only visual style sample, no people, no characters, no faces, no text, coherent palette and lighting.`,
      { size: "1024x576" },
    );
    const next = cloneVisualBible(bible);
    markGlobalBibleChanged(next);
    next.styleReferencePath = revisionedArtifactPath("style-sample.png", artifactRevision);
    await writeGeneratedImage(visualBibleArtifactPath(artifactDir, next.styleReferencePath), generated);
    return { bible: next, afterPublish: () => invalidateGlobalCaches(outputDir) };
  }, bible);
  return visualBiblePath(outputDir, published.styleReferencePath);
}

export async function regenerateCharacterSheet(
  outputDir: string,
  bible: ProjectVisualBible,
  request: CharacterSheetRegenerationRequest,
): Promise<string> {
  const { character: characterCard, imageCfg } = request;
  const invalidationCharacter = characterWithHistoricalActions(bible, characterCard);
  validateCharacterAssetKeys(characterCardsFromVisualBible(bible, characterCard));
  const characterId = characterCard.id;
  const dependencies = request.dependencies ?? DEFAULT_DEPENDENCIES;
  const published = await mutateAndPublishVisualBible(outputDir, async (artifactDir, artifactRevision) => {
    const storedCharacter = bible.characters[characterId];
    if (!storedCharacter) throw new Error(`Character is missing from visual bible: ${characterId}`);
    let identityReference: ImageReference | undefined;
    if (storedCharacter.sourceReferencePath) {
      const referencePath = visualBiblePath(outputDir, storedCharacter.sourceReferencePath);
      const sourceReference = await readReferenceFile(referencePath, `Character reference for ${characterId}`);
      identityReference = {
        role: "identity",
        ...sourceReference,
        sourcePath: referencePath,
      };
    }
    const styleReferencePath = visualBiblePath(outputDir, bible.styleReferencePath);
    const styleReference = await readReferenceFile(styleReferencePath, "Global style reference");
    const generated = await dependencies.generateImage(
      imageCfg,
      characterThreeViewPrompt(storedCharacter.prompt, bible.styleDescription),
      {
        references: [
          ...(identityReference ? [{ ...identityReference, required: true }] : []),
          {
            role: "style",
            ...styleReference,
            sourcePath: styleReferencePath,
            required: !identityReference,
          },
        ],
        size: "1024x1024",
      },
    );
    const next = cloneVisualBible(bible);
    const nextCharacter = next.characters[characterId];
    markCharacterBibleChanged(next, characterId);
    nextCharacter.threeViewPath = revisionedArtifactPath(canonicalThreeViewPath(characterId), artifactRevision);
    nextCharacter.sheetSourceRevision = characterSourceRevision(nextCharacter);
    await writeGeneratedImage(visualBibleArtifactPath(artifactDir, nextCharacter.threeViewPath), generated);
    return { bible: next, cards: [characterCard], afterPublish: () => invalidateCharacterCaches(outputDir, invalidationCharacter) };
  }, bible);
  return visualBiblePath(outputDir, published.characters[characterId].threeViewPath);
}

export async function acceptCharacterSheet(
  outputDir: string,
  bible: ProjectVisualBible,
  characterId: string,
): Promise<ProjectVisualBible> {
  await mutateAndPublishVisualBible(outputDir, async () => {
    const character = bible.characters[characterId];
    if (!character) throw new Error(`Character is missing from visual bible: ${characterId}`);
    const artifactError = await validateImageArtifact(outputDir, character.threeViewPath, `Character ${characterId} three-view`);
    if (artifactError) throw new Error(artifactError);
    if (characterSourceRevision(character) !== characterSheetSourceRevision(character)) {
      throw new Error(`Character three-view does not match the current source revision: ${characterId}`);
    }
    const next = cloneVisualBible(bible);
    next.characters[characterId].approved = true;
    return { bible: next };
  }, bible);
  return bible;
}

export async function replaceStyleReference(
  outputDir: string,
  bible: ProjectVisualBible,
  request: StyleReferenceReplacementRequest,
): Promise<ProjectVisualBible> {
  const dependencies = request.dependencies ?? DEFAULT_DEPENDENCIES;
  await mutateAndPublishVisualBible(outputDir, async (artifactDir, artifactRevision) => {
    const styleDescription = await analyzeReferenceStyle(request.visionCfg, request.image, dependencies);
    const next = cloneVisualBible(bible);
    markGlobalBibleChanged(next);
    const relativePath = revisionedArtifactPath(
      canonicalStyleReferencePath(imageExtension(request.image)),
      artifactRevision,
    );
    await persistImageInput(artifactDir, relativePath, request.image);
    next.styleSource = "reference_image";
    next.styleReferencePath = relativePath;
    next.styleDescription = styleDescription;
    if (request.currentFingerprint) next.inputFingerprint = request.currentFingerprint;
    return { bible: next, afterPublish: () => invalidateGlobalCaches(outputDir) };
  }, bible);
  return bible;
}

export async function replaceCharacterReference(
  outputDir: string,
  bible: ProjectVisualBible,
  characterCard: CharacterCard,
  image: VisualBibleImageInput,
): Promise<ProjectVisualBible> {
  const characterId = characterCard.id;
  const invalidationCharacter = characterWithHistoricalActions(bible, characterCard);
  validateCharacterAssetKeys(characterCardsFromVisualBible(bible, characterCard));
  await mutateAndPublishVisualBible(outputDir, async (artifactDir, artifactRevision) => {
    const storedCharacter = bible.characters[characterId];
    if (!storedCharacter) throw new Error(`Character is missing from visual bible: ${characterId}`);
    const next = cloneVisualBible(bible);
    const nextCharacter = next.characters[characterId];
    markCharacterBibleChanged(next, characterId);
    const relativePath = revisionedArtifactPath(
      canonicalCharacterReferencePath(characterId, imageExtension(image)),
      artifactRevision,
    );
    await persistImageInput(artifactDir, relativePath, image);
    nextCharacter.sourceReferencePath = relativePath;
    nextCharacter.sourceRevision = characterSourceRevision(storedCharacter) + 1;
    nextCharacter.sheetSourceRevision = characterSheetSourceRevision(storedCharacter);
    return { bible: next, cards: [characterCard], afterPublish: () => invalidateCharacterCaches(outputDir, invalidationCharacter) };
  }, bible);
  return bible;
}

/**
 * 用 LLM 重新生成角色描述（imagePrompt + threeViewPrompt），强制绿幕背景。
 * 解决问题：之前 LLM 提取时把背景写死成 `plain solid <色> background`，与绿幕后缀冲突，
 * 导致 AI 按旧色画底色。重新生成会强制把背景统一为纯绿幕（pure #00FF00 green）。
 *
 * 纯函数：仅调 LLM，不写盘。返回 { imagePrompt, threeViewPrompt }，由调用方决定持久化。
 */
export async function regenerateCharacterDescription(
  cfg: ApiConfig,
  character: CharacterCard,
  dependencies: VisualBibleServiceDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ imagePrompt: string; threeViewPrompt: string }> {
  const systemPrompt = `你是角色设定师。请基于给定的角色设定（外貌/服装/性格），重新生成两段严格的英文 AI 绘图 prompt。

严格要求：
1. 必须输出严格的 JSON，不要 markdown 代码块，不要任何其他文字
2. 不要在 imagePrompt / threeViewPrompt 中写任何背景/底色/场地/环境描述（背景由系统统一附加纯绿幕 chroma key green，prompt 里写了反而会造成底色冲突）
3. 描述该角色的发型/瞳色/服装/体型/气质，不要凭空添加小说里没有的元素
4. 全身可见（full body visible），站姿自然，动漫风格

输出 JSON 字段：
{
  "imagePrompt": "立绘的完整英文 prompt（只描述人物外观/服装/姿态，不写背景）",
  "threeViewPrompt": "三视图的完整英文 prompt（同一角色、站姿自然、表情平静、全身可见，不写背景）"
}`;

  const userPrompt = `ROLE NAME
${character.name || character.id}

APPEARANCE
${character.appearance || "(none)"}

CLOTHING
${character.clothing || "(none)"}

PERSONALITY
${character.personality || "(none)"}

CURRENT imagePrompt (raw, may contain old background colors)
${character.imagePrompt || "(none)"}

请基于以上信息重新生成严格的 JSON imagePrompt 和 threeViewPrompt：`;

  const reply = await dependencies.chatText(
    cfg,
    systemPrompt,
    userPrompt,
    { maxTokens: 1400, temperature: 0.2 },
  );

  const cleaned = reply.replace(/```json|```/g, "").trim();
  let data: { imagePrompt?: string; threeViewPrompt?: string };
  try {
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < 0) throw new Error("no JSON object");
    data = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    throw new Error(`角色描述重新生成失败：返回内容不是合法 JSON（${(e as Error).message}）`);
  }

  const newImagePrompt = stripBackground(data.imagePrompt || "").trim();
  const newThreeViewPrompt = stripBackground(data.threeViewPrompt || "").trim();
  if (!newImagePrompt || !newThreeViewPrompt) {
    throw new Error("角色描述重新生成失败：LLM 返回内容缺少 imagePrompt / threeViewPrompt");
  }
  return { imagePrompt: newImagePrompt, threeViewPrompt: newThreeViewPrompt };
}

/**
 * 把重新生成的角色描述持久化到 visual bible + 同步卡片 + 失效缓存。
 * 必须在 regenerateCharacterDescription 拿到 imagePrompt/threeViewPrompt 之后调用。
 * 返回更新后的（bible, card）供调用方同步更新 projectState.lastResult.cards。
 */
export async function persistRegeneratedCharacterDescription(
  outputDir: string,
  bible: ProjectVisualBible,
  characterId: string,
  characterCard: CharacterCard,
  imagePrompt: string,
  threeViewPrompt: string,
): Promise<{ bible: ProjectVisualBible; card: CharacterCard }> {
  const storedCharacter = bible.characters[characterId];
  if (!storedCharacter) throw new Error(`Character is missing from visual bible: ${characterId}`);
  const invalidationCharacter = characterWithHistoricalActions(bible, characterCard);
  const updatedCard: CharacterCard = { ...characterCard, imagePrompt, threeViewPrompt };
  await mutateAndPublishVisualBible(outputDir, async () => {
    const next = cloneVisualBible(bible);
    const nextCharacter = next.characters[characterId];
    markCharacterBibleChanged(next, characterId);
    nextCharacter.prompt = imagePrompt;
    nextCharacter.approved = false;
    return {
      bible: next,
      cards: [updatedCard],
      afterPublish: () => invalidateCharacterCaches(outputDir, invalidationCharacter),
    };
  }, bible);
  return { bible, card: updatedCard };
}

function normalizeImageExtension(imageTypeOrPath: string): string {
  const raw = imageTypeOrPath.trim().toLowerCase();
  const extension = raw.startsWith("image/")
    ? raw.includes("jpeg") ? ".jpg" : raw.includes("webp") ? ".webp" : ".png"
    : raw.startsWith(".") ? raw : extname(raw) || `.${raw}`;
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extension) ? extension.replace(".jpeg", ".jpg") : ".png";
}

function normalizeImageMime(rawMime: string): string {
  const mime = rawMime.trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error(`Unsupported image MIME type: ${rawMime}`);
  return mime;
}

function isProjectLocalPath(candidatePath: unknown): candidatePath is string {
  if (typeof candidatePath !== "string" || !candidatePath.trim()) return false;
  const path = normalizePath(candidatePath.trim());
  return !path.startsWith("data:") && !path.includes("..") && !/^[A-Za-z]:\//.test(path) && !path.startsWith("/");
}

function isVisualBibleCharacter(rawCharacter: unknown): rawCharacter is VisualBibleCharacter {
  if (!rawCharacter || typeof rawCharacter !== "object") return false;
  const candidate = rawCharacter as Partial<VisualBibleCharacter>;
  return isProjectLocalPath(candidate.threeViewPath)
    && typeof candidate.prompt === "string"
    && typeof candidate.approved === "boolean"
    && Number.isInteger(candidate.revision) && candidate.revision! >= 0
    && (candidate.actionIds === undefined || (
      Array.isArray(candidate.actionIds)
      && candidate.actionIds.length <= 4
      && candidate.actionIds.every((actionId) => typeof actionId === "string")
    ))
    && (candidate.sourceRevision === undefined || (Number.isInteger(candidate.sourceRevision) && candidate.sourceRevision >= 0))
    && (candidate.sheetSourceRevision === undefined || (Number.isInteger(candidate.sheetSourceRevision) && candidate.sheetSourceRevision >= 0))
    && (candidate.sourceReferencePath === undefined || isProjectLocalPath(candidate.sourceReferencePath));
}

function characterSourceRevision(character: VisualBibleCharacter): number {
  return character.sourceRevision ?? (character.sourceReferencePath ? 1 : 0);
}

function characterSheetSourceRevision(character: VisualBibleCharacter): number {
  return character.sheetSourceRevision ?? characterSourceRevision(character);
}

function isCanonicalOrRevisionedPath(storedPath: string, canonicalPath: string): boolean {
  if (storedPath === canonicalPath) return true;
  const extension = extname(canonicalPath);
  const stem = canonicalPath.slice(0, -extension.length);
  return storedPath.startsWith(`${stem}.rev-`)
    && storedPath.endsWith(extension)
    && /^[A-Za-z0-9-]+$/.test(storedPath.slice(stem.length + 5, -extension.length));
}

function parseManifest(rawManifest: unknown): ProjectVisualBible {
  if (!rawManifest || typeof rawManifest !== "object") throw new Error("manifest root is not an object");
  const candidate = rawManifest as Partial<ProjectVisualBible>;
  if (candidate.version !== VISUAL_BIBLE_VERSION) throw new Error(`unsupported manifest version: ${String(candidate.version)}`);
  if (!(["draft", "approved", "stale"] as const).includes(candidate.status as never)) throw new Error("invalid status");
  if (!(["reference_image", "novel_analysis"] as const).includes(candidate.styleSource as never)) throw new Error("invalid style source");
  if (typeof candidate.styleDescription !== "string" || !isProjectLocalPath(candidate.styleReferencePath)) throw new Error("invalid style fields");
  if (typeof candidate.inputFingerprint !== "string" || !candidate.characters || typeof candidate.characters !== "object") {
    throw new Error("invalid fingerprint or characters");
  }
  const expectedStylePath = candidate.styleSource === "novel_analysis"
    ? isCanonicalOrRevisionedPath(candidate.styleReferencePath, "style-sample.png")
    : isCanonicalOrRevisionedPath(
      candidate.styleReferencePath,
      canonicalStyleReferencePath(extname(candidate.styleReferencePath)),
    );
  if (!expectedStylePath) throw new Error("non-canonical style reference path");
  const canonicalIds = new Set<string>();
  for (const [id, character] of Object.entries(candidate.characters)) {
    if (!id || !isVisualBibleCharacter(character)) throw new Error(`invalid character: ${id || "(empty)"}`);
    const canonicalId = sanitizeVisualBibleId(id);
    if (canonicalIds.has(canonicalId)) {
      throw new CharacterAssetKeyConflictError(`character IDs collide in canonical storage at "${canonicalId}": ${id}`);
    }
    canonicalIds.add(canonicalId);
    if (!isCanonicalOrRevisionedPath(character.threeViewPath, canonicalThreeViewPath(id))) {
      throw new Error(`non-canonical three-view path: ${id}`);
    }
    if (character.sourceReferencePath && !isCanonicalOrRevisionedPath(
      character.sourceReferencePath,
      canonicalCharacterReferencePath(id, extname(character.sourceReferencePath)),
    )) {
      throw new Error(`non-canonical character reference path: ${id}`);
    }
  }
  if (!isPendingInvalidation(candidate.pendingInvalidation, candidate.characters)) {
    throw new Error("invalid pending invalidation scope");
  }
  if (!isCacheBinding(candidate.cacheBinding, candidate.characters)) throw new Error("invalid cache binding");
  validateCharacterAssetKeys(characterCardsFromVisualBible(candidate as ProjectVisualBible));
  if (candidate.approvedAt !== undefined && typeof candidate.approvedAt !== "string") throw new Error("invalid approval timestamp");
  return candidate as ProjectVisualBible;
}

function manifestForSave(bible: ProjectVisualBible): ProjectVisualBible {
  return parseManifest({
    version: VISUAL_BIBLE_VERSION,
    status: bible.status,
    styleSource: bible.styleSource,
    styleDescription: normalizeStyleDescription(bible.styleDescription),
    styleReferencePath: bible.styleReferencePath,
    characters: Object.fromEntries(Object.entries(bible.characters).map(([id, character]) => [id, {
      ...(character.sourceReferencePath ? { sourceReferencePath: character.sourceReferencePath } : {}),
      threeViewPath: character.threeViewPath,
      prompt: character.prompt,
      ...(character.actionIds?.length ? { actionIds: [...character.actionIds] } : {}),
      approved: character.approved,
      revision: character.revision,
      sourceRevision: characterSourceRevision(character),
      sheetSourceRevision: characterSheetSourceRevision(character),
    }])),
    inputFingerprint: bible.inputFingerprint,
    ...(bible.pendingInvalidation ? { pendingInvalidation: clonePendingInvalidation(bible.pendingInvalidation) } : {}),
    ...(bible.cacheBinding ? { cacheBinding: cloneCacheBinding(bible.cacheBinding) } : {}),
    ...(bible.approvedAt ? { approvedAt: bible.approvedAt } : {}),
  });
}

function isPendingInvalidation(
  pending: VisualBiblePendingInvalidation | undefined,
  characters: Record<string, VisualBibleCharacter>,
): boolean {
  if (pending === undefined) return true;
  if (pending.scope === "global") return true;
  return pending.scope === "characters"
    && Array.isArray(pending.characterIds)
    && pending.characterIds.length > 0
    && new Set(pending.characterIds).size === pending.characterIds.length
    && pending.characterIds.every((characterId) => typeof characterId === "string" && !!characters[characterId]);
}

function isCacheBinding(
  binding: VisualBibleCacheBinding | undefined,
  characters: Record<string, VisualBibleCharacter>,
): boolean {
  if (binding === undefined) return true;
  if (typeof binding.globalFingerprint !== "string" || !binding.globalFingerprint.trim()) return false;
  if (!binding.characterRevisions || typeof binding.characterRevisions !== "object") return false;
  const characterIds = Object.keys(characters);
  if (Object.keys(binding.characterRevisions).length !== characterIds.length) return false;
  return characterIds.every((characterId) => {
    const revision = binding.characterRevisions[characterId];
    return !!characters[characterId] && Number.isInteger(revision) && revision >= 0;
  });
}

function clonePendingInvalidation(pending: VisualBiblePendingInvalidation): VisualBiblePendingInvalidation {
  return pending.scope === "global"
    ? { scope: "global" }
    : { scope: "characters", characterIds: [...pending.characterIds] };
}

function cloneCacheBinding(binding: VisualBibleCacheBinding): VisualBibleCacheBinding {
  return {
    globalFingerprint: binding.globalFingerprint,
    characterRevisions: { ...binding.characterRevisions },
  };
}

async function readManifestAtPath(path: string): Promise<ProjectVisualBible | null> {
  try {
    const { text } = await tauri.readTextFile(path);
    return parseManifest(JSON.parse(text));
  } catch {
    return null;
  }
}

async function recoverVisualBibleStorage(outputDir: string): Promise<string[]> {
  const artifactDir = visualBibleDir(outputDir);
  return [
    ...await recoverDirectoryBackup(outputDir, artifactDir),
    ...await recoverManifestBackup(outputDir, artifactDir),
    ...await recoverTemporaryManifest(outputDir, artifactDir),
  ];
}

async function manifestAndArtifactsAreValid(manifestPath: string, artifactDir: string): Promise<boolean> {
  const manifest = await readManifestAtPath(manifestPath);
  return !!manifest && (await validateStoredArtifacts(artifactDir, manifest)).length === 0;
}

async function recoverDirectoryBackup(outputDir: string, artifactDir: string): Promise<string[]> {
  const directoryBackup = `${artifactDir}.replace-backup`;
  if (!(await tauri.pathExists(directoryBackup).catch(() => false))) return [];
  const manifestPath = visualBibleManifestPath(outputDir);
  if (await manifestAndArtifactsAreValid(manifestPath, artifactDir)) {
    await tauri.removePath(directoryBackup);
    return [];
  }
  if (await manifestAndArtifactsAreValid(`${directoryBackup}/visual-bible.json`, directoryBackup)) {
    await tauri.copyDirAll(directoryBackup, artifactDir);
    if (await manifestAndArtifactsAreValid(manifestPath, artifactDir)) {
      await tauri.removePath(directoryBackup);
      return ["Recovered the visual bible from an interrupted directory publication"];
    }
  }
  return [`Visual-bible directory backup was retained because neither destination nor backup validated: ${directoryBackup}`];
}

async function recoverManifestBackup(outputDir: string, artifactDir: string): Promise<string[]> {
  const manifestPath = visualBibleManifestPath(outputDir);
  const manifestBackup = `${manifestPath}.replace-backup`;
  if (!(await tauri.pathExists(manifestBackup).catch(() => false))) return [];
  if (await manifestAndArtifactsAreValid(manifestPath, artifactDir)) {
    await tauri.removePath(manifestBackup);
    return [];
  }
  if (await manifestAndArtifactsAreValid(manifestBackup, artifactDir)) {
    await tauri.copyFile(manifestBackup, manifestPath);
    if (await manifestAndArtifactsAreValid(manifestPath, artifactDir)) {
      await tauri.removePath(manifestBackup);
      return ["Recovered the visual-bible manifest from an interrupted publication"];
    }
  }
  return [`Visual-bible manifest backup was retained because neither destination nor backup validated: ${manifestBackup}`];
}

async function recoverTemporaryManifest(outputDir: string, artifactDir: string): Promise<string[]> {
  const manifestPath = visualBibleManifestPath(outputDir);
  const temporaryManifest = `${manifestPath}.tmp`;
  if (!(await tauri.pathExists(temporaryManifest).catch(() => false))) return [];
  if (await manifestAndArtifactsAreValid(manifestPath, artifactDir)) {
    await tauri.removePath(temporaryManifest);
    return [];
  }
  if (await manifestAndArtifactsAreValid(temporaryManifest, artifactDir)) {
    await tauri.copyFile(temporaryManifest, manifestPath);
    if (await manifestAndArtifactsAreValid(manifestPath, artifactDir)) {
      await tauri.removePath(temporaryManifest);
      return ["Recovered the visual-bible manifest from an interrupted initial publication"];
    }
  }
  return [`Temporary visual-bible manifest was retained because it could not be validated: ${temporaryManifest}`];
}

export async function loadVisualBible(outputDir: string): Promise<VisualBibleLoadResult> {
  let warnings: string[];
  try {
    warnings = await recoverVisualBibleStorage(outputDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings = [`Visual-bible recovery failed; backups were retained: ${message}`];
  }
  const manifestPath = visualBibleManifestPath(outputDir);
  if (!(await tauri.pathExists(manifestPath).catch(() => false))) {
    return { visualBible: null, warnings: [...warnings, `Visual bible manifest is missing: ${manifestPath}`] };
  }
  try {
    const { text } = await tauri.readTextFile(manifestPath);
    const visualBible = parseManifest(JSON.parse(text));
    if (visualBible.status === "approved") {
      const validation = await validateVisualBibleForApproval(outputDir, visualBible, Object.keys(visualBible.characters));
      if (!validation.valid) {
        visualBible.status = "stale";
        delete visualBible.approvedAt;
        warnings.push(...validation.errors.map((error) => `Approved visual bible is stale: ${error}`));
        try {
          await saveVisualBible(outputDir, visualBible);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Failed to persist stale visual-bible state: ${message}`);
        }
      }
    }
    return { visualBible, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { visualBible: null, warnings: [...warnings, `Visual bible manifest is corrupt: ${message}`] };
  }
}

function parseLegacyImage(rawImage: string): { dataB64: string; mime: string } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(rawImage.trim());
  const dataB64 = (match?.[2] ?? rawImage).replace(/\s+/g, "");
  if (!dataB64 || dataB64.length > MAX_IMAGE_BASE64_LENGTH || dataB64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataB64)) {
    throw new Error("Image payload is not valid bounded base64 data");
  }
  const mime = dataB64.startsWith("/9j/") ? "image/jpeg" : dataB64.startsWith("UklGR") ? "image/webp" : "image/png";
  return { dataB64, mime: match ? normalizeImageMime(match[1]) : mime };
}

function hasSupportedImageSignature(dataB64: string): boolean {
  const prefix = dataB64.slice(0, 24);
  const bytes = typeof Buffer !== "undefined"
    ? new Uint8Array(Buffer.from(prefix, "base64"))
    : Uint8Array.from(atob(prefix), (character) => character.charCodeAt(0));
  const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return isPng || isJpeg || isWebp;
}

async function validateImageArtifact(outputDir: string, storedPath: string, label: string): Promise<string | null> {
  return validateImageArtifactAtDir(visualBibleDir(outputDir), storedPath, label);
}

async function validateImageArtifactAtDir(artifactDir: string, storedPath: string, label: string): Promise<string | null> {
  const path = visualBibleArtifactPath(artifactDir, storedPath);
  if (!(await tauri.pathExists(path).catch(() => false))) return `${label} is missing: ${storedPath}`;
  try {
    const parsed = parseLegacyImage(await tauri.readFileBase64(path));
    if (!hasSupportedImageSignature(parsed.dataB64)) return `${label} is not a supported PNG, JPEG, or WebP image: ${storedPath}`;
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${label} is empty or invalid (${storedPath}): ${message}`;
  }
}

async function validateStoredArtifacts(
  artifactDir: string,
  bible: ProjectVisualBible,
): Promise<string[]> {
  const errors: string[] = [];
  const styleError = await validateImageArtifactAtDir(artifactDir, bible.styleReferencePath, "Style reference");
  if (styleError) errors.push(styleError);
  for (const [characterId, character] of Object.entries(bible.characters)) {
    const sheetError = await validateImageArtifactAtDir(
      artifactDir,
      character.threeViewPath,
      `Character ${characterId} three-view`,
    );
    if (sheetError) errors.push(sheetError);
    if (character.sourceReferencePath) {
      const sourceError = await validateImageArtifactAtDir(
        artifactDir,
        character.sourceReferencePath,
        `Character ${characterId} source reference`,
      );
      if (sourceError) errors.push(sourceError);
    }
  }
  return errors;
}

async function prepareLegacyMigrations(
  artifactDir: string,
  manifest: ProjectVisualBible,
  cards: CharacterCard[],
  artifactRevision: string,
): Promise<LegacyMigration[]> {
  const migrations: LegacyMigration[] = [];
  for (const card of cards) {
    if (!card.referenceImage || !manifest.characters[card.id]) continue;
    const image = parseLegacyImage(card.referenceImage);
    if (!hasSupportedImageSignature(image.dataB64)) throw new Error(`Legacy character reference is not a supported image: ${card.id}`);
    const canonicalPath = canonicalCharacterReferencePath(card.id, image.mime);
    const existingRelativePath = card.referenceImagePath
      ?? manifest.characters[card.id].sourceReferencePath
      ?? canonicalPath;
    const existingPath = visualBibleArtifactPath(artifactDir, existingRelativePath);
    const existingPathExists = await tauri.pathExists(existingPath).catch(() => false);
    const relativePath = existingPathExists
      ? existingRelativePath
      : revisionedArtifactPath(canonicalPath, artifactRevision);
    const destination = visualBibleArtifactPath(artifactDir, relativePath);
    if (existingPathExists) {
      const existing = (await tauri.readFileBase64(destination)).replace(/\s+/g, "");
      if (existing !== image.dataB64) throw new Error(`Legacy character reference conflict: ${card.id}`);
    } else {
      await tauri.writeFileBase64(destination, image.dataB64);
    }
    if (!(await tauri.pathExists(destination).catch(() => false))
      || (await tauri.readFileBase64(destination)).replace(/\s+/g, "") !== image.dataB64) {
      throw new Error(`Failed to migrate character reference: ${card.id}`);
    }
    manifest.characters[card.id].sourceReferencePath = relativePath;
    const sourceRevision = Math.max(1, characterSourceRevision(manifest.characters[card.id]));
    manifest.characters[card.id].sourceRevision = sourceRevision;
    if (manifest.characters[card.id].sheetSourceRevision === undefined) {
      manifest.characters[card.id].sheetSourceRevision = sourceRevision;
    }
    migrations.push({ card, relativePath });
  }
  return migrations;
}

function cloneVisualBible(bible: ProjectVisualBible): ProjectVisualBible {
  return {
    ...bible,
    ...(bible.pendingInvalidation ? { pendingInvalidation: clonePendingInvalidation(bible.pendingInvalidation) } : {}),
    ...(bible.cacheBinding ? { cacheBinding: cloneCacheBinding(bible.cacheBinding) } : {}),
    characters: Object.fromEntries(Object.entries(bible.characters).map(([id, character]) => [id, {
      ...character,
      ...(character.actionIds ? { actionIds: [...character.actionIds] } : {}),
    }])),
  };
}

function syncVisualBible(target: ProjectVisualBible, source: ProjectVisualBible): void {
  target.version = source.version;
  target.status = source.status;
  target.styleSource = source.styleSource;
  target.styleDescription = source.styleDescription;
  target.styleReferencePath = source.styleReferencePath;
  target.characters = Object.fromEntries(Object.entries(source.characters).map(([id, character]) => [id, {
    ...character,
    ...(character.actionIds ? { actionIds: [...character.actionIds] } : {}),
  }]));
  target.inputFingerprint = source.inputFingerprint;
  if (source.pendingInvalidation) target.pendingInvalidation = clonePendingInvalidation(source.pendingInvalidation);
  else delete target.pendingInvalidation;
  if (source.cacheBinding) target.cacheBinding = cloneCacheBinding(source.cacheBinding);
  else delete target.cacheBinding;
  if (source.approvedAt) target.approvedAt = source.approvedAt;
  else delete target.approvedAt;
}

async function mutateAndPublishVisualBible(
  outputDir: string,
  work: (artifactDir: string, artifactRevision: string) => Promise<VisualBibleMutation>,
  syncTarget?: ProjectVisualBible,
): Promise<ProjectVisualBible> {
  const queueKey = normalizePath(outputDir).replace(/\/$/, "");
  const previousPublish = visualBiblePublishQueues.get(queueKey);
  const runPublish = async (): Promise<ProjectVisualBible> => {
    const recoveryWarnings = await recoverVisualBibleStorage(outputDir);
    const unresolvedRecovery = recoveryWarnings.filter((warning) => !warning.startsWith("Recovered"));
    if (unresolvedRecovery.length > 0) throw new Error(unresolvedRecovery.join("; "));
    if (syncTarget) validateCharacterAssetKeys(characterCardsFromVisualBible(syncTarget));
    return publishVisualBibleMutation(outputDir, work, syncTarget);
  };
  const currentPublish = previousPublish?.then(runPublish, runPublish) ?? runPublish();
  visualBiblePublishQueues.set(queueKey, currentPublish);
  try {
    return await currentPublish;
  } finally {
    if (visualBiblePublishQueues.get(queueKey) === currentPublish) visualBiblePublishQueues.delete(queueKey);
  }
}

async function publishVisualBibleMutation(
  outputDir: string,
  work: (artifactDir: string, artifactRevision: string) => Promise<VisualBibleMutation>,
  syncTarget?: ProjectVisualBible,
): Promise<ProjectVisualBible> {
  const artifactDir = visualBibleDir(outputDir);
  await tauri.mkdirAll(artifactDir);
  const artifactRevision = `${Date.now().toString(36)}-${++artifactSequence}`;
  const mutation = await work(artifactDir, artifactRevision);
  const manifest = manifestForSave(mutation.bible);
  syncManifestActionIds(manifest, mutation.cards ?? []);
  const migrations = await prepareLegacyMigrations(
    artifactDir,
    manifest,
    mutation.cards ?? [],
    artifactRevision,
  );
  const canonicalManifest = manifestForSave(manifest);
  await writeManifestAtomically(artifactDir, canonicalManifest);
  for (const migration of migrations) {
    migration.card.referenceImagePath = migration.relativePath;
    delete migration.card.referenceImage;
  }
  if (syncTarget) syncVisualBible(syncTarget, canonicalManifest);
  await mutation.afterPublish?.();
  return canonicalManifest;
}

function syncManifestActionIds(manifest: ProjectVisualBible, cards: CharacterCard[]): void {
  for (const card of cards) {
    const character = manifest.characters[card.id];
    if (!character) continue;
    const actionIds = productionActionIds(card);
    if (actionIds.length > 0) character.actionIds = actionIds;
    else delete character.actionIds;
  }
}

async function writeManifestAtomically(artifactDir: string, bible: ProjectVisualBible): Promise<void> {
  const manifestPath = visualBibleArtifactPath(artifactDir, "visual-bible.json");
  const temporaryManifestPath = `${manifestPath}.tmp`;
  await tauri.writeTextFile(temporaryManifestPath, JSON.stringify(bible, null, 2));
  await tauri.replacePath(temporaryManifestPath, manifestPath);
}

export async function saveVisualBible(
  outputDir: string,
  bible: ProjectVisualBible,
  cards: CharacterCard[] = [],
): Promise<void> {
  validateCharacterAssetKeys(cards.length > 0 ? cards : characterCardsFromVisualBible(bible));
  await mutateAndPublishVisualBible(outputDir, async () => ({
    bible: cloneVisualBible(bible),
    cards,
  }), bible);
}

function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function imagePayloadHash(imageB64: string): string {
  const payload = parseLegacyImage(imageB64).dataB64;
  return stableHash(payload);
}

async function readCharacterReferencePayloads(
  artifactDir: string,
  characters: Record<string, VisualBibleCharacter>,
): Promise<Record<string, string>> {
  const payloads: Record<string, string> = {};
  const withReferences = Object.entries(characters).filter(([, character]) => character.sourceReferencePath);
  await Promise.all(withReferences.map(async ([characterId, character]) => {
    payloads[characterId] = await tauri.readFileBase64(
      visualBibleArtifactPath(artifactDir, character.sourceReferencePath!),
    );
  }));
  return payloads;
}

export function computeVisualBibleFingerprint(input: VisualBibleFingerprintInput): string {
  const chapters = input.novel.chapters
    .filter((chapter) => chapter.enabled !== false)
    .sort((a, b) => a.index - b.index)
    .map((chapter) => ({ index: chapter.index, text: chapter.text.replace(/\r\n/g, "\n") }));
  const characters = input.characters
    .map((character) => ({
      id: character.id,
      imagePrompt: normalizeStyleDescription(character.imagePrompt),
      threeViewPrompt: normalizeStyleDescription(character.threeViewPrompt ?? ""),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sourceReferenceHash = input.sourceReferenceB64 ? imagePayloadHash(input.sourceReferenceB64) : "";
  const characterReferenceHashes = Object.entries(input.characterReferenceB64 ?? {})
    .map(([characterId, payload]) => ({ characterId, hash: imagePayloadHash(payload) }))
    .sort((a, b) => a.characterId.localeCompare(b.characterId));
  return `v1-${stableHash(JSON.stringify({
    chapters,
    characters,
    styleSource: input.styleSource,
    styleDescription: normalizeStyleDescription(input.styleDescription),
    sourceReferenceHash,
    characterReferenceHashes,
  }))}`;
}

export async function computeProjectVisualBibleFingerprint(
  outputDir: string,
  bible: Pick<ProjectVisualBible, "styleSource" | "styleDescription" | "styleReferencePath" | "characters">,
  novel: NovelDoc,
  characters: CharacterCard[],
): Promise<string> {
  const sourceReferenceB64 = bible.styleSource === "reference_image"
    ? await tauri.readFileBase64(visualBiblePath(outputDir, bible.styleReferencePath))
    : undefined;
  const characterReferenceB64: Record<string, string> = {};
  for (const card of characters) {
    const sourcePath = bible.characters[card.id]?.sourceReferencePath ?? card.referenceImagePath;
    if (sourcePath) {
      characterReferenceB64[card.id] = await tauri.readFileBase64(visualBiblePath(outputDir, sourcePath));
    } else if (card.referenceImage) {
      characterReferenceB64[card.id] = parseLegacyImage(card.referenceImage).dataB64;
    }
  }
  return computeVisualBibleFingerprint({
    novel,
    characters,
    styleSource: bible.styleSource,
    styleDescription: bible.styleDescription,
    sourceReferenceB64,
    characterReferenceB64,
  });
}

export function assertVisualBibleApprovalStatus(
  bible: ProjectVisualBible | null | undefined,
): asserts bible is ProjectVisualBible {
  if (!bible || bible.status !== "approved" || !bible.inputFingerprint) {
    throw new VisualBibleApprovalRequiredError();
  }
}

export async function assertVisualBibleReadyForImages(
  outputDir: string,
  bible: ProjectVisualBible | null | undefined,
  novel: NovelDoc,
  characters: CharacterCard[],
): Promise<void> {
  assertVisualBibleApprovalStatus(bible);
  let currentFingerprint: string;
  try {
    currentFingerprint = await computeProjectVisualBibleFingerprint(outputDir, bible, novel, characters);
  } catch (error) {
    if (error instanceof ReferenceImageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReferenceImageError(`Visual-bible fingerprint reference could not be read: ${message}`, "REFERENCE_MISSING");
  }
  if (currentFingerprint === bible.inputFingerprint) return;
  await refreshVisualBibleFingerprint(outputDir, bible, currentFingerprint, characters);
  throw new VisualBibleApprovalRequiredError("小说、角色或风格输入已经变化，视觉圣经已标记为失效");
}

export async function validateVisualBibleForApproval(
  outputDir: string,
  bible: ProjectVisualBible,
  mainCharacterIds: string[],
): Promise<VisualBibleApprovalResult> {
  const errors: string[] = [];
  if (!normalizeStyleDescription(bible.styleDescription)) errors.push("Style description is empty");
  const styleError = await validateImageArtifact(outputDir, bible.styleReferencePath, "Style reference");
  if (styleError) errors.push(styleError);
  for (const id of [...new Set(mainCharacterIds)].sort()) {
    const character = bible.characters[id];
    if (!character) {
      errors.push(`Character ${id} is missing from the visual bible`);
      continue;
    }
    if (!character.approved) errors.push(`Character ${id} has not been accepted`);
    if (characterSourceRevision(character) !== characterSheetSourceRevision(character)) {
      errors.push(`Character ${id} three-view does not match the current source revision`);
    }
    const sheetError = await validateImageArtifact(outputDir, character.threeViewPath, `Character ${id} three-view`);
    if (sheetError) errors.push(sheetError);
    if (character.sourceReferencePath) {
      const sourceError = await validateImageArtifact(
        outputDir,
        character.sourceReferencePath,
        `Character ${id} source reference`,
      );
      if (sourceError) errors.push(sourceError);
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function approveVisualBible(
  outputDir: string,
  bible: ProjectVisualBible,
  request: VisualBibleApprovalRequest,
): Promise<ProjectVisualBible> {
  validateCharacterAssetKeys(request.characters);
  await mutateAndPublishVisualBible(outputDir, async () => {
    let currentFingerprint: string;
    try {
      currentFingerprint = await computeProjectVisualBibleFingerprint(
        outputDir,
        bible,
        request.novel,
        request.characters,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return staleRejectedMutation(bible, `Visual bible fingerprint could not be computed: ${message}`);
    }
    if (!bible.inputFingerprint || bible.inputFingerprint !== currentFingerprint) {
      return staleRejectedMutation(bible, "Visual bible fingerprint is empty or stale; refresh the draft before approval");
    }
    const validation = await validateVisualBibleForApproval(
      outputDir,
      bible,
      request.characters.map((character) => character.id),
    );
    if (!validation.valid) {
      return staleRejectedMutation(bible, `Visual bible cannot be approved: ${validation.errors.join("; ")}`);
    }
    const approved = cloneVisualBible(bible);
    const pendingInvalidation = approved.pendingInvalidation ?? { scope: "global" as const };
    approved.status = "approved";
    approved.inputFingerprint = currentFingerprint;
    approved.approvedAt = (request.now ?? (() => new Date().toISOString()))();
    approved.cacheBinding = cacheBindingAfterApproval(approved, pendingInvalidation, currentFingerprint);
    delete approved.pendingInvalidation;
    return {
      bible: approved,
      cards: request.characters,
      afterPublish: pendingInvalidation.scope === "global"
        ? () => invalidateGlobalCaches(outputDir)
        : () => invalidateCharacterScopes(outputDir, bible, request.characters, pendingInvalidation.characterIds),
    };
  }, bible);
  return bible;
}

function staleRejectedMutation(bible: ProjectVisualBible, message: string): VisualBibleMutation {
  const stale = cloneVisualBible(bible);
  stale.status = "stale";
  delete stale.approvedAt;
  return {
    bible: stale,
    afterPublish: async () => { throw new Error(message); },
  };
}

export async function refreshVisualBibleFingerprint(
  outputDir: string,
  bible: ProjectVisualBible,
  currentFingerprint: string,
  characters: CharacterCard[],
  preservePendingScope = false,
): Promise<ProjectVisualBible> {
  await mutateAndPublishVisualBible(outputDir, async () => {
    const refreshed = cloneVisualBible(bible);
    if (refreshed.inputFingerprint && refreshed.inputFingerprint !== currentFingerprint) {
      if (refreshed.status === "approved") {
        refreshed.status = "stale";
        delete refreshed.approvedAt;
      }
      if (preservePendingScope) {
        if (!refreshed.pendingInvalidation || refreshed.pendingInvalidation.scope === "global") {
          refreshed.pendingInvalidation = { scope: "global" };
        }
      } else {
        refreshed.pendingInvalidation = { scope: "global" };
      }
    }
    refreshed.inputFingerprint = currentFingerprint;
    return { bible: refreshed, cards: characters };
  }, bible);
  return bible;
}

async function readAssetMap(outputDir: string): Promise<{ map: AssetMap; exists: boolean }> {
  const path = `${normalizePath(outputDir).replace(/\/$/, "")}/.novel2vn/assets.json`;
  if (!(await tauri.pathExists(path))) {
    return { map: { ...DEFAULT_ASSET_MAP, bg: {}, cg: {}, figure: {}, item: {}, vocal: {} }, exists: false };
  }
  const { text } = await tauri.readTextFile(path);
  return { map: { ...DEFAULT_ASSET_MAP, ...JSON.parse(text) as AssetMap }, exists: true };
}

async function writeAssetMap(outputDir: string, map: AssetMap, exists: boolean): Promise<void> {
  if (!exists) return;
  const path = `${normalizePath(outputDir).replace(/\/$/, "")}/.novel2vn/assets.json`;
  await tauri.writeTextFile(path, JSON.stringify(map, null, 2));
}

async function removeCachedImages(outputDir: string, predicate: (name: string) => boolean): Promise<void> {
  const imageDir = `${normalizePath(outputDir).replace(/\/$/, "")}/.novel2vn/cache/images`;
  if (!(await tauri.pathExists(imageDir))) return;
  const entries = await tauri.listDir(imageDir);
  for (const entry of entries) {
    if (!entry.isDir && predicate(entry.name)) await tauri.removePath(entry.path);
  }
}

function markChanged(bible: ProjectVisualBible): void {
  if (bible.status === "approved") bible.status = "stale";
  delete bible.approvedAt;
}

function markGlobalBibleChanged(bible: ProjectVisualBible): void {
  for (const character of Object.values(bible.characters)) character.approved = false;
  bible.pendingInvalidation = { scope: "global" };
  markChanged(bible);
}

function markCharacterBibleChanged(bible: ProjectVisualBible, characterId: string): void {
  bible.cacheBinding ??= cacheBindingFromBible(bible, bible.inputFingerprint);
  const character = bible.characters[characterId];
  if (character) {
    character.approved = false;
    character.revision += 1;
  }
  if (bible.pendingInvalidation?.scope !== "global") {
    const characterIds = new Set(bible.pendingInvalidation?.characterIds ?? []);
    characterIds.add(characterId);
    bible.pendingInvalidation = { scope: "characters", characterIds: [...characterIds].sort() };
  }
  markChanged(bible);
}

function cacheBindingFromBible(bible: ProjectVisualBible, globalFingerprint: string): VisualBibleCacheBinding {
  return {
    globalFingerprint,
    characterRevisions: Object.fromEntries(
      Object.entries(bible.characters).map(([characterId, character]) => [characterId, character.revision]),
    ),
  };
}

function cacheBindingAfterApproval(
  bible: ProjectVisualBible,
  pending: VisualBiblePendingInvalidation,
  currentFingerprint: string,
): VisualBibleCacheBinding {
  const globalFingerprint = pending.scope === "characters" && bible.cacheBinding
    ? bible.cacheBinding.globalFingerprint
    : currentFingerprint;
  return cacheBindingFromBible(bible, globalFingerprint);
}

async function invalidateCharacterScopes(
  outputDir: string,
  bible: ProjectVisualBible,
  characters: CharacterCard[],
  characterIds: string[],
): Promise<void> {
  const cardsById = new Map(characters.map((character) => [character.id, character]));
  for (const characterId of characterIds) {
    const character = cardsById.get(characterId);
    if (!character) throw new Error(`Character is missing from approval request: ${characterId}`);
    await invalidateCharacterCaches(outputDir, characterWithHistoricalActions(bible, character));
  }
}

function characterOwnedImageTasks(character: CharacterCard): { assetIds: Set<string>; fileNames: Set<string> } {
  const actions = character.actions ?? [];
  const actionBatches = actions.length > 0
    ? Array.from({ length: Math.ceil(actions.length / 4) }, (_, index) => actions.slice(index * 4, index * 4 + 4))
    : [[]];
  const tasks = actionBatches.flatMap((actionBatch) => characterImageTasks({ ...character, actions: actionBatch }));
  return {
    assetIds: new Set(tasks.map((task) => task.id)),
    fileNames: new Set(tasks.map((task) => task.fileName)),
  };
}

async function invalidateGlobalCaches(outputDir: string): Promise<void> {
  await removeCachedImages(outputDir, () => true);
  const assets = await readAssetMap(outputDir);
  await writeAssetMap(outputDir, { bg: {}, cg: {}, figure: {}, item: {}, vocal: assets.map.vocal ?? {} }, assets.exists);
}

async function invalidateCharacterCaches(
  outputDir: string,
  character: CharacterCard,
): Promise<void> {
  const owned = characterOwnedImageTasks(character);
  await removeCachedImages(outputDir, (name) => owned.fileNames.has(name));
  const assets = await readAssetMap(outputDir);
  assets.map.figure = Object.fromEntries(
    Object.entries(assets.map.figure).filter(([assetId]) => !owned.assetIds.has(assetId)),
  );
  await writeAssetMap(outputDir, assets.map, assets.exists);
}

export async function invalidateGlobalVisualAssets(outputDir: string, bible: ProjectVisualBible): Promise<void> {
  await mutateAndPublishVisualBible(outputDir, async () => {
    const next = cloneVisualBible(bible);
    markGlobalBibleChanged(next);
    return { bible: next, afterPublish: () => invalidateGlobalCaches(outputDir) };
  }, bible);
}

export async function invalidateCharacterVisualAssets(
  outputDir: string,
  bible: ProjectVisualBible,
  character: CharacterCard,
): Promise<void> {
  const characterId = character.id;
  const invalidationCharacter = characterWithHistoricalActions(bible, character);
  validateCharacterAssetKeys(characterCardsFromVisualBible(bible, character));
  await mutateAndPublishVisualBible(outputDir, async () => {
    if (!bible.characters[characterId]) throw new Error(`Character is missing from visual bible: ${characterId}`);
    const next = cloneVisualBible(bible);
    markCharacterBibleChanged(next, characterId);
    return { bible: next, cards: [character], afterPublish: () => invalidateCharacterCaches(outputDir, invalidationCharacter) };
  }, bible);
}
