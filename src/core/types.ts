export interface ApiConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extra?: Record<string, unknown>;
}

export interface ApiChannel {
  llm: ApiConfig[];
  image: ApiConfig[];
  tts: ApiConfig[];
}

export type ChannelKey = "llm" | "image" | "tts";

export interface ApiPreset {
  id: string;
  name: string;
  channels: ApiChannel;
  active: Record<ChannelKey, string>;
}

export interface CostStats {
  llmTokens: number;
  imageCount: number;
  ttsChars: number;
  llmCostYuan: number;
  imageCostYuan: number;
  ttsCostYuan: number;
}

export interface CharacterCard {
  id: string;
  name: string;
  appearance: string;
  clothing: string;
  personality: string;
  voiceDesc: string;
  voiceName?: string;
  imagePrompt: string;
  referenceImage?: string;
  color: string;
}

export interface SceneCard {
  id: string;
  location: string;
  atmosphere: string;
  time: string;
  imagePrompt: string;
}

export interface ItemCard {
  id: string;
  name: string;
  appearance: string;
  note: string;
  imagePrompt: string;
}

export interface ExtractionResult {
  title: string;
  characters: CharacterCard[];
  scenes: SceneCard[];
  items: ItemCard[];
}

export interface ChapterInfo {
  index: number;
  title: string;
  text: string;
  charCount: number;
  enabled?: boolean;
}

export interface DialogueLine {
  type: "dialogue";
  characterId: string;
  text: string;
  emotion?: string;
}

export interface NarrationLine {
  type: "narration";
  text: string;
  monologue?: boolean;
}

export interface CgEvent {
  triggerIndex: number;
  title: string;
  description: string;
  imagePrompt: string;
  videoSuggestion?: VideoSuggestion;
}

export interface VideoSuggestion {
  id: string;
  title: string;
  description: string;
  videoPrompt: string;
  durationSecs: number;
}

export interface ItemEvent {
  triggerIndex: number;
  itemId: string;
  action: "obtain" | "exchange" | "show" | "key";
  description: string;
}

export type Line = DialogueLine | NarrationLine;

export interface SceneJSON {
  id: string;
  location: string;
  atmosphere: string;
  time: string;
  bgPrompt: string;
  bgFile?: string;
  cgEvent?: CgEvent;
  cgFile?: string;
  chapterOf?: number;
  itemEvents: ItemEvent[];
  lines: Line[];
  figures: string[];
  bgm?: string;
  videoPoints?: VideoSuggestion[];
}

export interface ChapterScript {
  chapter: number;
  title: string;
  scenes: SceneJSON[];
}

export interface ImageTask {
  kind: "figure" | "background" | "cg" | "item";
  id: string;
  prompt: string;
  referenceImage?: string;
  emotion?: string;
  refFromTask?: string;
  fileName: string;
  width: number;
  height: number;
  usage?: string;
}

export interface ProjectMeta {
  title: string;
  gameKey: string;
  chapterCount: number;
  charCount: number;
  sceneCount: number;
  lineCount: number;
  outputDir: string;
  webgalVersion: string;
  generatedAt: string;
}

export interface PipelineResult {
  meta: ProjectMeta;
  cards: ExtractionResult;
  chapters: ChapterScript[];
  assets: unknown;
  cost: CostStats;
}

export interface MaterialAsset {
  name: string;
  path: string;
  kind: "character" | "item" | "background";
  mime: string;
  extra?: { mapTo?: string };
}

export interface NovelDoc {
  fileName: string;
  sourcePath: string;
  encoding: string;
  fullText: string;
  chapters: ChapterInfo[];
}

export interface GenerationOptions {
  useImage: boolean;
  useTts: boolean;
  useVideoPoints: boolean;
  useBgm: boolean;
  figureEmotions: boolean;
  imageBudgetPerChapter: number;
  cgPerChapter: number;
  skipCache: boolean;
  maxConcurrent: number;
  videoPointsPerChapter: number;
  characterIntroCard: boolean;
  rerunChapters?: number[];
}

export interface PipelineEvent {
  step: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
  at: number;
  costDelta?: Partial<CostStats>;
}

export type LogSink = (ev: PipelineEvent) => void;
