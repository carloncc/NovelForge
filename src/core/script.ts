import type {
  ChapterInfo,
  ChapterScript,
  CharacterCard,
  CgEvent,
  Choice,
  ExtractionResult,
  ItemCard,
  ItemEvent,
  Line,
  SceneCard,
  SceneJSON,
  Shot,
} from "./types";
import { chatJson, type LlmProgressEvent } from "../api/openaiCompatible";
import { estimateCharsPerToken, outputTokensForText } from "../api/providers";
import { splitNovelForAgent } from "./textSplit";
import { log as logger } from "../utils/logger";
import { tauri } from "../utils/tauri";
import { scriptCacheRest } from "./cache";
import type { ApiConfig } from "./types";

interface ScriptModel {
  title: string;
  scenes: {
    id: string;
    location: string;
    atmosphere: string;
    time: string;
    bgPrompt: string;
    bgm?: string;
    cg?: { title: string; description: string; imagePrompt: string };
    itemEvents: { itemId: string; action: "obtain" | "exchange" | "show" | "key"; description: string }[];
    videoPoints?: {
      id: string;
      title: string;
      description: string;
      videoPrompt: string;
      durationSecs: number;
    }[];
    lines: {
      type: "dialogue" | "narration";
      characterId?: string;
      emotion?: string;
      action?: string;
      costume?: string;
      monologue?: boolean;
      /** 配音语速（0.5-2，模型可标注） */
      speed?: number;
      /** 配音情绪（happy/sad/angry/calm/whisper/surprised 等，传给 TTS） */
      ttsEmotion?: string;
      text: string;
    }[];
    choices?: {
      id: string;
      prompt: string;
      lines: {
        type: "dialogue" | "narration";
        characterId?: string;
        emotion?: string;
        action?: string;
        costume?: string;
        monologue?: boolean;
        speed?: number;
        ttsEmotion?: string;
        text: string;
      }[];
    }[];
    /** 图片小说分镜（mode=imageOnly 时模型输出）：整幅插画 + 切换行号 */
    shots?: {
      id?: string;
      prompt: string;
      triggerLineIndex?: number;
      characters?: string[];
      note?: string;
    }[];
  }[];
}

/** 图片小说模式的系统提示补充（#807）：覆盖 sprite 版的 CG/立绘规则，改为分镜产出 */
const IMAGE_ONLY_RULES = `
【本次为「图片小说」模式（无立绘、无人物演出 UI），以下规则覆盖上文冲突项】
A. 不输出 cg 字段（画面由 shots 承担）；不输出 action/costume 字段（没有立绘）。
B. 每个场景必须输出 shots 数组：按剧情需要 1-N 张全屏插画（以用户消息中的「每场景张数」为准，未指定时按剧情需要、宁精勿滥），代表该场景的关键画面。
C. 每个 shot 字段：
   - id：场景内短标识（如 s1_1；可省略，系统会补）
   - prompt：英文整幅插画提示词，必须包含：出场角色（外貌/服装/表情/动作，与角色卡一致）+ 场景环境 + 构图 + 16:9 横构图；风格为动漫插画；不要绿幕/纯色背景描述（这是整幅画面，不是立绘）
   - triggerLineIndex：在第几句台词前切换到该图（0-based，必须落在本场景 lines 范围内；同一张图覆盖的连续对话应属于同一画面）
   - characters：画面中出现的角色卡 id 数组（没有角色就留空数组）
   - note：可选，10 字内中文短标题（如「城门对峙」）
D. 一张图覆盖的连续对话应属于同一画面（同一地点/时间/氛围）；画面切换点放在场景转换、情绪转折、时间跳跃处。
E. lines 的说话人、台词保真与上文规则一致（对话逐句保留，旁白按「旁白处理策略」）。`;

const SYSTEM_PROMPT = `你是视觉小说编剧。根据小说章节文本与角色卡、物品卡，将该章改编为视觉小说分镜 JSON。

规则：
1. 忠实于原文，对话尽量使用原文台词；旁白/描写按用户消息中的「旁白处理策略」执行。
2. 场景划分：按原文的地点/时间/情节段落变化切分（每个场景 = 一个地点 + 一段连续剧情），宁多勿并——多地点/行旅/任务推进类章节必须保留移动、路线与时间推进的过渡描写，不要为了凑少量场景把不同地点硬合并；常规章节约 2-10 个，上限 20 仅作极端保护。
3. 场景字段：
   - id: 唯一标识（如 s1）
   - location / atmosphere / time: 对应场景卡，若不在场景卡中则新写
   - bgPrompt: 该场景背景图的英文 prompt，动漫背景风格，无人
   - bgm: 该场景氛围适合的背景音乐描述（中文，如"宁静的钢琴曲""肃杀的战鼓声"；没有合适氛围时留空字符串）
4. lines 数组：按剧情顺序排列
   - dialogue: {type:"dialogue", characterId: 角色卡id, emotion:"normal|happy|sad|angry|surprised", text}
   - 可选 ttsEmotion: 该句配音情绪（传给 TTS 合成，让声音更有表现力），按说话语气选：happy/sad/angry/calm/whisper/surprised；没有明显情绪就省略
   - 可选 speed: 该句配音语速（0.5-2，默认 1.1 更像人；激动/紧张略快如 1.2-1.3，悲伤/低沉略慢如 0.9-1.0），没有明显语气差异就省略
    - 可选 action: 当该句台词有明显动作姿态（抬手指、拔剑、挥手、抱臂、蹲下等）时，从该角色的"动作列表"(见角色卡)中选最贴切的一个填 action: "动作id"；没有合适的动作就省略该字段
    - 可选 costume: 仅当剧情明确写了换装（换上礼服/战斗服/睡衣等）时，从该角色的"服装列表"(见角色卡)中选填 costume: "服装id"；换装后该角色后续台词自动沿用该服装直到再次标注，没有换装情节就省略该字段
   - narration: {type:"narration", text}
   - 内心独白: {type:"narration", monologue:true, text}（按原文比例保留，不要机械砍数量）
5. CG 事件：为本章的名场面写 1-3 个 cg（战斗高潮、重要相遇、关键转折、地图/景观大场面等；每个场景最多 1 个），按画面张力排序，宁缺毋滥、不要为凑数硬加；超过 3 个的部分会被系统丢弃：
   {title, description(一两句), imagePrompt(整幅插画，含人物，电影构图，动漫风)}
6. 视频推荐点 videoPoints：对本章最具"动感"的名场面（战斗、追逐、大雨、重要转身等）标记 1-3 个视频推荐点（按剧情需要，不设上限）：
   {id: 短标识(如 op1、ch2_battle), title, description(一两句), videoPrompt(可直接用于 AI 视频生成平台的英文提示词：画面内容/运镜/时长/风格), durationSecs: 建议时长秒数}
   注意：视频只是"推荐位"，不要因为标记视频而删减 CG 或台词。推荐点对应场景必须有足够的动态画面描写。
7. 物品事件 itemEvents：当剧情中出现"获得/交接/展示/使用重要物品"时，在该场景标记：
   {itemId: 物品卡id, action: "obtain"|"exchange"|"show"|"key", description}
   triggerIndex 我会在渲染时根据文本顺序自动对齐，你只需把 itemEvents 写在对应场景中。
   若原文包含地图/路线、任务委托、组织制度、货币器物等关键设定，可收录为物品卡（name/note 保留原文关键信息，不要概括掉细节）。
8. 分支选择 choices（可选）：当剧情出现真正的"抉择时刻"（如留下/离开、相信/怀疑、帮助/旁观等影响角色关系的关键决定）时，
   在该场景写 choices 数组（按剧情需要可出现多处，不要强行加）：
   - 每个选项 {id: 短标识, prompt: 选项按钮文本（简洁有力，2-8 字）, lines: 该选项后的分支剧情（1-4 句 dialogue/narration，格式与 lines 相同）}；每个场景保留 2-4 个选项
   - 分支剧情必须自然收束，玩家选择后最终都会汇合回主线继续，不要写 end / jump / 跳转指令
   - 没有真正的抉择时刻就不要写 choices，宁可全线性也不强行加
 9. 每章最后可以安排到下一章的自然收束，不要写 end 指令。
10. 只输出 JSON，不要输出任何文字。
11. 台词完整性（硬约束，优先级最高）：
    - 原文「」内的每一句对话都必须原样保留，一句不许删、一句不许合并，短句/语气词（嗯、诶、真的……？等）同样不许丢；
    - 禁止改写对话文字（仅允许统一标点）；
    - 内心独白按原文比例保留，不要机械砍到只剩 2 条；
    - 旁白/心理/环境/氛围描写按用户消息中的「旁白处理策略」执行。
12. 说话人判定（硬约束）：
    - 每个 dialogue 的 characterId 必须能在上下文中找到依据（引号前后的人名＋说/道/问/喊等动词，或明确的行为主体）；
    - 引用中的第三人称点名不能倒置（例如台词含"对优斗来说"时，说话人绝不能是优斗本人）；
    - 实在无法确定说话人时，写成 narration，禁止猜一个角色。
13. 日记/书信/日志体章节：按日期条目顺序逐段改编，不得跨日期合并场景，不得打乱时间顺序。`;

function buildCharacterContext(chars: CharacterCard[]): string {
  return chars
    .map((c) => {
      const acts = Array.isArray(c.actions) && c.actions.length
        ? `；动作列表：${c.actions.map((a) => `${a.id}(${a.name})`).join("、")}`
        : "";
      const cts = Array.isArray(c.costumes) && c.costumes.length
        ? `；服装列表：${c.costumes.map((t) => `${t.id}(${t.name})`).join("、")}`
        : "";
      return `${c.id}（${c.name}）：外貌${c.appearance}；服装${c.clothing}；性格${c.personality}${acts}${cts}`;
    })
    .join("\n");
}

function buildItemContext(items: ItemCard[]): string {
  return items
    .map((i) => `${i.id}（${i.name}）：${i.appearance}；意义：${i.note}`)
    .join("\n");
}

export interface ScriptChapterOptions {
  /** 剧本文风：整体按此风格改写台词与旁白（如"古风典雅"）；留空不调整 */
  style?: string;
  /** 用户对上一版剧本的意见，重新生成时严格参考 */
  feedback?: string;
  /** 旁白压缩（#801）：true=精简提炼旁白；缺省/false=忠实保留全文旁白（默认） */
  compressNarration?: boolean;
  /** 视觉模式（#807）：sprite=立绘版（默认）；imageOnly=图片小说（产出 shots 分镜，不产 cg/立绘字段） */
  mode?: "sprite" | "imageOnly";
  /** 图片小说：每场景分镜张数目标（0/缺省=不限，按剧情需要；仅图片小说模式生效） */
  shotsPerScene?: number;
  /** 分块进度回调（长章节分 N 部分生成时逐段上报；调用方可据此打日志/进度，避免长调用期间无输出） */
  onPart?: (info: { part: number; total: number; phase: "start" | "done"; elapsedMs: number }) => void;
  /** 请求级日志回调（续写/修复/重试/预算升级等模型请求事件；调用方接到后打面向用户的日志） */
  onLog?: (message: string) => void;
  /** 视频推荐位开关（#1135）：false=提示词不再要求 videoPoints（省 token、不挤占台词篇幅）；
   *  缺省 undefined=保持原行为（要求 1-3 个），避免已上线调用方行为突变 */
  useVideoPoints?: boolean;
  /** 每章视频推荐点数上限（#1135：0/缺省=不限；>0 时注入提示词并在映射侧按整章配额裁剪） */
  videoPointsPerChapter?: number;
  /** 每章 CG 数上限（#1136：0/缺省=不限即提示词默认 3 个；>0 时覆盖规则 5 的数量并参与映射裁剪。
   *  只改 core 侧语义与注释，不碰设置页 UI） */
  cgMax?: number;
}

/** CG 每章默认上限（#1136）：设置页 0=不限制时仍受提示词默认 3 个约束（与既有行为一致） */
export const SCRIPT_CG_DEFAULT_MAX = 3;

/** 解析 CG 整章配额（#1136，纯函数供单测）：>0 用用户上限，否则回退默认 3 */
export function resolveCgMax(cgMax?: number): number {
  return cgMax && cgMax > 0 ? Math.floor(cgMax) : SCRIPT_CG_DEFAULT_MAX;
}

/** 视频推荐位提示词规则（#1135，纯函数供单测）：
 *  关闭时明确要求不输出 videoPoints（而不是生成后再清空，白花 token）；限数时注入整章上限 */
export function videoPointsPromptRule(useVideoPoints?: boolean, limit?: number): string {
  if (useVideoPoints === false) {
    return "【本次已关闭视频推荐位（覆盖上文规则 6）】：不要输出 videoPoints 字段，不要为视频推荐位花费任何篇幅，把篇幅留给台词与旁白保真。";
  }
  if (limit && limit > 0) {
    return `【本章视频推荐位上限（覆盖上文规则 6 的数量）】：本章 videoPoints 总数不超过 ${Math.floor(limit)} 个，优先保留最具动感的名场面。`;
  }
  return "";
}

/** CG 上限提示词规则（#1136，纯函数供单测）：用户设上限时覆盖规则 5 的数量 */
export function cgPromptRule(cgMax?: number): string {
  if (cgMax && cgMax > 0) {
    return `【本章 CG 上限（覆盖上文规则 5 的数量）】：本章 cg 总数不超过 ${Math.floor(cgMax)} 个（每个场景最多 1 个），按画面张力排序，宁缺毋滥。`;
  }
  return "";
}

/** 组装剧本系统提示（#1135/#1136 条件注入，纯函数供单测）：
 *  三个开关全缺省时与旧提示词逐字一致（已上线调用方行为不变）。 */
export function buildScriptSystemPrompt(opts: {
  imageOnly: boolean;
  useVideoPoints?: boolean;
  videoPointsPerChapter?: number;
  cgMax?: number;
}): string {
  const base = opts.imageOnly ? `${SYSTEM_PROMPT}\n${IMAGE_ONLY_RULES}` : SYSTEM_PROMPT;
  const extra: string[] = [];
  const videoRule = videoPointsPromptRule(opts.useVideoPoints, opts.videoPointsPerChapter);
  if (videoRule) extra.push(videoRule);
  const cgRule = cgPromptRule(opts.cgMax);
  if (cgRule) extra.push(cgRule);
  return extra.length ? `${base}\n${extra.join("\n")}` : base;
}

/** 旁白处理策略文案（#793/#801，纯函数供单测）：
 *  默认忠实全文（旧提示词明文授权「压缩旁白」，描写/心理/环境被系统性砍掉）；
 *  开启压缩开关时才注入精简授权。 */
export function narrationPolicyText(compressNarration?: boolean): string {
  return compressNarration
    ? "旁白处理策略（精简模式）：可以精简提炼旁白（合并同义重复、压缩冗长描述），但不得删除关键剧情信息；对话仍逐句保留。"
    : "旁白处理策略（忠实全文，硬约束）：必须完整保留原文全部旁白与心理/环境/氛围描写，只可合并同义重复句，禁止删减任何带信息量/情绪/伏笔的句子；原文每个自然段至少要产出一条 line（narration 或 dialogue）。";
}

/** 剧本分块（纯函数，供单测）：按「输出预算 × 语种字符/token × 0.65」估算单块可承载的正文体量，
 *  超长章节按段落边界切块（忠实全文模式下避免整章输出被截断 → scenes 为空）。 */
export function planScriptChunks(
  cfg: ApiConfig,
  chapter: ChapterInfo,
  systemPrompt: string,
  extra: string[],
  cards: ExtractionResult,
): string[] {
  const probeTokens = outputTokensForText(cfg, `${systemPrompt}\n${buildScriptUser(chapter, cards, extra, chapter.text.slice(0, 4000))}`);
  const cpt = estimateCharsPerToken(chapter.text);
  const chunkBudget = Math.max(3000, Math.floor(probeTokens * cpt * 0.65));
  return chapter.text.length <= chunkBudget ? [chapter.text] : splitNovelForAgent(chapter.text, chunkBudget);
}

/** 剧本用户消息（单次生成与分块生成共用） */
function buildScriptUser(
  chapter: ChapterInfo,
  cards: ExtractionResult,
  extra: string[],
  body: string,
  partNote = "",
): string {
  return [
    `章节：第 ${chapter.index + 1} 章 ${chapter.title}`,
    `\n角色卡：\n${buildCharacterContext(cards.characters)}`,
    `\n物品卡：\n${buildItemContext(cards.items)}`,
    `\n场景卡：\n${cards.scenes.map((s) => `${s.id}（${s.location}）：${s.atmosphere}`).join("\n")}`,
    ...extra,
    partNote,
    `\n章节正文：\n${body}`,
  ].join("\n");
}

/** 剧本单行映射（sprite/imageOnly 共用）：
 *  speed/ttsEmotion 透传；characterId 缺失/非法（空、narrator、不在卡片中）降级为旁白并保留原句。 */
function mapScriptLine(l: ScriptModel["scenes"][number]["lines"][number], cards: ExtractionResult): Line {
  const speed = typeof l.speed === "number" && Number.isFinite(l.speed) && l.speed >= 0.5 && l.speed <= 2
    ? l.speed
    : undefined;
  const ttsEmotion = typeof l.ttsEmotion === "string" && l.ttsEmotion.trim() ? l.ttsEmotion.trim() : undefined;
  if (l.type !== "dialogue") {
    return {
      type: "narration" as const,
      text: l.text,
      monologue: !!l.monologue,
    };
  }
  const charId = typeof l.characterId === "string" ? l.characterId.trim() : "";
  if (!charId || charId === "narrator" || !cards.characters.some((c) => c.id === charId)) {
    return { type: "narration" as const, text: l.text };
  }
  return {
    type: "dialogue" as const,
    characterId: charId,
    emotion: l.emotion || "normal",
    action: l.action || undefined,
    costume: l.costume || undefined,
    speed,
    ttsEmotion,
    text: l.text,
  };
}

/** 剧本场景映射上下文（跨分块共享：场景 id 去重与 CG/视频位配额按整章累计） */
interface ScriptSceneContext {
  chapter: ChapterInfo;
  cards: ExtractionResult;
  imageOnly: boolean;
  shotsPerScene?: number;
  resolveSceneId: (s: ScriptModel["scenes"][number], fallbackIndex: number) => string;
  cgCount: { value: number };
  /** 整章视频位配额累计（#1135：上限按整章计，达上限后后续场景不再出） */
  videoCount: { value: number };
  /** 视频推荐位开关透传（#1135）：false=映射侧直接丢弃，不写残条 */
  useVideoPoints?: boolean;
  /** 整章视频位上限透传（#1135：0/缺省=不限） */
  videoPointsPerChapter?: number;
  /** 整章 CG 上限透传（#1136：0/缺省=默认 3） */
  cgMax?: number;
}

/** 把一次模型回执映射为场景数组（含分支/CG/物品/视频位/分镜清洗与配额） */
function mapScriptScenes(model: ScriptModel, ctx: ScriptSceneContext): SceneJSON[] {
  // 分支/CG 配额：与 prompt 规则一致（#795/#798）。超出上限的只告警并放弃多余项，
  // 不做静默截断——静默丢剧情比丢 CG 更难察觉。
  // #1136：CG 上限取用户设置（cgMax>0）否则默认 3；#1135：视频位关闭时映射侧直接清空。
  const CG_PER_CHAPTER_MAX = resolveCgMax(ctx.cgMax);
  const VIDEO_PER_CHAPTER_MAX = ctx.videoPointsPerChapter && ctx.videoPointsPerChapter > 0
    ? Math.floor(ctx.videoPointsPerChapter)
    : 0;
  const CHOICES_PER_SCENE_MAX = 4;
  const CHOICE_LINES_SOFT_MAX = 12;
  return (model.scenes || []).map((s, i) => {
    const lines: Line[] = (s.lines || [])
      // 过滤空文本行：LLM 可能输出无 text 的 narration/dialogue，会令渲染阶段 esc(undefined) 崩溃
      .filter((l) => typeof l?.text === "string" && l.text.trim().length > 0)
      .map((l) => mapScriptLine(l, ctx.cards));

    const rawItemEvents = s.itemEvents || [];
    const itemEvents: ItemEvent[] = rawItemEvents.map((ie, j) => ({
      // 均匀分布到场景时间轴（旧公式 j*2+1 与剧情无关，且多事件时被钳到最后一行堆叠）：
      // 渲染端支持同一行多事件，这里保证事件按顺序散开。
      triggerIndex: lines.length
        ? Math.min(lines.length - 1, Math.floor(((j + 1) * lines.length) / (rawItemEvents.length + 1)))
        : 0,
      itemId: ie.itemId,
      action: ie.action || "show",
      description: ie.description || "",
    }));

    let cgEvent: CgEvent | undefined;
    if (s.cg && !ctx.imageOnly) {
      if (ctx.cgCount.value >= CG_PER_CHAPTER_MAX) {
        logger.warn("script", `CG 超过每章 ${CG_PER_CHAPTER_MAX} 个上限，已丢弃多余 CG`, { scene: s.id || i, title: s.cg.title });
      } else {
        ctx.cgCount.value++;
        cgEvent = {
          triggerIndex: Math.max(0, Math.floor(lines.length / 3)),
          title: s.cg.title,
          description: s.cg.description,
          imagePrompt: s.cg.imagePrompt,
          videoSuggestion: undefined,
        };
      }
    }

    // 分支（#798）：按剧情可出现多处；每场景保留 2-4 个选项，分支台词只做超长告警不截断
    // （旧实现每章只留第一个分支、每场景只留 1 条、分支台词砍到 6 句，原著支线大量丢失）
    const rawChoices = s.choices || [];
    let choices: Choice[] = [];
    if (rawChoices.length > 0) {
      if (rawChoices.length > CHOICES_PER_SCENE_MAX) {
        logger.warn("script", `分支选项超过每场景 ${CHOICES_PER_SCENE_MAX} 个，已保留前 ${CHOICES_PER_SCENE_MAX} 个`, {
          scene: s.id || i,
          total: rawChoices.length,
        });
      }
      choices = rawChoices.slice(0, CHOICES_PER_SCENE_MAX).map((c, k) => {
        const branchLines = (c.lines || []).filter((l) => typeof l?.text === "string" && l.text.trim().length > 0);
        if (branchLines.length > CHOICE_LINES_SOFT_MAX) {
          logger.warn("script", `分支台词较长（${branchLines.length} 句），已全部保留`, { scene: s.id || i, choice: k });
        }
        return {
          id: c.id || `choice_${s.id || i}_${k}`,
          prompt: (c.prompt || "继续").slice(0, 20),
          lines: branchLines.map((l) => mapScriptLine(l, ctx.cards)),
        };
      });
    }

    // 图片小说分镜（#807）：清洗 + 触发行号钳制到 lines 范围内 + 按用户旋钮裁剪（超出告警，不静默丢）
    const sceneId = ctx.resolveSceneId(s, i);
    let shots: Shot[] | undefined;
    if (ctx.imageOnly) {
      const rawShots = Array.isArray(s.shots) ? s.shots : [];
      const limit = ctx.shotsPerScene && ctx.shotsPerScene > 0 ? ctx.shotsPerScene : 0;
      if (limit > 0 && rawShots.length > limit) {
        logger.warn("script", `第 ${ctx.chapter.index + 1} 章场景 ${sceneId} 分镜超过每场景 ${limit} 张，已保留前 ${limit} 张（可提高上限后重跑）`, {
          scene: sceneId,
          total: rawShots.length,
        });
      }
      const kept = limit > 0 ? rawShots.slice(0, limit) : rawShots;
      shots = kept
        .filter((sh) => sh && typeof sh.prompt === "string" && sh.prompt.trim())
        .map((sh, k) => {
          const rawTrigger = Number(sh.triggerLineIndex ?? 0);
          const triggerLineIndex = Number.isFinite(rawTrigger) ? Math.min(Math.max(0, Math.floor(rawTrigger)), Math.max(0, lines.length - 1)) : 0;
          const characters = Array.isArray(sh.characters)
            ? sh.characters.filter((id) => typeof id === "string" && ctx.cards.characters.some((c) => c.id === id))
            : undefined;
          return {
            id: `${sceneId}_shot${k + 1}`,
            prompt: sh.prompt.trim(),
            triggerLineIndex,
            ...(characters && characters.length ? { characters } : {}),
            ...(typeof sh.note === "string" && sh.note.trim() ? { note: sh.note.trim().slice(0, 20) } : {}),
          };
        });
      if (!shots.length) shots = undefined;
    }

    return {
      id: sceneId,
      location: s.location,
      atmosphere: s.atmosphere,
      time: s.time,
      bgPrompt: s.bgPrompt,
      bgm: s.bgm || "",
      cgEvent,
      itemEvents,
      // 过滤缺 title/videoPrompt 的残条：dataValidation 会校验必填字段，
      // 写出残条会导致整章剧本缓存下次加载被判损坏（丢掉整章比丢一个视频位更糟）
      // #1135：关闭视频推荐位时直接清空（提示词侧已不要求，映射侧兜底）；
      // 设上限时按整章配额裁剪（达上限后后续场景不再出），而不是按场景 slice。
      videoPoints: (() => {
        if (ctx.useVideoPoints === false) return [];
        const cleaned = (s.videoPoints || [])
          .filter((vp) => vp && typeof vp.title === "string" && vp.title.trim() && typeof vp.videoPrompt === "string" && vp.videoPrompt.trim())
          .map((vp, k) => ({
            id: vp.id || `vp_${s.id || i}_${k}`,
            title: vp.title,
            description: vp.description || "",
            videoPrompt: vp.videoPrompt,
            durationSecs: vp.durationSecs || 5,
          }));
        if (!VIDEO_PER_CHAPTER_MAX) return cleaned;
        const remain = VIDEO_PER_CHAPTER_MAX - ctx.videoCount.value;
        if (remain <= 0) {
          if (cleaned.length) {
            logger.warn("script", `视频推荐位超过每章 ${VIDEO_PER_CHAPTER_MAX} 个上限，已丢弃后续场景的多余推荐位`, { scene: s.id || i });
          }
          return [];
        }
        const kept = cleaned.slice(0, remain);
        if (cleaned.length > kept.length) {
          logger.warn("script", `视频推荐位超过每章 ${VIDEO_PER_CHAPTER_MAX} 个上限，已丢弃多余推荐位`, { scene: s.id || i });
        }
        ctx.videoCount.value += kept.length;
        return kept;
      })(),
      lines,
      figures: [],
      choices: choices.length ? choices : undefined,
      ...(shots && shots.length ? { shots } : {}),
    };
  });
}

/** 异常文本提取（chatCompletion 抛的是 {status, message} 裸对象、Tauri 侧抛的是字符串，均非 Error） */
function failureText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    const o = e as { status?: unknown; message?: unknown };
    return `status=${String(o.status ?? "?")} ${typeof o.message === "string" ? o.message : JSON.stringify(e).slice(0, 300)}`;
  } catch {
    return "未知错误";
  }
}

/** 降级拆分（纯函数，供单测）：按段落对半切；尾部不足 2000 字的碎片并入前一块
 *  （避免单独发一次几乎无正文的请求，且保证无损覆盖：join 还原原文）。 */
export function splitForDegrade(text: string): string[] {
  const raw = splitNovelForAgent(text, Math.ceil(text.length / 2)).filter((h) => h.length > 0);
  const out: string[] = [];
  for (const h of raw) {
    if (h.trim().length < 2000 && out.length) out[out.length - 1] += h;
    else out.push(h);
  }
  return out;
}

/** 服务端过载/超时类失败（纯函数，供单测）：429/5xx、请求总超时（reqwest 文案为 error sending request）等。
 *  此类失败等量重试注定再次失败，调用方应降级（拆分/换通道）而非硬扛；鉴权/参数/审查类返回 false。 */
export function isServerClassFailure(e: unknown): boolean {
  const status = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  // 纯文本匹配必须带边界/上下文（\b429\b、HTTP 503），避免 "1500 tokens" 这类数字误伤
  return /\b429\b|\b50[0-4]\b|HTTP (429|50[0-4])|status.?(429|50[0-4])|timed out|timeout|error sending request|socket|econnreset|econnaborted|reset by peer|overload|capacity/i.test(failureText(e));
}

export async function scriptChapter(
  cfg: ApiConfig,
  chapter: ChapterInfo,
  cards: ExtractionResult,
  onUsage?: (pt: number, ct: number) => void,
  opts: ScriptChapterOptions = {},
): Promise<ChapterScript> {
  const imageOnly = opts.mode === "imageOnly";
  const extra: string[] = [];
  if (opts.style) {
    extra.push(`\n文风要求：请严格按「${opts.style}」这一风格来编写/改写本章的台词与旁白（包括遣词、语气、节奏），但保持人物设定与剧情走向不变。`);
  }
  if (opts.feedback) {
    extra.push(`\n用户的修改意见（重新生成时请严格参考并落实）：${opts.feedback}`);
  }
  // 旁白处理策略（#793/#801）：默认忠实全文——旧提示词明文授权「压缩旁白」，
  // 描写/心理/环境被系统性砍掉；改为按开关条件注入，开启时才允许精简。
  extra.push(`\n${narrationPolicyText(opts.compressNarration)}`);
  if (imageOnly) {
    // 图片小说：分镜张数目标（用户旋钮，0=不限）+ 模式补充规则
    extra.push(
      `\n每场景张数：${opts.shotsPerScene && opts.shotsPerScene > 0 ? `每场景最多 ${opts.shotsPerScene} 张（按剧情需要，宁缺毋滥）` : "不限，按剧情需要决定（宁缺毋滥）"}。`,
    );
  }
  // 剧本输出与分块（#800 落地 + 忠实全文回归修复）：忠实模式下长章输出极易被截断，
  // 「scenes 为空」正是截断/JSON 修复失败的典型表现——先按「输出预算可承载的正文体量」把章节切块，
  // 逐块生成后合并场景（场景 id 跨块去重）；空 scenes 带明确反馈重试一次，仍失败才进失败项。
  // #1135/#1136：视频推荐位开关与 CG/视频位上限按开关条件注入系统提示（关闭不再下发规则 6，
  // 而不是生成后再清空，白花 token 并挤占台词篇幅）；三开关全缺省时与旧提示词逐字一致。
  const systemPrompt = buildScriptSystemPrompt({
    imageOnly,
    useVideoPoints: opts.useVideoPoints,
    videoPointsPerChapter: opts.videoPointsPerChapter,
    cgMax: opts.cgMax,
  });
  const parts = planScriptChunks(cfg, chapter, systemPrompt, extra, cards);
  const resolveSceneId = makeSceneIdResolver(cards, chapter.index);
  const mapCtx: ScriptSceneContext = {
    chapter,
    cards,
    imageOnly,
    shotsPerScene: opts.shotsPerScene,
    resolveSceneId,
    cgCount: { value: 0 },
    videoCount: { value: 0 },
    useVideoPoints: opts.useVideoPoints,
    videoPointsPerChapter: opts.videoPointsPerChapter,
    cgMax: opts.cgMax,
  };

  const scenes: SceneJSON[] = [];
  let title = chapter.title;
  for (let i = 0; i < parts.length; i++) {
    const partStart = Date.now();
    opts.onPart?.({ part: i + 1, total: parts.length, phase: "start", elapsedMs: 0 });
    const partTag = parts.length > 1 ? `第 ${i + 1}/${parts.length} 部分` : "";
    const noteFor = (label: string, total: number): string =>
      total > 1
        ? `\n\n【本章分 ${total} 部分生成】这是${label}：只输出这部分正文对应的场景与台词；不要在本部分结尾写章节收束、不要写 end；不要把其它部分的内容补进来。`
        : "";
    // 请求级事件翻译成分块上下文日志：续写/修复/重试/预算升级全部可见（否则单请求 300s 超时 ×N 次重试全程静默）
    const llmEventFor = (tag: string) => (e: LlmProgressEvent): void => {
      if (!opts.onLog) return;
      const where = `第 ${chapter.index + 1} 章${tag}`;
      if (e.kind === "response") {
        opts.onLog(`${where}模型返回（${e.contentLen ?? 0} 字${e.finishReason ? `，finish=${e.finishReason}` : ""}，累计 ${e.accumulatedLen ?? 0} 字）`);
      } else if (e.kind === "continue") {
        opts.onLog(`${where}输出被截断，请求续写（第 ${e.attempt} 次，已累积 ${e.accumulatedLen ?? 0} 字）…`);
      } else if (e.kind === "repair") {
        opts.onLog(`${where}JSON 解析失败，请求模型修复（第 ${e.attempt} 次）…`);
      } else {
        const base = e.message ?? "放大输出预算重试";
        // 过载与超时给不同的排查方向：前者等后端恢复/换通道，后者多为单次请求过大、可拆小
        const hint = e.kind === "retry" && /429|50[234]|overload|capacity|rate.?limit|busy/i.test(base)
          ? "（模型后端过载/限流：已自动延长等待重试；若持续失败请换模型/通道，或稍后再试）"
          : e.kind === "retry" && /timed out|timeout|error sending request/i.test(base)
            ? "（单次请求 300s 未返回：本章输出过大或后端变慢；持续失败会自动拆小重试，也可开「压缩旁白」减小输出）"
            : "";
        opts.onLog(`${where}${base}${hint}…`);
      }
    };
    // 单个子块生成（含空结果带提示重试一次；无场景即抛错，由外层决定是否降级拆分）
    const genOnePart = async (bodyText: string, note: string, tag: string): Promise<{ model: ScriptModel; scenes: SceneJSON[] }> => {
      const user = buildScriptUser(chapter, cards, extra, bodyText, note);
      const maxTokens = outputTokensForText(cfg, `${systemPrompt}\n${user}`);
      const llmEvent = llmEventFor(tag);
      let model = await chatJson<ScriptModel>(cfg, systemPrompt, user, { maxTokens, onUsage, timeoutSecs: 300, onEvent: llmEvent });
      let subScenes = mapScriptScenes(model, mapCtx);
      if (!subScenes.length) {
        logger.warn("script", `第 ${chapter.index + 1} 章${tag}未产出场景，带提示重试一次`, {});
        opts.onLog?.(`第 ${chapter.index + 1} 章${tag}未产出场景，带提示重试一次…`);
        model = await chatJson<ScriptModel>(
          cfg,
          systemPrompt,
          `${user}\n\n注意：上一次回复没有 scenes 数组或 scenes 为空。请输出严格 JSON，且 scenes 至少包含本部分正文的第一个场景（含完整的 lines 台词）。`,
          { maxTokens, onUsage, timeoutSecs: 300, onEvent: llmEvent },
        );
        subScenes = mapScriptScenes(model, mapCtx);
      }
      if (!subScenes.length) {
        throw new Error(
          `第 ${chapter.index + 1} 章剧本未产出任何场景${tag ? `（${tag}）` : ""}：模型返回无 scenes（常见于输出被截断或 JSON 修复失败）。本章未写入缓存，请直接重试；若反复失败可开启「压缩旁白」或改用输出上限更高的模型`,
        );
      }
      return { model, scenes: subScenes };
    };

    let firstModel: ScriptModel | null = null;
    try {
      const r = await genOnePart(parts[i], noteFor(`第 ${i + 1}/${parts.length} 部分`, parts.length), partTag);
      firstModel = r.model;
      scenes.push(...r.scenes);
    } catch (e) {
      // 自适应降级：服务端过载/超时 + 文本还够大 → 按段落对半拆成小块分别生成
      // （小请求更容易在超时前完成；鉴权/参数/审查/空结果类错误直接抛出，不拆）
      const halves = parts[i].length > 8000 ? splitForDegrade(parts[i]) : [];
      if (!isServerClassFailure(e) || halves.length < 2) throw e;
      const reason = /429/.test(failureText(e)) ? "后端限流" : "后端过载/超时";
      opts.onLog?.(`第 ${chapter.index + 1} 章${partTag}请求过大（${reason}），已拆成 ${halves.length} 块分别生成…`);
      logger.warn("script", `第 ${chapter.index + 1} 章${partTag}服务端失败，降级拆分重试`, { error: failureText(e).slice(0, 200) });
      for (let h = 0; h < halves.length; h++) {
        const subTag = `${partTag ? `${partTag}之` : ""}第 ${h + 1}/${halves.length} 块`;
        const r = await genOnePart(halves[h], noteFor(subTag, halves.length), subTag);
        if (!firstModel) firstModel = r.model;
        scenes.push(...r.scenes);
      }
    }
    if (parts.length > 1 && i === 0 && firstModel) {
      const partTitle = (firstModel as { title?: unknown }).title;
      if (typeof partTitle === "string" && partTitle.trim()) title = partTitle.trim();
    }
    opts.onPart?.({ part: i + 1, total: parts.length, phase: "done", elapsedMs: Date.now() - partStart });
  }

  return {
    chapter: chapter.index,
    title,
    scenes,
  };
}
/**
 * 把剧本里的场景 id 解析为「全局唯一 + 可关联场景卡」的 id：
 * 1. 优先匹配场景卡：location 完全一致 → 复用场景卡 id（保证背景图按场景卡去重/关联）
 * 2. 否则用 `ch{章}_` 前缀保证跨章唯一（LLM 常给 s1/s2…，不同章重复会导致 bg 文件互相覆盖）
 * 3. 同一章内重复（如两个场景都匹配到同一场景卡）自动追加 _2/_3，避免图互相覆盖
 */
function makeSceneIdResolver(cards: ExtractionResult, chapterIndex: number) {
  const used = new Set<string>();
  return function resolveSceneId(
    s: ScriptModel["scenes"][number],
    fallbackIndex: number,
  ): string {
    const raw = s?.id?.trim() || "";
    const location = (s?.location || "").trim();
    // 1) location 精确匹配场景卡
    if (location) {
      const card = cards.scenes.find(
        (sc) => sc.location === location || sc.id === location || sc.id === raw,
      );
      if (card?.id) return unique(card.id);
    }
    // 2) location 归一化匹配（去掉"的/的…"等，防 LLM 改写导致失配）
    if (location) {
      const norm = (x: string) => x.toLowerCase().replace(/[\s·:：,，。、的]/g, "");
      const card = cards.scenes.find((sc) => norm(sc.location) === norm(location) || norm(sc.id) === norm(location));
      if (card?.id) return unique(card.id);
    }
    // 3) 兜底：章内唯一 → 跨章唯一（ch{index}_{id}），避免不同章同名场景互相覆盖
    const base = raw || `s${fallbackIndex + 1}`;
    return unique(`ch${chapterIndex + 1}_${base}`);
  };
  function unique(base: string): string {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}_${n}`)) n++;
    used.add(`${base}_${n}`);
    return `${base}_${n}`;
  }
}

/* ==================== 演示模式（无 API key 时） ==================== */

function parseParagraph(text: string, cards: ExtractionResult, charMap: Map<string, string>): Line[] {
  const lines: Line[] = [];
  const names = cards.characters.map((c) => c.name);
  const re = /"([^"]+)"/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;

  const emitNarration = (t: string) => {
    const cleaned = t.replace(/^[：:，,、\s]+/, "").trim();
    if (cleaned) lines.push({ type: "narration", text: cleaned });
  };

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const before = text.slice(Math.max(0, start - 14), start);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
    const narr = text.slice(lastEnd, start).trim();
    if (narr) emitNarration(narr);

    let speakerName: string | undefined;
    for (const n of names) {
      const bi = before.lastIndexOf(n);
      if (bi >= 0 && start - bi <= 14) {
        speakerName = n;
        break;
      }
      if (after.startsWith(n) && /(说|道|答|喊|叹|笑|问|吩咐|回应|开口|沉声道|缓缓道)/.test(after.slice(n.length, n.length + 6))) {
        speakerName = n;
        break;
      }
    }
    if (speakerName) {
      lines.push({ type: "dialogue", characterId: charMap.get(speakerName)!, text: m[1], emotion: emotionOf(m[1]) });
    } else {
      emitNarration(m[1]);
    }
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) emitNarration(tail);
  return lines;
}

function emotionOf(text: string): string {
  if (/(怒|吼|咬牙|冷冷|斥)/.test(text)) return "angry";
  if (/(笑|高兴|开心|喜)/.test(text)) return "happy";
  if (/(惊|怔|愕)/.test(text)) return "surprised";
  if (/(叹|哀|难过|哭|忧)/.test(text)) return "sad";
  return "normal";
}

interface SceneState {
  id: string;
  location: string;
  atmosphere: string;
  time: string;
  bgPrompt: string;
  bgm: string;
  lines: Line[];
  cg?: { triggerIndex: number; title: string; description: string; imagePrompt: string };
  videoPoints?: { id: string; title: string; description: string; videoPrompt: string; durationSecs: number }[];
  itemEvents: { triggerIndex: number; itemId: string; action: "obtain" | "exchange" | "show" | "key"; description: string }[];
}

function bgmFor(atmosphere: string): string {
  if (/战|肃杀|紧迫|危险|魔|血/.test(atmosphere)) return "紧张的战鼓与弦乐";
  if (/夜|静|沉|寒/.test(atmosphere)) return "静谧的钢琴曲";
  if (/晨|阳|暖|烟火|炉/.test(atmosphere)) return "温暖轻快的田园曲";
  return "";
}

function demoScriptChapter(chapter: ChapterInfo, cards: ExtractionResult): ChapterScript {
  const charMap = new Map<string, string>();
  for (const c of cards.characters) charMap.set(c.name, c.id);

  const paragraphs = chapter.text.split(/\n{2,}/).filter((p) => p.trim());
  const st: { current: SceneState | null; scenes: SceneState[] } = {
    current: null,
    scenes: [],
  };

  const switchScene = (card: SceneCard | null, fallbackTitle: string) => {
    st.current = {
      id: card?.id || `s${st.scenes.length + 1}`,
      location: card?.location || fallbackTitle,
      atmosphere: card?.atmosphere || "",
      time: card?.time || "",
      bgPrompt: card?.imagePrompt || `anime background, ${fallbackTitle}, no people`,
      bgm: bgmFor(card?.atmosphere || ""),
      lines: [],
      itemEvents: [],
    };
    st.scenes.push(st.current);
  };

  for (const p of paragraphs) {
    const first = p.split("\n")[0].trim();
    let match: SceneCard | null = null;
    for (const sc of cards.scenes) {
      if (p.includes(sc.location)) {
        match = sc;
        break;
      }
    }

    const inDialogue = /"([^"]+)"/.test(p);
    if (match) {
      if (!st.current || st.current.location !== match.location) {
        switchScene(match, "");
      }
    } else if (!st.current) {
      switchScene(match, first.slice(0, 10));
    } else if (!inDialogue && st.current.lines.length > 8) {
      switchScene(null, first.slice(0, 10));
    }

    if (st.current) {
      const parsed = parseParagraph(p, cards, charMap);
      if (!parsed.length) {
        st.current.lines.push({ type: "narration", text: first.replace(/^[：:，,、\s]+/, "") });
      } else {
        st.current.lines.push(...parsed);
      }
    }
  }

  if (!st.scenes.length) {
    switchScene(cards.scenes[0] || null, "未知地点");
  }

  st.scenes[0].lines.unshift({ type: "narration", text: `【${chapter.title}】` });

  const cgKeywords = ["血战", "魔潮", "钟声", "剑光", "嘶吼", "战斗", "之战", "战"];
  for (const sc of st.scenes) {
    if (sc.lines.length < 6) continue;
    const hit = sc.lines.find((l) => l.type === "narration" && cgKeywords.some((k) => l.text.includes(k)));
    if (hit) {
      sc.cg = {
        triggerIndex: Math.floor(sc.lines.length / 2),
        title: "战斗高潮",
        description: (hit as { text: string }).text.slice(0, 40),
        imagePrompt: "anime illustration, epic battle scene, hero with glowing blue sword against dark beasts on ancient city wall at night, dramatic composition, cinematic lighting",
      };
      break;
    }
  }

  for (const sc of st.scenes) {
    if (sc.cg) {
      sc.videoPoints = [{
        id: `vp_ch${chapter.index + 1}_${st.scenes.indexOf(sc) + 1}`,
        title: sc.cg.title,
        description: sc.cg.description,
        videoPrompt: `cinematic anime action scene, slow motion: hero swings a glowing blue sword against a horde of dark beasts on an ancient city wall at night, sparks and star-light particles, camera orbits around the hero, 5 seconds, high quality animation`,
        durationSecs: 5,
      }];
    }
  }

  for (const sc of st.scenes) {
    for (let i = 0; i < sc.lines.length; i++) {
      const l = sc.lines[i];
      if (l.type !== "narration") continue;
      const item = cards.items.find((it) => l.text.includes(it.name));
      if (item && !sc.itemEvents.some((e) => e.itemId === item.id)) {
        sc.itemEvents.push({
          triggerIndex: i,
          itemId: item.id,
          action: /(接过|收到|获得|收好|送给|赠|交到|拿出|取出)/.test(l.text) ? "obtain" : "show",
          description: l.text.slice(0, 50),
        });
      }
    }
  }

  return {
    chapter: chapter.index,
    title: chapter.title,
    scenes: st.scenes.map((s) => ({
      id: s.id,
      location: s.location,
      atmosphere: s.atmosphere,
      time: s.time,
      bgPrompt: s.bgPrompt,
      bgm: s.bgm,
      lines: s.lines,
      itemEvents: s.itemEvents,
      videoPoints: s.videoPoints,
      figures: [],
      cgEvent: s.cg,
    })),
  };
}

export function demoScriptAll(chapters: ChapterInfo[], cards: ExtractionResult): ChapterScript[] {
  return chapters.map((c) => demoScriptChapter(c, cards));
}

/* ==================== 剧本保真自检（原文 ↔ 生成剧本二遍校验） ==================== */

/** 说话动词：与演示模式 parseParagraph 同规则 */
const SPEECH_VERBS = /(说|道|答|喊|叹|笑|问|吩咐|回应|开口|沉声道|缓缓道)/;

/** 原文引用计数：中文「」/『』优先；西文/译入文本按弯引号与直引号配对计数（避免只认「」导致 keptRatio 恒为 1 的假通过） */
export function countSourceQuotes(text: string): number {
  const src = text || "";
  const cjk = src.match(/[「『][^」』]*[」』]/g)?.length ?? 0;
  if (cjk) return cjk;
  const curly = src.match(/“[^”]*”/g)?.length ?? 0;
  const straight = src.match(/"[^"\n]*"/g)?.length ?? 0;
  return curly + straight;
}

/** 角色名别名：全名＋前二字＋后二字（原文常用简称，如 西园寺樱月→樱月、佐野优斗→优斗） */
function nameAliases(name: string): string[] {
  const out = new Set<string>();
  const n = (name || "").trim();
  if (n.length >= 2) out.add(n);
  if (n.length > 2) {
    out.add(n.slice(0, 2));
    out.add(n.slice(-2));
  }
  return [...out];
}

export interface SpeakerIssue {
  sceneIndex: number;
  lineIndex: number;
  text: string;
  llmSpeakerId: string;
  llmSpeakerName: string;
  suggestedSpeakerId?: string;
  suggestedSpeakerName?: string;
  reason: "context-mismatch" | "third-person-self" | "not-in-source" | "order-suspect";
  detail: string;
}

export interface ScriptVerifyResult {
  originalQuoteCount: number;
  dialogueCount: number;
  keptRatio: number;
  /** 原文自然段数（≥12 字的行） */
  paragraphCount: number;
  /** 剧本中有对应内容的段落数（#794：旁白/描写被删减的度量） */
  coveredParagraphCount: number;
  /** 段落覆盖率（paragraphCount 为 0 时记 1） */
  narrationRatio: number;
  notFoundCount: number;
  orderSuspectCount: number;
  speakerIssues: SpeakerIssue[];
}

/** 段落覆盖率（#794）：逐段检查原文段落是否在剧本里有对应内容。
 *  旧核对只数「引语 vs dialogue」，旁白/心理/环境被删光时 keptRatio≈1 照样判通过；
 *  这里用段落样本（首/尾 16 字）与剧本行文本互查，作为旁白保真的兜底度量。 */
function narrationCoverage(
  src: string,
  scenes: { lines: { text: string }[] }[],
): { paragraphCount: number; coveredParagraphCount: number } {
  const paragraphs = src
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 12);
  if (!paragraphs.length) return { paragraphCount: 0, coveredParagraphCount: 0 };
  const lineTexts = scenes
    .flatMap((s) => s.lines.map((l) => (l.text || "").trim()))
    .filter((t) => t.length >= 4);
  let covered = 0;
  for (const p of paragraphs) {
    const head = p.slice(0, 16);
    const tail = p.length > 16 ? p.slice(-16) : head;
    if (lineTexts.some((t) => t.includes(head) || t.includes(tail) || p.includes(t))) covered++;
  }
  return { paragraphCount: paragraphs.length, coveredParagraphCount: covered };
}

/**
 * 拿原文逐句核对生成剧本：
 * 1. 覆盖率：原文「」数 vs 剧本 dialogue 数；
 * 2. 逐句定位：按顺序在原文中查找每句台词（全文→首12字→尾12字），找不到记 not-in-source，
 *    只在游标之前找到记 order-suspect（疑似乱序/并句）；
 * 3. 说话人：用引号前后 14 字人名＋说话动词启发式推断，与 LLM 的 characterId 不一致记 context-mismatch；
 * 4. 第三人称自指：台词含"对{自己名字}来说"而说话人正是本人，记 third-person-self。
 * 只做校验不改写，由调用方决定告警/重试。
 */
export function verifyScriptAgainstSource(
  chapterText: string,
  scenes: { lines: { type: string; characterId?: string; text: string }[] }[],
  characters: { id: string; name: string }[],
): ScriptVerifyResult {
  const src = chapterText || "";
  const aliasOwners = new Map<string, Set<string>>();
  const idToNames = new Map<string, string[]>();
  for (const c of characters) {
    const aliases = nameAliases(c.name);
    idToNames.set(c.id, [c.name, ...aliases]);
    for (const a of aliases) {
      const owners = aliasOwners.get(a) ?? new Set<string>();
      owners.add(c.id);
      aliasOwners.set(a, owners);
    }
  }
  // 只有唯一归属的别名才能用于自动建议；同一别名指向多个角色（如「小明」同属「小明」与「王小明」）时
  // 旧实现 first-wins 会给出确定性错误建议，改为只标注「别名歧义」不自动建议
  const aliasToId = new Map<string, string>();
  for (const [alias, owners] of aliasOwners) {
    if (owners.size === 1) aliasToId.set(alias, [...owners][0]);
  }
  const idToName = new Map(characters.map((c) => [c.id, c.name]));
  const originalQuoteCount = countSourceQuotes(src);
  let dialogueCount = 0;
  let notFoundCount = 0;
  let orderSuspectCount = 0;
  const speakerIssues: SpeakerIssue[] = [];
  let cursor = 0;

  interface ContextGuess {
    id?: string;
    ambiguousAlias?: string;
    ambiguousOwnerIds?: string[];
  }
  const guessFromContext = (pos: number, needleLen: number): ContextGuess => {
    const before = src.slice(Math.max(0, pos - 14), pos);
    const after = src.slice(pos + needleLen, pos + needleLen + 14);
    for (const [alias, id] of aliasToId) {
      if (before.includes(alias)) return { id };
    }
    for (const [alias, id] of aliasToId) {
      if (after.startsWith(alias) && SPEECH_VERBS.test(after.slice(alias.length, alias.length + 6))) return { id };
    }
    // 上下文里出现歧义别名：不返回建议，只把歧义信息带出去供调用方标注
    for (const [alias, owners] of aliasOwners) {
      if (owners.size < 2) continue;
      const hit = before.includes(alias)
        || (after.startsWith(alias) && SPEECH_VERBS.test(after.slice(alias.length, alias.length + 6)));
      if (hit) return { ambiguousAlias: alias, ambiguousOwnerIds: [...owners] };
    }
    return {};
  };

  scenes.forEach((scene, si) => {
    scene.lines.forEach((line, li) => {
      if (line.type !== "dialogue") return;
      dialogueCount++;
      const text = line.text || "";
      const speakerName = idToName.get(line.characterId || "") || line.characterId || "";
      // 第三人称自指：先验规则，无需定位
      const selfAliases = idToNames.get(line.characterId || "") ?? [speakerName];
      for (const a of selfAliases) {
        if (a.length >= 2 && text.includes(`对${a}来说`)) {
          speakerIssues.push({
            sceneIndex: si,
            lineIndex: li,
            text: text.slice(0, 60),
            llmSpeakerId: line.characterId || "",
            llmSpeakerName: speakerName,
            reason: "third-person-self",
            detail: `台词含"对${a}来说"却归属${speakerName}本人，疑似张冠李戴`,
          });
          break;
        }
      }
      // 顺序扫描定位
      let pos = text ? src.indexOf(text, cursor) : -1;
      let needleLen = text.length;
      if (pos < 0 && text.length > 12) {
        const head = text.slice(0, 12);
        pos = src.indexOf(head, cursor);
        needleLen = head.length;
      }
      if (pos < 0 && text.length > 12) {
        const tail = text.slice(-12);
        pos = src.indexOf(tail, cursor);
        needleLen = 0; // 尾部命中只用于说话人推断，不推进游标
      }
      if (pos < 0) {
        const anywhere = text ? src.indexOf(text, 0) : -1;
        if (anywhere >= 0 && anywhere < cursor) {
          orderSuspectCount++;
          pos = anywhere;
          needleLen = 0;
          speakerIssues.push({
            sceneIndex: si,
            lineIndex: li,
            text: text.slice(0, 60),
            llmSpeakerId: line.characterId || "",
            llmSpeakerName: speakerName,
            reason: "order-suspect",
            detail: "台词只在已扫描过的位置找到，疑似乱序或跨段并句",
          });
        } else {
          notFoundCount++;
          speakerIssues.push({
            sceneIndex: si,
            lineIndex: li,
            text: text.slice(0, 60),
            llmSpeakerId: line.characterId || "",
            llmSpeakerName: speakerName,
            reason: "not-in-source",
            detail: "原文中找不到该句，疑似改写/新增台词",
          });
          return;
        }
      }
      const guessed = guessFromContext(pos, needleLen);
      if (guessed.id && guessed.id !== line.characterId) {
        speakerIssues.push({
          sceneIndex: si,
          lineIndex: li,
          text: text.slice(0, 60),
          llmSpeakerId: line.characterId || "",
          llmSpeakerName: speakerName,
          suggestedSpeakerId: guessed.id,
          suggestedSpeakerName: idToName.get(guessed.id) || guessed.id,
          reason: "context-mismatch",
          detail: `原文上下文指向${idToName.get(guessed.id) || guessed.id}，剧本归属${speakerName}`,
        });
      } else if (
        !guessed.id
        && guessed.ambiguousAlias
        && !(guessed.ambiguousOwnerIds ?? []).includes(line.characterId || "")
      ) {
        // 别名歧义：上下文别名对应多个角色且当前说话人不在其中——不自动给建议，只标注请人工确认
        speakerIssues.push({
          sceneIndex: si,
          lineIndex: li,
          text: text.slice(0, 60),
          llmSpeakerId: line.characterId || "",
          llmSpeakerName: speakerName,
          reason: "context-mismatch",
          detail: `原文别名「${guessed.ambiguousAlias}」同时对应${(guessed.ambiguousOwnerIds ?? []).map((id) => idToName.get(id) || id).join("/")}，别名歧义无法自动建议说话人，请人工确认`,
        });
      }
      if (needleLen > 0) cursor = pos + needleLen;
    });
  });

  const coverage = narrationCoverage(src, scenes);
  return {
    originalQuoteCount,
    dialogueCount,
    keptRatio: originalQuoteCount > 0 ? dialogueCount / originalQuoteCount : 1,
    paragraphCount: coverage.paragraphCount,
    coveredParagraphCount: coverage.coveredParagraphCount,
    narrationRatio: coverage.paragraphCount > 0 ? coverage.coveredParagraphCount / coverage.paragraphCount : 1,
    notFoundCount,
    orderSuspectCount,
    speakerIssues,
  };
}

/** 覆盖率低于此值且原文引语足够多时，管线自动重写该章一次（最多 1 次） */
export const SCRIPT_MIN_KEPT_RATIO = 0.85;

/** 段落覆盖率低于此值且原文段落足够多时（且未开启压缩旁白），管线自动重写该章一次（#794） */
export const SCRIPT_MIN_NARRATION_RATIO = 0.6;

/** 存疑项稳定 key（忽略表用）：场景序号:行序号:原因 */
export function verifyIssueKey(sceneIndex: number, lineIndex: number, reason: SpeakerIssue["reason"]): string {
  return `${sceneIndex}:${lineIndex}:${reason}`;
}

/** 接受建议说话人（纯函数）：把指定对话行的 characterId 改为新说话人，不碰其它内容 */
export function applySpeakerFix(script: ChapterScript, sceneIndex: number, lineIndex: number, newCharacterId: string): ChapterScript {
  const next: ChapterScript = JSON.parse(JSON.stringify(script));
  const line = next.scenes[sceneIndex]?.lines[lineIndex];
  if (!line) throw new Error(`剧本中找不到场景${sceneIndex + 1}#${lineIndex + 1}`);
  if (line.type !== "dialogue") throw new Error(`场景${sceneIndex + 1}#${lineIndex + 1}不是对话，无法改说话人`);
  line.characterId = newCharacterId;
  return next;
}

/** 删除疑似新增/错位台词（纯函数）：删除指定行；场景保留（背景仍需它），行号整体前移 */
export function deleteScriptLine(script: ChapterScript, sceneIndex: number, lineIndex: number): ChapterScript {
  const next: ChapterScript = JSON.parse(JSON.stringify(script));
  const scene = next.scenes[sceneIndex];
  if (!scene || !scene.lines[lineIndex]) throw new Error(`剧本中找不到场景${sceneIndex + 1}#${lineIndex + 1}`);
  scene.lines.splice(lineIndex, 1);
  return next;
}

export interface ScriptVerifyFile {
  version: 1;
  chapterIndex: number;
  title: string;
  /** 与剧本缓存同一指纹公式：原文/标题/文风任一变化即换文件，旧核对自动失效 */
  textFp: string;
  at: string;
  result: ScriptVerifyResult;
  /** 已忽略的存疑 key（verifyIssueKey），重验时保留 */
  ignored: string[];
}

/** 核对报告文件名：与剧本缓存同键（script_verify_chN_<rest>.json），剧本重写即换文件 */
export function scriptVerifyFileName(
  cacheDir: string,
  demo: boolean,
  chapterIndex: number,
  title: string,
  text: string,
  styleFrag: string,
): string {
  return `${cacheDir}/${demo ? "script_verify_demo" : "script_verify"}_ch${chapterIndex + 1}_${scriptCacheRest(title, text, styleFrag)}.json`;
}

export async function readScriptVerify(path: string): Promise<ScriptVerifyFile | null> {
  try {
    const { text } = await tauri.readTextFile(path);
    const parsed = JSON.parse(text) as Partial<ScriptVerifyFile>;
    if (!parsed || !parsed.result || !Array.isArray(parsed.result.speakerIssues) || !Array.isArray(parsed.ignored)) return null;
    return parsed as ScriptVerifyFile;
  } catch {
    return null;
  }
}

export async function writeScriptVerify(path: string, payload: ScriptVerifyFile): Promise<void> {
  await tauri.writeTextFile(path, JSON.stringify(payload, null, 2));
}
