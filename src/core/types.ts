export interface ApiConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 通用适配器模板 id（见 api/templates.ts）；空 = 兼容旧配置（OpenAI 兼容直连） */
  adapter?: string;
  extra?: Record<string, unknown>;
}

export interface ApiChannel {
  llm: ApiConfig[];
  vision: ApiConfig[];
  image: ApiConfig[];
  tts: ApiConfig[];
}

export type ChannelKey = "llm" | "vision" | "image" | "tts";

export type ApiProtocol =
  | "openai-chat"
  | "openai-image"
  | "openai-speech"
  | "siliconflow-image"
  | "siliconflow-speech"
  | "minimax-image"
  | "minimax-speech"
  | "custom-json";

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

/** 角色动作（基于三视图图生图生成，保证形象一致） */
export interface CharacterAction {
  id: string;
  name: string;
  /** 该动作的英文图像提示词（含角色外观描述 + 动作姿态） */
  prompt: string;
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
  /** 三视图（正/侧/背）角色设定图 prompt；用于生成三视图参考图，并作为立绘/表情/动作的图生图参考 */
  threeViewPrompt?: string;
  /** 该角色的动作立绘列表（如 拔剑/挥手/抱臂），基于三视图生成 */
  actions?: CharacterAction[];
  /** Legacy inline image payload. Read during migration, but never write to new project JSON. */
  referenceImage?: string;
  /** Project-local character reference path used by current code. */
  referenceImagePath?: string;
  color: string;
}

export type VisualBibleStatus = "draft" | "approved" | "stale";
export type StyleSource = "reference_image" | "novel_analysis";
export type ImageReferenceRole = "identity" | "style" | "structure";

export interface ImageReference {
  role: ImageReferenceRole;
  dataB64: string;
  mime: string;
  sourcePath?: string;
  required?: boolean;
}

export interface ImageModelCapabilities {
  maxReferenceImages: number;
  supportsSeed: boolean;
  supportsImageEdit: boolean;
  referenceEncoding: "raw-base64" | "data-url";
}

export interface VisualBibleCharacter {
  sourceReferencePath?: string;
  threeViewPath: string;
  prompt: string;
  /** Action IDs used by production image-task naming. Stored so reload can revalidate collisions. */
  actionIds?: string[];
  approved: boolean;
  revision: number;
  /** Revision of the current uploaded identity source. Missing means a legacy manifest. */
  sourceRevision?: number;
  /** Source revision used to generate the current three-view sheet. */
  sheetSourceRevision?: number;
}

export type VisualBiblePendingInvalidation =
  | { scope: "global" }
  | { scope: "characters"; characterIds: string[] };

export interface VisualBibleCacheBinding {
  globalFingerprint: string;
  characterRevisions: Record<string, number>;
}

export interface ProjectVisualBible {
  version: 1;
  status: VisualBibleStatus;
  styleSource: StyleSource;
  styleDescription: string;
  styleReferencePath: string;
  characters: Record<string, VisualBibleCharacter>;
  inputFingerprint: string;
  pendingInvalidation?: VisualBiblePendingInvalidation;
  cacheBinding?: VisualBibleCacheBinding;
  approvedAt?: string;
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
  /** 台词对应的角色动作（引用角色卡的 actions 列表，如 "point"/"wave"）；渲染时切换对应动作立绘 */
  action?: string;
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

/** 剧情分支选项：出现在场景末尾，玩家选择不同选项进入不同的小分支，随后合并 */
export interface Choice {
  id: string;
  /** 选项按钮文本 */
  prompt: string;
  /** 该分支下的剧情（对话/旁白），渲染为 label 块 */
  lines: Line[];
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
  /** 剧情分支：场景末尾弹出选择，各选项进入独立小分支后合并 */
  choices?: Choice[];
  bgm?: string;
  videoPoints?: VideoSuggestion[];
}

export interface ChapterScript {
  chapter: number;
  title: string;
  scenes: SceneJSON[];
}

export interface ImageTask {
  kind: "figure" | "background" | "cg" | "item" | "threeview" | "action" | "anchor";
  id: string;
  characterId?: string;
  prompt: string;
  references?: ImageReference[];
  emotion?: string;
  /** 该动作对应的角色动作 id（仅 kind=action） */
  actionId?: string;
  refFromTask?: string;
  fileName: string;
  width: number;
  height: number;
  usage?: string;
  /** 确定性种子（用于同一项目多次生成保持风格稳定） */
  seed?: number;
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
  /** AI 分章产生的章节列表（分章阶段运行时填充，供 UI 展示/勾选重跑） */
  splitChapters?: ChapterInfo[];
  assets: unknown;
  cost: CostStats;
  failedTasks: FailedTask[];
}

/** 管线执行阶段：可单独运行/重生成 */
export type StageKey = "split" | "translate" | "extract" | "script" | "image" | "voice" | "assemble";

export const STAGE_LABELS: Record<StageKey, string> = {
  split: "分章",
  translate: "翻译",
  extract: "提取",
  script: "剧本",
  image: "图像",
  voice: "配音",
  assemble: "组装",
};

export const STAGE_ORDER: StageKey[] = ["split", "translate", "extract", "script", "image", "voice", "assemble"];

/** 可选的目标语言（把小说翻译成该语言后再提取/剧本/生成） */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: "zh_CN", label: "简体中文" },
  { code: "zh_TW", label: "繁體中文" },
  { code: "en", label: "English（英文）" },
  { code: "ja", label: "日本語（日文）" },
  { code: "ko", label: "한국어（韩文）" },
];

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/** 已生成素材文件映射（.novel2vn/assets.json），供分阶段运行/组装单独执行时复用 */
export interface AssetMap {
  bg: Record<string, string>;
  cg: Record<string, string>;
  figure: Record<string, string>;
  item: Record<string, string>;
  vocal: Record<string, string>;
}

/** 每个阶段的「重生成意见」，在重跑该阶段时注入给 LLM */
export interface StageFeedback {
  split?: string;
  translate?: string;
  extract?: string;
  script?: Record<number, string>;
  image?: string;
  voice?: string;
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
  /** 多文件合并导入时记录全部源文件路径（用于项目恢复重新读取） */
  sourcePaths?: string[];
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
  /** 人物动作：入场/退场动画、情绪动作、剧情镜头震动 */
  figureActions: boolean;
  /** 角色三视图 + 动作立绘（先生成三视图，再基于它图生图生成默认/表情/动作立绘） */
  characterPoses: boolean;
  /** 生成后用多模态模型自检图片（核对描述/无畸形），不合格自动重生成 1 次 */
  imageSelfCheck: boolean;
  imageBudgetPerChapter: number;
  cgPerChapter: number;
  skipCache: boolean;
  maxConcurrent: number;
  videoPointsPerChapter: number;
  characterIntroCard: boolean;
  budgetYuan: number;
  /** 统一画风描述（英文/中文均可），用于让所有立绘/背景/CG 保持同一画风；留空使用默认画风 */
  imageStyle?: string;
  /** 图片固定种子：0=按小说标题自动派生（同一种子生成结果更稳定一致，利于统一画风） */
  imageSeed?: number;
  /** 风格锚点：先生成一张全项目风格基准图，再作为背景/CG 的参考图强制统一画风 */
  styleAnchor?: boolean;
  /** 剧本文风描述（如"古风典雅""幽默风趣"），LLM 按此风格改写台词与旁白；留空不调整 */
  scriptStyle?: string;
  /** 目标语言（如 en/ja），把小说翻译成该语言后再生成；空 = 使用原文 */
  language?: string;
  rerunChapters?: number[];
}

export interface PipelineEvent {
  step: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
  at: number;
  costDelta?: Partial<CostStats>;
  taskId?: string;
  taskKind?: "llm" | "image" | "tts" | "script";
  /** 实时进度（如 图片 12/45）：done/total + 当前生成内容 label */
  progress?: { done: number; total: number; label: string };
}

export interface FailedTask {
  id: string;
  kind: "llm" | "image" | "tts" | "script";
  step: string;
  message: string;
  at: number;
}

export interface ExportSettings {
  title: string;
  gameKey: string;
  language: "zh_CN" | "zh_TW" | "en" | "ja";
}

export type LogSink = (ev: PipelineEvent) => void;
