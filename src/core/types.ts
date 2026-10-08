export interface ApiConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 通用适配器模板 id（见 api/templates.ts）；空 = 兼容旧配置（OpenAI 兼容直连） */
  adapter?: string;
  /**
   * 通道级扩展配置（任意键，程序按需读取）。已使用键：
   * - `contextLength?: number`：手动覆盖上下文窗口 token（见 resolveContextLength）
   * - `maxOutputTokens?: number`：单次请求最大输出 token（默认 32768，见 resolveMaxOutputTokens）；
   *   思考型模型把「思考 + 最终回答」一起计入该预算，需要生成超长章节时调大。
   * - `disableThinking?: boolean`：关闭深度思考（请求体顶层 `thinking: { type: "disabled" }`）。
   *   该字段非 OpenAI 标准，默认不发送，只对支持它的厂商（如小米 MiMo）生效。
   */
  extra?: Record<string, unknown>;
  /** 该 API 的批量生成并发数（图像/配音等）；留空用通道默认值，各 API 互不影响 */
  concurrency?: number;
}

interface ApiChannel {
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

/** 用量统计（API 返回的事实数据，不依赖价格估算） */
export interface CostStats {
  llmTokens: number;
  imageCount: number;
  ttsChars: number;
  llmCostYuan: number;
  imageCostYuan: number;
  ttsCostYuan: number;
}

/** 服装差分（基于三视图图生图生成，供剧情换装与鉴赏室使用） */
export interface CharacterCostume {
  id: string;
  name: string;
  /** 该服装的英文图像提示词（含角色外观 + 服装描述） */
  prompt: string;
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
  /** 角色性别：AI 提取时按性别分配音色；male/female 用于从音色库过滤 */
  gender?: "male" | "female";
  /** Global cloned-voice profile. When present it takes precedence over voiceName. */
  voiceProfileId?: string;
  imagePrompt: string;
  /** 三视图（正/侧/背）角色设定图 prompt；用于生成三视图参考图，并作为立绘/表情/动作的图生图参考 */
  threeViewPrompt?: string;
  /** 该角色的动作立绘列表（如 拔剑/挥手/抱臂），基于三视图生成 */
  actions?: CharacterAction[];
  /** 服装差分列表（如 日常服/礼服/战斗服），由 AI 按剧情决定数量、不设上限；每套生成 normal 立绘供换装 */
  costumes?: CharacterCostume[];
  /** 自定义表情集（由 AI 按剧情决定，不设上限；缺省使用标准 5 表情） */
  emotions?: string[];
  /** 是否为次要角色/NPC（有台词但戏份少）；auto 档位下据此给该角色精简图片预算 */
  isNpc?: boolean;
  /** 图片档位（立绘/表情/服装/动作的预算）：缺省 auto=按 isNpc 判定；显式设置覆盖自动判定 */
  figureTier?: FigureTierSetting;
  /**
   * 剧本实际使用情况（剧本阶段统计后写回卡片）：表情/服装/动作的**按需出图**依据。
   * 三个数组都是「剧本里真的用到 + 按使用次数降序 + 已过滤到卡片内合法 id」。
   * 实测某 30 章项目：表情 160 张里 115 张、服装 80 张里 73 张从未被任何台词引用；
   * 反向还有 69 处台词标注的动作没生成（生成端只取卡面前 2 个）。
   * 缺省 = 还没有剧本（按卡片顺序 + 档位预算出图，与旧行为一致）。
   */
  imageUsage?: CharacterImageUsage;
  /** Legacy inline image payload. Read during migration, but never write to new project JSON. */
  referenceImage?: string;
  /** Project-local character reference path used by current code. */
  referenceImagePath?: string;
  color: string;
}

type VoiceProfileStatus = "ready" | "creating" | "error";

export interface VoiceProfile {
  id: string;
  name: string;
  provider: "minimax";
  ttsConfigId: string;
  voiceId: string;
  status: VoiceProfileStatus;
  referenceAudioPath?: string;
  consentConfirmedAt?: string;
  error?: string;
  revision: number;
  createdAt: string;
}

type VisualBibleStatus = "draft" | "approved" | "stale";
export type StyleSource = "reference_image" | "novel_analysis";
type ImageReferenceRole = "identity" | "style" | "structure";

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

/** 单套服装的独立三视图锚点：以默认装三视图为身份参考生成，换装立绘以此为图生图参考 */
export interface VisualBibleCostumeSheet {
  /** 该服装三视图的存储路径（相对 .novel2vn/visual-bible/） */
  threeViewPath: string;
  /** 生成该服装三视图用的英文 prompt（= 该服装的 prompt） */
  prompt: string;
  revision: number;
  approved: boolean;
}

export interface VisualBibleCharacter {
  sourceReferencePath?: string;
  threeViewPath: string;
  prompt: string;
  /** 每套服装的独立三视图锚点（换装立绘以此为图生图参考，保证换装后身份/服装一致） */
  costumeSheets?: Record<string, VisualBibleCostumeSheet>;
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

/**
 * 视觉输入签名：出图相关输入按「画风 + 逐角色」拆开的哈希（口径与
 * computeVisualBibleFingerprint 一致，但不含小说正文/分章）。
 *
 * 批准时记录到 ProjectVisualBible.visualInputs，作为「现存图片是按哪些输入画出来的」基线：
 * 之后指纹变化时用它判断是真有画图输入变了（→ 判废对应范围），还是只是小说正文/分章变了
 * （→ 一张图都不该删）。
 */
export interface VisualInputSignature {
  style: string;
  characters: Record<string, string>;
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
  /** 上次批准时记下的视觉输入签名；缺失（旧项目/未批准）时不做指纹推断，只认显式作废范围。 */
  visualInputs?: VisualInputSignature;
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
  /** 台词时角色所穿服装（引用角色卡的 costumes 列表 id）；换装后持续有效直到再次标注，渲染时切换对应服装立绘 */
  costume?: string;
  /** 配音语速（0.5-2，MiniMax 取值；缺省用全局 TTS 配置默认值）。AI 生成剧本时按语气自动标注 */
  speed?: number;
  /** 配音情绪（如 happy/sad/angry/calm/whisper/surprised），传给 TTS 合成；缺省用全局配置默认值 */
  ttsEmotion?: string;
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
  /** 本场景出场角色 id（角色卡 id，含背景人物/路人；不含 narrator）。图像阶段按此锁定人物一致性 */
  figures: string[];
  /** 剧情分支：场景末尾弹出选择，各选项进入独立小分支后合并 */
  choices?: Choice[];
  bgm?: string;
  videoPoints?: VideoSuggestion[];
  /** 图片小说分镜（#806/#810）：全屏插画随对话切换；sprite 模式为空 */
  shots?: Shot[];
}

/**
 * 图片小说分镜：一张全屏插画 + 在对话中的切换点。
 * prompt 为英文整幅插画提示词（含角色/动作/表情/构图/场景）；triggerLineIndex 指向 SceneJSON.lines 的 0-based 行号。
 */
export interface Shot {
  id: string;
  prompt: string;
  triggerLineIndex: number;
  /** 出场角色 id（用于三视图 identity 参考；#814 决策 7） */
  characters?: string[];
  /** 供鉴赏室显示的短标题（可选） */
  note?: string;
}

/** 图片小说页面专属选项（#806；与 GenerationOptions 重叠的字段复用同名语义） */
export interface ImageStoryOptions {
  /** 每场景分镜张数（0=不限，由剧本模型按剧情决定） */
  shotsPerScene: number;
  /** 每章分镜总量上限（0=不限） */
  shotsPerChapter: number;
  /** 全局分镜总量/预算上限（0=不限；到达上限停止派发新任务并可续跑） */
  shotsTotal: number;
  imageStyle: string;
  imageSeed: number;
  imageSelfCheck?: boolean;
  /** 是否生成物品图（图片小说默认关闭） */
  includeItems?: boolean;
  /** 目标语言（空=原文；复用主项目分章/翻译能力） */
  language?: string;
  /** 风格锚点（画风基准图；同时用于主题取色） */
  styleAnchor?: boolean;
}

export interface ChapterScript {
  chapter: number;
  title: string;
  scenes: SceneJSON[];
}

export interface ImageTask {
  kind: "figure" | "background" | "cg" | "item" | "threeview" | "action" | "anchor" | "shot";
  id: string;
  /** 该任务所属章节（仅背景/CG：ChapterScript.chapter，0-based 连续编号）；用于按章精确强制重画 */
  chapter?: number;
  /**
   * 背景复用的同桶场景 id（仅 kind=background，含任务自身的 id）：
   * 这些场景共用本任务的**同一个文件**，生成后要一并写进 assets.bg（渲染端逐场景查映射）。
   * 缺省=旧行为（本任务只服务 id 那一个场景）。
   */
  bgSceneIds?: string[];
  /** 同桶场景涉及的章节（0-based，仅 kind=background）：单章强制重画要能命中跨章共享的桶 */
  bgChapters?: number[];
  characterId?: string;
  prompt: string;
  references?: ImageReference[];
  emotion?: string;
  /** 该动作对应的角色动作 id（仅 kind=action） */
  actionId?: string;
  /** 服装差分标识（figure 任务）：为该服装生成 normal 立绘 */
  costume?: string;
  refFromTask?: string;
  fileName: string;
  width: number;
  height: number;
  usage?: string;
  /** 确定性种子（用于同一项目多次生成保持风格稳定） */
  seed?: number;
  /** 提示词版本（图片小说分镜/角色基准图用）：提示词约束升级后 +1，
   *  写进旁路 meta 让旧缓存判失效重画（否则修复对存量项目不生效）；未标注=0。 */
  promptVersion?: number;
  /** 图片小说分镜所属场景 id（仅 kind=shot） */
  sceneId?: string;
  /** 图片小说分镜在场景内的序号（0-based，仅 kind=shot） */
  shotIndex?: number;
  /** 差分生成方式：expression=表情差分（只改表情、其余保持）；
   *  shot=图片小说分镜（以角色参考图为输入走编辑端点，锁定人物一致性，见 images.ts shotEditPrompt）；
   *  scene=立绘版 CG（与 shot 共用同一编辑实现，见 images.ts sceneEditPrompt）。
   *  三者都只在模型支持官方编辑端点时生效，否则/失败时自动回退参考图生图 */
  editVariant?: "expression" | "shot" | "scene";
  /** 脸部局部合成差分（#1086，默认关闭）：true=按 rig.crop 裁脸重绘表情并合成回原图
   * （身体/alpha 冻结，合成后过 #1084 核验）；缺省/false 走现有整张生成旧路径 */
  faceComposite?: boolean;
  /** 脸部合成失败/核验失败时回退整张生成旧路径（默认 false：显式失败记失败项，不静默降级） */
  faceCompositeFallback?: boolean;
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
  /** 本次运行的分章来源（ai＝AI 分章，fallback＝规则回退，legacy＝旧版缓存，import＝导入时规则切分） */
  splitMethod?: "ai" | "fallback" | "legacy" | "import";
  /** AI 分章丢弃的杂项块数 */
  splitDiscarded?: number;
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

export const STEP_TO_STAGE: Record<string, StageKey> = {
  [STAGE_LABELS.split]: "split",
  [STAGE_LABELS.translate]: "translate",
  [STAGE_LABELS.extract]: "extract",
  [STAGE_LABELS.script]: "script",
  [STAGE_LABELS.image]: "image",
  [STAGE_LABELS.voice]: "voice",
  [STAGE_LABELS.assemble]: "assemble",
};

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
  /** 图片小说分镜图（shot.id → 文件路径）；立绘版项目该字段为空/缺省 */
  shot?: Record<string, string>;
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

export type FigureDetail = "core" | "full";

/**
 * 角色图片的「剧本实际使用情况」（写回角色卡，见 CharacterCard.imageUsage）。
 * 只在剧本阶段统计一次，之后所有构建路径（主管线/单章跳过判定/章节灯/素材页/重生成/补缺）
 * 都从卡片读同一份，因此文件名清单结构上不会漂移（#1521 那一族 bug 的根因就是两处口径不一致）。
 */
export interface CharacterImageUsage {
  /** 剧本里用到的表情 id（按使用次数降序；normal 总会补上） */
  emotions: string[];
  /** 剧本里真正换上的服装 id（按使用次数降序） */
  costumes: string[];
  /** 剧本里用到的动作 id（按使用次数降序） */
  actions: string[];
  /** 统计口径的章节数（剧本重跑后此值变化 → 使用集合随之刷新） */
  chapters: number;
}

/** 角色图片档位：main=主要角色（全量）/ supporting=次要角色（精简）/ cameo=路人（最省） */
export type FigureTier = "main" | "supporting" | "cameo";

/**
 * 背景复用口径（#1580）：一张背景图服务**一组**场景，而不是一个场景实例。
 *
 * 起因：背景任务原本按 `scene.id` 建，一个场景实例一张图。实测某 30 章项目 502 个场景实例、
 * 同一间公寓出现 62 次（8 章），于是同一间房被画了 24 张几乎一样的夜景——
 * 而每张的提示词只是把同一张画换个说法重写（502 条 bgPrompt 无一重复，按提示词去重省不下来）。
 * VN 的行业常规是「一个地点 2~4 张（昼/夜/雨）」，故按「地点 × 昼夜 × 天气」分桶复用。
 *
 * 分桶键**只吃场景自身字段**（纯函数，见 images.ts 的 backgroundBucketKey）：
 * 任何调用方（主管线、单章、章节灯、素材页、重生成、补缺、清理）拿到的是同一份清单与同一个文件名，
 * 结构上不可能漂移——这是 #1521 那族 bug（两条路径口径不一致 → 单章永远凑不齐、反复计费）的防线。
 */
export type BackgroundReuseMode = "off" | "location" | "locationTime" | "locationTimeWeather";

/**
 * 背景复用默认口径：地点 × 昼夜 × 天气。
 *
 * 所有调用点一律走这个常量（不要各自写 `?? "off"`）：只要有一处口径不同，
 * 「单章构建」与「整本构建」就会算出不同的文件名清单，直接复现 #1521。
 */
export const DEFAULT_BACKGROUND_REUSE: BackgroundReuseMode = "locationTimeWeather";

/** 角色卡上的图片档位设置：auto=按 isNpc 自动判定（默认） */
export type FigureTierSetting = FigureTier | "auto";

export interface GenerationOptions {
  useImage: boolean;
  useTts: boolean;
  useVideoPoints: boolean;
  useBgm: boolean;
  /** 环境音效（SE）：按场景氛围播放内置雨/雷/风等音效；默认开启，无声氛围需求可关闭 */
  useSe?: boolean;
  figureEmotions: boolean;
  /** 人物图详细度：core=标准5表情＋无服装差分（省图省钱）；full=AI全量表情＋服装＋动作（默认，保持现状） */
  figureDetail?: FigureDetail;
  /** 人物动作：入场/退场动画、情绪动作、剧情镜头震动 */
  figureActions: boolean;
  /** 角色三视图 + 动作立绘（先生成三视图，再基于它图生图生成默认/表情/动作立绘） */
  characterPoses: boolean;
  /** 生成后用多模态模型自检图片（核对描述/无畸形），不合格自动重生成 1 次 */
  imageSelfCheck: boolean;
  /** 每章图像数上限（0 = 不限制，默认） */
  imageBudgetPerChapter: number;
  /**
   * 同一地点在**单章内**的背景图上限（0 = 不限制）。
   * 实测某 30 章项目 502 张背景里，同一间公寓被画了 79 次、一个"秘密写作据点"在一章内画了 21 次——
   * LLM 给每个场景实例都写一条独一无二的氛围字符串，于是同一地点反复重画。
   * 口径按「每章」计而不是全书：单章/章节灯的构建上下文只有一章，按全书统计会让两条路径算出
   * 不同的任务清单（#1521 那族 bug：单章永远凑不齐成品、反复重新计费）。
   */
  backgroundsPerLocation?: number;
  /**
   * 背景复用口径（#1580，默认 DEFAULT_BACKGROUND_REUSE=地点×昼夜×天气）：
   * 同一「地点 × 昼夜 × 天气」桶内的全部场景共用一张背景图，只有跨桶才另出一张。
   * off = 旧行为（一个场景实例一张图，由 backgroundsPerLocation 收敛）。
   * 开启复用后 backgroundsPerLocation 不再生效——它当初就是为"同一间房被画 79 次"打的补丁，
   * 而复用从根上消除了重复；继续叠加只会把昼夜/天气差分也一起裁掉。
   */
  backgroundReuse?: BackgroundReuseMode;
  /** 每章 CG 数上限（0 = 不限制，默认） */
  cgPerChapter: number;
  skipCache: boolean;
  /** 每章视频推荐点数上限（0 = 不限制，默认） */
  videoPointsPerChapter: number;
  characterIntroCard: boolean;
  /** 标题封面：auto=按主题自动生成（默认）/none=不使用/custom=用 titleCoverPath */
  titleCoverMode?: "auto" | "none" | "custom";
  /** 自定义封面图片（绝对路径）；mode=custom 时生效 */
  titleCoverPath?: string;
  /** 标题 Logo：auto=自动生成文字 Logo（默认）/none=不显示/custom=用 titleLogoPath */
  titleLogoMode?: "auto" | "none" | "custom";
  titleLogoPath?: string;
  /** 标题曲：game/bgm 下的文件名；"none"=不播放；空=自动匹配宁静曲目 */
  titleBgmFile?: string;
  /** 导出标题（导出页设置；留空用卡片标题） */
  exportTitle?: string;
  /** 导出 Game_key（6-10 位字母数字；留空按标题自动生成） */
  exportGameKey?: string;
  /** 标题菜单开关（默认均开）：继续游戏 / 流程图 / 鉴赏室 */
  titleEnableContinue?: boolean;
  titleEnableFlowchart?: boolean;
  titleEnableAppreciation?: boolean;
  /** 主题色随画风：从风格锚点/首张背景提取主色生成每部作品的界面主题（默认开） */
  themeFromArtwork?: boolean;
  /** 统一画风描述（英文/中文均可），用于让所有立绘/背景/CG 保持同一画风；留空使用默认画风 */
  imageStyle?: string;
  /** 图片固定种子：0=按小说标题自动派生（同一种子生成结果更稳定一致，利于统一画风） */
  imageSeed?: number;
  /** 风格锚点：先生成一张全项目风格基准图，再作为背景/CG 的参考图强制统一画风 */
  styleAnchor?: boolean;
  /** 剧本文风描述（如"古风典雅""幽默风趣"），LLM 按此风格改写台词与旁白；留空不调整 */
  scriptStyle?: string;
  /** 旁白压缩开关（#801）：false（默认）=忠实保留原文全部旁白/心理/环境描写；true=精简提炼旁白（剧本更短更快） */
  compressNarration?: boolean;
  /** 提取卡片使用 Agent 模式（多步自主扫描 + 工具调用），长小说更稳、可逐步补全 */
  extractAgent?: boolean;
  /** 目标语言（如 en/ja），把小说翻译成该语言后再生成；空 = 使用原文。
   *  注意：这只是翻译开关。游戏界面语言见 uiLanguage（#1320），两者不再共用字段。 */
  language?: string;
  /** 游戏界面语言（导出页「界面语言」下拉写入；zh_CN/zh_TW/en/ja）。
   *  缺省时跟随翻译目标（非空），再缺省按原文推断——与旧单字段行为一致。 */
  uiLanguage?: string;
  /** AI 分章碎章合并阈值（默认 3000 字；0 = 不合并，特殊小章独立成章） */
  splitMinChapterChars?: number;
  /** AI 分章保留特殊章节（后记/番外/特典/插图等不被当杂项丢弃） */
  splitKeepSpecials?: boolean;
  /** 提取分段字数上限（0/缺省 = 自动：按语种估算，上限 15 万字）。
   * 中转网关常有单请求 ~70 秒超时墙：大段必 500 时手动调小（如 40000），段小单次必能跑完。 */
  extractChunkChars?: number;
  /** 单阶段重跑成功后自动补齐下游缺失的资产阶段（图像/配音/组装）：复用缓存只补缺失项，
   * 执行前统一二次确认并明示规模。默认 true；置 false 恢复旧的「严格单阶段」语义（下游需手动依次重跑）。
   * 旧项目缺该字段时按「非 false 即开启」处理。 */
  autoCascadeDownstream?: boolean;
  rerunChapters?: number[];
  /** 单章强制重跑（与 rerunChapters 同口径的 novel index）：这些章节跳过剧本缓存直接重写，
   * 不需要填意见；图像阶段同范围背景/CG 同步强制。由章节盘/剧本页「全量」开关传入。 */
  rerunChaptersForce?: number[];
  /** 只强制重写这些章节的剧本（novel index，与 rerunChapters 同口径）；不牵连其他章节与图像 */
  forceScriptChapters?: number[];
  /** 只强制重画这些章节的背景/CG（novel index）；人物/物品是项目级资产，不受章节影响 */
  forceImageChapters?: number[];
  /** 只强制重配这些章节的台词配音（novel index） */
  forceVoiceChapters?: number[];
}

export interface PipelineEvent {
  step: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
  at: number;
  taskId?: string;
  taskKind?: "llm" | "image" | "tts" | "script";
  /** 实时进度（如 图片 12/45）：done/total + 当前生成内容 label */
  progress?: { done: number; total: number; label: string };
  /** 剧本分段进度（P1）：长章节分 N 部分逐段生成时，调用方在 onPart 里透出，页面据此显示「第 k/N 段」；
   *  与 progress 章节级进度条互不干扰 */
  scriptPart?: { chapter: number; part: number; total: number };
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
  language: "zh_CN" | "zh_TW" | "en" | "ja" | "ko";
}

/** 世界观卡片（#799） */
type LoreKind = "map" | "quest" | "faction" | "artifact" | "system" | "other";
export interface LoreCard {
  id: string;
  /** 短标题（如「黑水城防线图」「铁盟入会试炼」） */
  title: string;
  /** 设定类别：map=地图/路线，quest=任务/委托，faction=组织/制度，artifact=器物/货币，system=世界规则，其他=other */
  kind: LoreKind;
  /** 原文关键信息（保留原文表述，不得概括压缩） */
  content: string;
  /** 出处备注（可选：章节/段落提示） */
  sourceNote?: string;
}
/** #799：ExtractionResult 增量合并（仅追加 lore 可选字段，既有三个数组原样不动） */
export interface ExtractionResult {
  lore?: LoreCard[];
}
