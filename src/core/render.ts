import type { ChapterScript, CharacterCard, ItemCard, Line, SceneJSON } from "./types";

export interface RenderAssets {
  bg: Record<string, string>;
  cg: Record<string, string>;
  figure: Record<string, string>;
  item: Record<string, string>;
  vocal: Record<string, string>;
  bgm?: Record<string, string>;
  /** 图片小说分镜图（shot.id → 文件路径）；sprite 模式下为空 */
  shot?: Record<string, string>;
}

export interface RenderOptions {
  characters: CharacterCard[];
  items: ItemCard[];
  assets: RenderAssets;
  videos?: Record<string, string>;
  seenCharacters?: Set<string>;
  introCard?: boolean;
  figureEmotions?: boolean;
  /** 人物动作：入场/退场动画、情绪动作、剧情镜头震动；默认开启 */
  figureActions?: boolean;
  /** 环境音效音量（0-100，默认 35）：旧硬编码 25 偏小，快进/手机外放下几乎听不见 */
  seVolume?: number;
  /** 环境音效（SE，按场景氛围播放雨/雷/风等）：新项目默认关闭；undefined 兼容旧项目仍输出，false 时不输出 playEffect，成品完全静音 */
  useSe?: boolean;
  /** 视觉模式（#810）：sprite=立绘版（默认）；imageOnly=图片小说——跳过 changeFigure 全家族，按 shot.triggerLineIndex 淡入切换全屏图 */
  mode?: "sprite" | "imageOnly";
}

export function sanitizeId(id: string): string {
  const cleaned = (id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unnamed";
}

/** 原文语种推断（UI98：「不翻译（使用原文）」时用于 Default_Language / 鉴赏室语言）。
 *  假名 → ja、谚文 → ko、其余 CJK → zh_CN、拉丁 → en；仍无法判断才 zh_CN。
 *  只统计前 2 万字符，长篇小说不拖慢组装。 */
export function inferWebgalLanguage(text: string): WebgalLanguage {
  const sample = (text || "").slice(0, 20000);
  let kana = 0;
  let hangul = 0;
  let cjk = 0;
  let latin = 0;
  for (const ch of sample) {
    if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(ch)) kana++;
    else if (/[\uac00-\ud7af\u1100-\u11ff]/.test(ch)) hangul++;
    else if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  if (hangul > 0 && hangul >= kana) return "ko";
  if (kana > 0) return "ja";
  if (cjk > latin) return "zh_CN";
  if (latin > 0) return "en";
  return "zh_CN";
}

/** 台词配音键：渲染与配音阶段共用同一公式，保证键一致 */
export function sceneVocalKey(chapter: number, sceneId: string, idx: number): string {
  return `ch${chapter}_${sanitizeId(sceneId)}_${idx}`;
}

/** 单条语音的合成上限（字符）：超长台词按句拆成多段配音，避免「玩家读到全文、听到的只有前 N 字」。
 *  voice 阶段的 buildVoiceJobs 与渲染层共用本常量与拆分函数，保证 key 一一对应。 */
export const TTS_SPEECH_MAX_CHARS = 500;

/** 把超长台词切成 ≤maxChars 的若干段：优先在句末标点断句；最后一段过短则并入上一段。 */
export function splitLineForSpeech(text: string, maxChars = TTS_SPEECH_MAX_CHARS): string[] {
  const t = (text || "").trim();
  if (!t) return [""];
  if (t.length <= maxChars) return [t];
  const out: string[] = [];
  let buf = "";
  for (const ch of t) {
    buf += ch;
    const atSentence = /[。！？…；!?;]/.test(ch) && buf.trim().length >= maxChars * 0.5;
    if (atSentence || buf.length >= maxChars) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  if (out.length > 1 && out[out.length - 1].length < 8) {
    const tail = out.pop()!;
    out[out.length - 1] += tail;
  }
  return out.length ? out : [t];
}

/** 分段配音键：单段沿用原 key（兼容既有缓存）；多段时统一加 _pN 后缀（含第 1 段，
 *  避免旧的「截断版」缓存被当成第 1 段的正确音频复用）。 */
export function sceneVocalKeyPart(baseKey: string, si: number, total = 1): string {
  return total <= 1 ? baseKey : `${baseKey}_p${si + 1}`;
}

function esc(text: string): string {
  return (text || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\./g, "\\.")
    .replace(/`/g, "\\`")
    // 空格+连字符会被引擎当成指令选项（`/ -/` 解析），导致该行文字从 " -" 处被腰斩；
    // 替换为非断连字符（视觉几乎一致，但不触发选项解析）
    .replace(/ -/g, " \u2011")
    .replace(/\r?\n/g, " ");
}

function comment(text: string): string {
  return (text || "").replace(/\r?\n/g, " ").slice(0, 80);
}

function sanitizeLabel(text: string): string {
  return (text || "章节").replace(/[\\/:*?"<>|\r\n;]/g, "_").slice(0, 30);
}

function getBaseName(f: string): string {
  return f.split(/[\\/]/).pop() || f;
}

/* ===== 人物动作：入场动画 + 情绪动作 + 剧情镜头震动 ===== */

const ENTRANCES = ["enter-from-left", "enter-from-right", "enter-from-bottom"];

/** 全身立绘 → 游戏内半身取景：素材按 head-to-feet 生成，舞台用「放大 + 下移」取到头像~大腿的构图
 *（近似旧版 thighs-up 立绘观感）。数值按「1920×1080 舞台 + 1024² 立绘 contain 到高度」几何推算：
 *  原图高 1080 居中 → 放大 1.75 = 1890，再下移 350 → 可见顶部约 57%（头到腿）。
 *  #1141：取景为固定行为（原先的 figureFraming 参数无任何调用方，'full' 分支是死代码，已移除）。 */
const FIGURE_FRAMING = '{"scale":{"x":1.75,"y":1.75},"position":{"x":0,"y":350}}';
/** 高潮句推近：在半身取景基础上再放大一档（取到头~腰），结束后回到 FIGURE_FRAMING */
const FIGURE_FRAMING_ZOOM = '{"scale":{"x":1.96,"y":1.96},"position":{"x":0,"y":518}}';

/** BGM 鉴赏显示名：按文件名关键词给出中文氛围标签，未命中则清洗文件名（去掉 _- 与扩展名） */
const BGM_MOOD_LABELS: Array<[RegExp, string]> = [
  [/battle|war|fight|combat|epic|tense|danger|boss|战|斗|激/i, "战斗"],
  [/calm|peace|piano|ambient|quiet|soft|daily|gentle|静|平|舒/i, "安静"],
  [/sad|sorrow|tear|grief|lonely|悲|哀|伤/i, "伤感"],
  [/happy|joy|bright|cheer|warm|comedy|欢|轻快|暖/i, "明快"],
  [/mystery|dark|suspense|moon|night|shadow|神秘|悬疑|夜/i, "神秘"],
  [/morning|dawn|sunrise|晨|朝/i, "清晨"],
];

function bgmDisplayName(file: string): string {
  const base = file.replace(/\.(mp3|ogg|wav|m4a|opus)$/i, "");
  const clean = base.replace(/[_-]+/g, " ").trim();
  const hit = BGM_MOOD_LABELS.find(([re]) => re.test(base));
  return hit ? `${hit[1]} · ${clean}` : clean;
}

/** 情绪 → 角色临时动作（作用于 fig-left，即当前说话角色所在插槽） */
function motionFor(emotion?: string): string | null {
  switch (emotion) {
    case "angry":
      return '[{"duration":0},{"position":{"x":-10,"y":0},"duration":70},{"position":{"x":10,"y":0},"duration":140},{"position":{"x":-10,"y":0},"duration":140},{"position":{"x":0,"y":0},"duration":70}]';
    case "surprised":
      return '[{"duration":0},{"scale":{"x":1.08,"y":1.08},"duration":180},{"scale":{"x":1,"y":1},"duration":180}]';
    case "happy":
      return '[{"duration":0},{"position":{"x":0,"y":-14},"duration":170},{"position":{"x":0,"y":0},"duration":170}]';
    case "sad":
      return '[{"duration":0},{"position":{"x":0,"y":6},"duration":320},{"position":{"x":0,"y":0},"duration":320}]';
    default:
      return null;
  }
}

/** 旁白/剧情中有明显动作或冲击感 → 触发舞台镜头震动 */
/** 环境音效匹配：按场景氛围/时间/地点关键词输出 SE（playEffect），无匹配返回 null */
function detectSe(scene: SceneJSON): string | null {
  const hay = `${scene.location} ${scene.atmosphere ?? ""} ${scene.time ?? ""}`;
  if (/雨|下雨|大雨|雷雨|暴雨|骤雨/.test(hay)) return "rain";
  if (/雷|闪电|轰鸣/.test(hay)) return "thunder";
  if (/风|风声|呼啸|寒风/.test(hay)) return "wind";
  if (/战斗|打斗|激战|厮杀|搏斗|混战|战场|交锋/.test(hay)) return "battle";
  if (/剑|拔刀|挥剑|武器|刀光|兵刃/.test(hay)) return "sword";
  if (/门|敲门|推门|叩门|门环/.test(hay)) return "door";
  if (/脚步|脚步声|走廊|巷|小巷|逼近|接近/.test(hay)) return "step";
  if (/夜|深夜|阴森|阴冷|紧张|危险|追杀|逃亡|悬念|寂静/.test(hay)) return "tension";
  return null;
}

function isDramatic(text: string): boolean {
  return /(轰鸣|爆炸|崩塌|巨响|震耳|怒吼|嘶吼|冲撞|猛然|狠狠|轰然|剧烈|颤抖|踉跄|飞扑|倒下|拔出|挥剑|斩|劈开)/.test(text);
}

/** 长消息按句读拆成多条 WebGAL 消息（一屏一句，接近 galgame 节奏）。
 * 仅在「无配音」时拆分：有配音的台词保持单条，避免换页掐断语音。 */
const MESSAGE_MAX_CHARS = 48;
/** 非 CJK（英文等）阈值：48 字符会从单词中间断开，放宽到约 120 并按单词/句末边界切 */
const MESSAGE_MAX_CHARS_LATIN = 120;

/** 非 CJK 文本按空格/句末标点切分，避免从单词中间硬切（UI106） */
function splitLatinMessage(t: string): string[] {
  if (t.length <= MESSAGE_MAX_CHARS_LATIN) return [t];
  const out: string[] = [];
  let buf = "";
  for (const word of t.split(/(\s+)/)) {
    buf += word;
    const trimmed = buf.trimEnd();
    if (trimmed.length >= MESSAGE_MAX_CHARS_LATIN * 0.75 && /[.!?;:]["')\]]?$/.test(trimmed)) {
      out.push(buf.trim());
      buf = "";
    } else if (buf.length >= MESSAGE_MAX_CHARS_LATIN) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [t];
}

function splitUnvoicedMessage(text: string, voiced: boolean): string[] {
  const t = (text || "").trim();
  if (voiced || !t) return [t];
  // 拉丁文本走单词边界；CJK 维持 48 字按句读拆分（一屏一句）
  if (!/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return splitLatinMessage(t);
  const out: string[] = [];
  let buf = "";
  for (const ch of t) {
    buf += ch;
    if (/[。！？…；]/.test(ch) && buf.length > 0) {
      out.push(buf.trim());
      buf = "";
    } else if (buf.length >= MESSAGE_MAX_CHARS) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [t];
}

/** 文本框单页字符上限（UI99）：2560×1440 设计画布下约 3 行；超过则在语句/单词边界插入
 *  WebGAL 的 `|` 行分段（同一句内多行），配合 config 的 Max_line 避免长台词溢出对话框。 */
export const TEXTBOX_PAGE_MAX_CHARS = 140;
export function paginateForTextBox(text: string, maxChars = TEXTBOX_PAGE_MAX_CHARS): string {
  const t = text || "";
  if (t.length <= maxChars) return t;
  const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t);
  const out: string[] = [];
  let buf = "";
  for (const ch of t) {
    buf += ch;
    const softBreak = cjk
      ? /[。！？…；!?;]/.test(ch)
      : /\s$/.test(buf) || /[.!?;]["')\]]?\s*$/.test(buf);
    if ((softBreak && buf.length >= Math.floor(maxChars * 0.6)) || buf.length >= maxChars) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out.join("|") : t;
}

/** 动作标签 → 情绪推断（与 script.ts emotionOf 同口径，供渲染层吸收动作标签时使用） */
function emotionFromTag(text: string): string | undefined {
  if (/(叹|哀|难过|哭|忧|落寞|沉默)/.test(text)) return "sad";
  if (/(笑|高兴|开心|喜|得意)/.test(text)) return "happy";
  if (/(怒|吼|咬牙|冷冷|斥|暴)/.test(text)) return "angry";
  if (/(惊|怔|愕|愣)/.test(text)) return "surprised";
  return undefined;
}

/** 动作标签旁白：以冒号结尾、且含说话/动作描写（如「老铁匠叹了口气：」「林澈微微皱眉：」）。
 * 这类行是小说式引语标签，galgame 里不独立显示，应并入下一句对话。 */
function isActionTagNarration(text: string): boolean {
  const t = (text || "").trim();
  if (!/[：:]$/.test(t)) return false;
  return /(说|道|答|喊|叹|笑|问|吩咐|回应|开口|沉声道|缓缓道|低声道|冷冷道|大声道|喃喃|皱眉|点头|摇头|沉默|迟疑|苦笑|微笑|起身|抬头|低头|转身|伸手|握拳|叹口气)/.test(t);
}


function renderItemEvent(scene: SceneJSON, idx: number, opts: RenderOptions, itemById?: Map<string, ItemCard>): string[] {
  const ev = scene.itemEvents[idx];
  if (!ev) return [];
  const item = itemById?.get(ev.itemId) ?? opts.items.find((i) => i.id === ev.itemId);
  const file = opts.assets.item[ev.itemId];
  const name = comment(item?.name || ev.itemId);
  const desc = esc(ev.description || item?.appearance || "道具出现");
  const safeItemId = sanitizeId(ev.itemId);
  const out: string[] = [];
  out.push(`; ---- 物品演出：${name} ----`);
  // 图片小说模式无立绘舞台：物品图标演出（changeFigure -id=item_*）跳过，只保留文字卡
  const iconEnabled = file && opts.mode !== "imageOnly";
  if (iconEnabled) {
    out.push(`changeFigure:${getBaseName(file)} -id=item_${safeItemId} -next;`);
  }
  out.push(`intro:「${esc(item?.name || ev.itemId)}」|${desc} -hold -backgroundColor=rgba(0,0,0,0.45);`);
  if (iconEnabled) {
    out.push(`changeFigure:none -id=item_${safeItemId} -next;`);
  }
  return out;
}

export function renderChapter(
  chapter: ChapterScript,
  opts: RenderOptions,
  chapterCount: number,
): string {
  const out: string[] = [];
  const imageOnly = opts.mode === "imageOnly";
  out.push(`; ===== 第 ${chapter.chapter + 1} 章 ${comment(chapter.title)} =====`);
  out.push(`; 由 NovelForge 自动生成`);
  out.push("");
  // 章节标签：供 WebGAL 流程图（任务/章节选择界面）显示与跳转
  out.push(`label:ch${chapter.chapter + 1}_${sanitizeLabel(chapter.title)};`);
  // 清场：避免上一章节的立绘残留（图片小说模式无立绘，整族 changeFigure 指令都不输出，见 #810）
  const useActions = opts.figureActions !== false;
  const clearExit = useActions ? " -exit=exit" : "";
  if (!imageOnly) {
    out.push(`changeFigure:none -left${clearExit} -next;`);
    out.push(`changeFigure:none${clearExit} -next;`);
    out.push(`changeFigure:none -right${clearExit} -next;`);
  }
  // 跨章演出复位（#789）：引擎的 changeScene 不清舞台，上一章的 BGM/黑边/滤镜会残留进本章。
  // 章首显式归零，避免「上一章的紧张黑边/胶片颗粒/音乐带进本章无配乐场景」。
  out.push(`; ---- 跨章复位 ----`);
  out.push(`bgm:none -enter=0 -next;`);
  out.push(`filmMode:none;`);
  out.push(`setTransform:{"oldFilm":0} -target=bg-main -duration=0 -next;`);
  out.push(`setTransform:{"godrayFilm":0} -target=bg-main -duration=0 -next;`);
  // 章节标题卡：黑屏全屏章节名（成熟视觉小说标配，点击继续）。
  // 标题本身已含「第X章/第X卷」时不再重复拼「第 N 章 ·」（用户实测：显示成「第 1 章 · 第一卷 第一章 …」）
  out.push(`; ---- 章节标题卡 ----`);
  const rawChapterTitle = (chapter.title ?? "").trim();
  const cardTitle = /第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节话篇部幕卷]/.test(rawChapterTitle)
    ? rawChapterTitle
    : `第 ${chapter.chapter + 1} 章 · ${rawChapterTitle}`;
  out.push(`intro:${esc(cardTitle)} -fontColor=rgba(255,255,255,1) -fontSize=large -hold;`);

  // 舞台立绘管理：同时最多 2 个角色（左/右插槽），新角色出现时按最近说话顺序驱逐
  const stageSlot = new Map<string, "left" | "right">();
  const stageOrder: string[] = [];
  const lastFigureFile = new Map<string, string>();
  // 换装状态：角色标注 costume 后沿用该服装，直到再次标注（跨场景保留，章节结束重置）
  const costumeState = new Map<string, string>();
  let entranceIdx = 0;
  // BGM 状态：WebGAL 的 changeScene 不自动清舞台，跨场景/跨章节残留的音乐需显式停止
  let lastBgm: string | null = null;
  let lastSe: string | null = null;
  const bgmUnlocked = new Set<string>();
  // 自动电影黑边 / 影调滤镜 状态（按值变化输出，避免每行重复指令）
  let lastFilm = false;
  let lastFilter = "";
  // 动作标签吸收状态：形如「老铁匠叹了口气：」的旁白并入下句对话（不独立成行）
  let pendingTag: { speakerId?: string; emotion?: string } | null = null;
  // 热循环预索引：避免每行/每道具事件线性扫描（数千行 × 数十角色）
  const charById = new Map(opts.characters.map((c) => [c.id, c]));
  const itemById = new Map(opts.items.map((i) => [i.id, i]));

  // 台词文本输出（立绘版/图片版共用）：超长台词按句拆成多段（每段一条消息 + 独立配音），
  // 修复「玩家读到全文、听到的却只有前 500 字」的声画不一致
  const emitDialogueText = (line: Line, scene: SceneJSON, idx: number, name: string): void => {
    const baseKey = sceneVocalKey(chapter.chapter, scene.id, idx);
    const vocalFile = opts.assets.vocal[baseKey];
    const vocalArg = vocalFile ? ` -${getBaseName(vocalFile)}` : "";
    const speechParts = splitLineForSpeech(line.text);
    if (speechParts.length > 1) {
      speechParts.forEach((seg, si) => {
        const partFile = opts.assets.vocal[sceneVocalKeyPart(baseKey, si, speechParts.length)];
        out.push(`${name}:${esc(paginateForTextBox(seg))}${partFile ? ` -${getBaseName(partFile)}` : ""};`);
      });
    } else {
      // 长句按句读拆成多条消息（一屏一句）；有配音的保持单条，避免换页掐断语音
      const segs = splitUnvoicedMessage(line.text, !!vocalFile);
      segs.forEach((seg, si) => {
        out.push(`${name}:${esc(paginateForTextBox(seg))}${si === 0 ? vocalArg : ""};`);
      });
    }
  };

  // 单句渲染（主流程与分支选择共用），idx 为台词在场景内的配音键序号
  const renderLine = (line: Line, idx: number, scene: SceneJSON): void => {
    // 防御：旧缓存剧本可能含空 text 行，直接跳过避免生成空指令/崩溃
    if (!line || !line.text || !String(line.text).trim()) return;
    if (line.type === "dialogue") {
      if (imageOnly) {
        // 图片小说（#810）：无立绘/入场/动作/资料卡；高潮句只做背景震动与虚化，文本与配音与立绘版同口径
        if (useActions && isDramatic(line.text)) {
          out.push(`setAnimation:shake -target=bg-main -next;`);
          out.push(`setTransform:{"blur":5} -target=bg-main -duration=700 -next;`);
          out.push(`setTransform:{"blur":0} -target=bg-main -duration=900 -next;`);
        }
        const speaker = charById.get(line.characterId || "") ?? opts.characters.find((c) => c.id === line.characterId);
        if (speaker) {
          emitDialogueText(line, scene, idx, esc(speaker.name));
        } else {
          // 说话人不可识别时按旁白输出，避免生成「???」人名
          const narVocal = opts.assets.vocal[sceneVocalKey(chapter.chapter, scene.id, idx)];
          out.push(`:${esc(paginateForTextBox(line.text))}${narVocal ? ` -${getBaseName(narVocal)}` : ""};`);
        }
        return;
      }
      // 动作标签吸收：形如「老铁匠叹了口气：」的旁白并入本句
      // （说话人缺失/情绪默认时用标签推断；已有明确说话人的不覆盖，交给核对系统把关）
      const tag = pendingTag;
      pendingTag = null;
      const effCharId = (!line.characterId || line.characterId === "narrator") && tag?.speakerId ? tag.speakerId : line.characterId;
      const effEmotion = (!line.emotion || line.emotion === "normal") && tag?.emotion ? tag.emotion : line.emotion;
      const char = charById.get(effCharId) ?? opts.characters.find((c) => c.id === effCharId);
      // 换装：本句标注 costume 即切换并记住；服装图只有 normal 姿态，换装期间表情差分暂停。
      // 服装图缺失时（如核心档不生成服装差分、服装图生成失败）回退默认立绘，且不抑制表情差分
      if (line.costume) costumeState.set(effCharId, line.costume);
      const wornId = costumeState.get(effCharId);
      const costumeFile = wornId
        ? (opts.assets.figure[`${effCharId}_ct_${wornId}`] ?? opts.assets.figure[`${effCharId}_ct_${sanitizeId(wornId)}`])
        : undefined;
      const worn = costumeFile ? wornId : undefined;
      const figureFile = costumeFile ?? opts.assets.figure[effCharId];
      // 立绘优先级：台词指定动作 → 对应动作立绘；否则（无换装时）表情差分立绘；否则默认/服装立绘
      let displayFile = figureFile;
      if (line.action) {
        // 动作 id 含中文/空格等特殊字符时，生产用裸 id、此处消毒，两边对不上；
        // 先裸查再消毒查，兜住历史存量
        const actionFile = opts.assets.figure[`${effCharId}_act_${line.action}`]
          ?? opts.assets.figure[`${effCharId}_act_${sanitizeId(line.action)}`];
        if (actionFile) displayFile = actionFile;
      } else if (opts.figureEmotions !== false && effEmotion && effEmotion !== "normal") {
        // 表情 id 在任务构建时会 sanitize（自定义中文表情名）：先裸查再消毒查，兜住历史与新数据。
        // 换装时优先找该服装的表情差分；没有就回退默认服装的表情差分（旧实现直接放弃表情，哭泣/大笑只有平静脸）。
        const emoSuffixes = [effEmotion, sanitizeId(effEmotion)];
        const candidates = worn
          ? [
              ...emoSuffixes.map((e) => `${effCharId}_ct_${worn}_${e}`),
              ...emoSuffixes.map((e) => `${effCharId}_ct_${sanitizeId(worn)}_${e}`),
              ...emoSuffixes.map((e) => `${effCharId}_${e}`),
            ]
          : emoSuffixes.map((e) => `${effCharId}_${e}`);
        for (const key of candidates) {
          const f = opts.assets.figure[key];
          if (f) {
            displayFile = f;
            break;
          }
        }
      }
      // 舞台管理 + 人物动作：最多 2 个角色同台（左/右），新角色入场 / 表情切换 / 情绪动作
      let slot = stageSlot.get(effCharId);
      const appearing = !!displayFile && !slot;
      if (displayFile) {
        const figureChanged = appearing || displayFile !== lastFigureFile.get(effCharId);
        if (appearing) {
          // 分配插槽；左右满员则驱逐最久没说话的角色
          const used = new Set(stageSlot.values());
          if (!used.has("left")) {
            slot = "left";
          } else if (!used.has("right")) {
            slot = "right";
          } else {
            // 只从真正占着插槽的角色里挑最久没说话的：stageOrder 可能包含无立绘角色（无 slot），
            // 旧实现直接取 stageOrder 末位，其 victimSlot 为 undefined 时输出 `-undefined`，
            // 引擎按 center 处理 → 三人重叠、后续特写失效
            const victims = stageOrder.filter((id) => stageSlot.has(id));
            const victim = victims[victims.length - 1] ?? [...stageSlot.keys()][0];
            const victimSlot = victim ? stageSlot.get(victim) : undefined;
            if (victim && victimSlot) {
              out.push(`changeFigure:none -${victimSlot}${useActions ? " -exit=exit" : ""} -next;`);
              stageSlot.delete(victim);
              const vi = stageOrder.indexOf(victim);
              if (vi >= 0) stageOrder.splice(vi, 1);
              lastFigureFile.delete(victim);
              slot = victimSlot;
            } else {
              // 兜底（状态异常理论不可达）：清空双插槽重新分配，避免 undefined 插槽
              out.push(`changeFigure:none -left -next;`);
              out.push(`changeFigure:none -right -next;`);
              stageSlot.clear();
              stageOrder.length = 0;
              lastFigureFile.clear();
              slot = "left";
            }
          }
          stageSlot.set(effCharId, slot);
          if (useActions) {
            const entrance = ENTRANCES[entranceIdx++ % ENTRANCES.length];
            out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -enter=${entrance} -next;`);
          } else {
            out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -next;`);
          }
          // 半身取景：立绘就位后立即套用取景变换（duration=0 与入场动画不叠加）
          out.push(`setTransform:${FIGURE_FRAMING} -target=fig-${slot} -duration=0 -next;`);
        } else if (figureChanged) {
          out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -next;`);
          out.push(`setTransform:${FIGURE_FRAMING} -target=fig-${slot} -duration=0 -next;`);
        }
        lastFigureFile.set(effCharId, displayFile);
      }
      // 情绪动作：说话时的震动/弹出/跳动（入场那一句跳过，避免与入场动画叠加）
      if (useActions && displayFile && !appearing && slot && effEmotion && effEmotion !== "normal") {
        const motion = motionFor(effEmotion);
        if (motion) out.push(`setTempAnimation:${motion} -target=fig-${slot} -next;`);
      }
      // 高潮台词演出：背景虚化 + 说话立绘特写推进（1500ms），句末回到半身取景
      if (useActions && isDramatic(line.text)) {
        if (slot) {
          out.push(`setTransform:{"blur":5} -target=bg-main -duration=700 -next;`);
          out.push(`setTransform:${FIGURE_FRAMING_ZOOM} -target=fig-${slot} -duration=1500 -next;`);
          out.push(`setTransform:${FIGURE_FRAMING} -target=fig-${slot} -duration=800 -next;`);
          out.push(`setTransform:{"blur":0} -target=bg-main -duration=800 -next;`);
        }
      }
      // 更新最近说话顺序（用于驱逐）
      const oi = stageOrder.indexOf(effCharId);
      if (oi >= 0) stageOrder.splice(oi, 1);
      stageOrder.unshift(effCharId);
      // 首次登场资料演出：立绘 + 文本框资料卡（旁白形式，立绘保持可见；长文按句拆行）
      if (opts.introCard !== false && char && !opts.seenCharacters?.has(effCharId)) {
        opts.seenCharacters?.add(effCharId);
        const parts = [`【${esc(char.name)}】`];
        if (char.appearance) parts.push(esc(char.appearance));
        if (char.personality) parts.push(esc(char.personality));
        for (const seg of splitUnvoicedMessage(parts.join(" "), false)) {
          out.push(`:${esc(seg)};`);
        }
      }
      const name = esc(char?.name || effCharId || "???");
      emitDialogueText(line, scene, idx, name);
    } else {
      // 旁白与内心独白统一走普通旁白行：intro: 指令不带语音播放，
      // 之前独白渲染成 intro:…-v.mp3 导致引擎忽略语音后缀、独白全程无声。
      // 改回 ':' 旁白行后与配音任务同 key，语音正常播放。
      if (useActions && isDramatic(line.text)) {
        out.push(`setAnimation:shake -target=bg-main -next;`);
        out.push(`setTransform:{"blur":5} -target=bg-main -duration=700 -next;`);
        out.push(`setTransform:{"blur":0} -target=bg-main -duration=900 -next;`);
      }
      // 旁白同样带配音，避免整段静默；超长旁白与对话同口径按句拆段配音
      const narBaseKey = sceneVocalKey(chapter.chapter, scene.id, idx);
      const narVocalFile = opts.assets.vocal[narBaseKey];
      const narVocalArg = narVocalFile ? ` -${getBaseName(narVocalFile)}` : "";
      // B75：分段与配音阶段统一按「原始 line.text」切（voice.ts 同公式），
      // 渲染时再对每段单独加「」——旧实现先加引号再分段，_pN 段首/段尾多出引号，
      // 与配音任务的文本哈希对不上（长独白语音错位/无法复用）。
      const wrapMonologue = (s: string): string => {
        if (!line.monologue) return s;
        const trimmed = s.trim();
        return /^「.*」$/.test(trimmed) ? trimmed : `「${trimmed}」`;
      };
      const narParts = splitLineForSpeech(line.text);
      if (narParts.length > 1) {
        narParts.forEach((seg, si) => {
          const partFile = opts.assets.vocal[sceneVocalKeyPart(narBaseKey, si, narParts.length)];
          out.push(`:${esc(paginateForTextBox(wrapMonologue(seg)))}${partFile ? ` -${getBaseName(partFile)}` : ""};`);
        });
      } else {
        // 内心独白用「」包裹区分（WebGAL 无行内样式，括号标记最稳妥；独白不拆行）
        const narText = wrapMonologue(line.text);
        const narSegs = splitUnvoicedMessage(narText, !!narVocalFile || !!line.monologue);
        narSegs.forEach((seg, si) => {
          out.push(`:${esc(paginateForTextBox(seg))}${si === 0 ? narVocalArg : ""};`);
        });
      }
    }
  };

  for (const scene of chapter.scenes) {
    out.push("");
    out.push(`; ---- 场景：${comment(scene.location)}（${comment(scene.atmosphere)} ${comment(scene.time)}）----`);

    // 电影黑边 + 影调滤镜：紧张/战斗场景自动压暗黑边，回忆/梦境加胶片颗粒，其余恢复。
    // 引擎命令（filmMode / setFilter，滤镜参数与 Pixi 滤镜对象同名）已确认存在；按值变化输出。
    const mood = `${scene.atmosphere || ""} ${scene.location || ""}`;
    const wantFilm = /紧张|激烈|决战|战斗|高潮|危机|追逐|逃生|对峙/i.test(mood);
    const wantFilter = /回忆|梦境|往事|过去|童年|记忆|梦/i.test(mood) ? "oldFilm" : wantFilm ? "godrayFilm" : "";
    if (wantFilm !== lastFilm) {
      // 引擎语义：不填或填 none 才关闭电影模式，其他任何字符串（包括 "false"）都会开启。
      // 旧实现输出 filmMode:false，进入紧张场景后电影模式永不退出（自定义对话框消失、说话人名字不显示）
      out.push(`filmMode:${wantFilm ? "true" : "none"};`);
      lastFilm = wantFilm;
    }
    if (wantFilter !== lastFilter) {
      // setFilter 在 WebGAL 4.6.3 是空实现（处理器直接返回，不解析参数）：滤镜必须走 setTransform 的同名键
      if (lastFilter) out.push(`setTransform:{"${lastFilter}":0} -target=bg-main -duration=300 -next;`);
      if (wantFilter) out.push(`setTransform:{"${wantFilter}":0.35} -target=bg-main -duration=300 -next;`);
      lastFilter = wantFilter;
    }

    // BGM：匹配到的音乐文件则播放（并解锁鉴赏）；无匹配则淡出停止，避免串场
    const bgmFile = opts.assets.bgm?.[scene.id];
    if (bgmFile) {
      // 起播带淡入（-enter），与停止时的淡出对称，避免硬切出戏；同曲连续场景不重播
      if (bgmFile !== lastBgm) {
        out.push(`bgm:${getBaseName(bgmFile)} -enter=1000 -next;`);
      }
      if (!bgmUnlocked.has(bgmFile)) {
        bgmUnlocked.add(bgmFile);
        // 鉴赏室显示可读中文标签（此前显示 bgm_ambient_1 这类原始文件名）
        const bgmName = bgmDisplayName(getBaseName(bgmFile));
        out.push(`unlockBgm:${getBaseName(bgmFile)} -name=${esc(bgmName)};`);
      }
      lastBgm = bgmFile;
    } else if (lastBgm) {
      out.push(`bgm:none -enter=600 -next;`);
      lastBgm = null;
    }

    const bgFile = opts.assets.bg[scene.id];
    // 图片小说分镜（#810）：按 triggerLineIndex 排序，只保留已有产物的分镜；有分镜时不再铺场景背景
    const shotList = imageOnly
      ? (scene.shots ?? [])
          .map((shot) => ({ shot, file: opts.assets.shot?.[shot.id] }))
          .filter((entry): entry is { shot: NonNullable<SceneJSON["shots"]>[number]; file: string } => !!entry.file)
          .sort((a, b) => a.shot.triggerLineIndex - b.shot.triggerLineIndex)
      : [];
    if (bgFile && (!imageOnly || !shotList.length)) {
      // 场景切换：干净利落的交叉淡化（WebGAL changeBg 自带透明度淡入，500ms 即完成），
      // 叠加轻微推近（Ken Burns 运镜）制造电影感，符合主流 galgame 的 dissolve 过渡。
      // 注意不要在此叠加 blur 聚焦——changeBg 已含淡入，双重动画叠加是"生硬"的来源。
      out.push(`changeBg:${getBaseName(bgFile)} -duration=500 -ease=easeInOut -next;`);
      if (useActions) {
        out.push(`setTransform:{"scale":{"x":1.04,"y":1.04}} -target=bg-main -duration=3000 -next;`);
      }
    }
    // 分镜切换：只淡入（#814 决策 9），不推近；同时解锁鉴赏室（分镜按 CG 画廊展示）
    let shotCursor = 0;
    const emitDueShots = (lineIndex: number): void => {
      while (shotCursor < shotList.length && shotList[shotCursor].shot.triggerLineIndex <= lineIndex) {
        const { shot, file } = shotList[shotCursor++];
        out.push(`changeBg:${getBaseName(file)} -duration=400 -ease=easeInOut -next;`);
        out.push(`unlockCg:${getBaseName(file)} -name=${esc(shot.note || scene.location || "分镜")};`);
      }
    };
    // 触发点 ≤ 0 的分镜在第一句之前就切换
    if (imageOnly) emitDueShots(0);
    // 环境音效（SE）：按场景氛围匹配播放（用户可用同名文件覆盖内置音效）
    // useSe === false（新项目默认）时完全不输出 playEffect；undefined 兼容旧项目仍按氛围输出
    const se = opts.useSe === false ? null : detectSe(scene);
    if (se && se !== lastSe) {
      lastSe = se;
      const seVolume = opts.seVolume ?? 35;
      out.push(`playEffect:se_${se}.wav -volume=${seVolume} -next;`);
    }

    // 视频推荐位：有用户放置的视频文件则播放，否则注释占位（不执行）
    for (const vp of scene.videoPoints || []) {
      const vfile = opts.videos?.[sanitizeId(vp.id)];
      if (vfile) {
        out.push(`; ---- 视频演出：${comment(vp.title)} ----`);
        out.push(`playVideo:${getBaseName(vfile)};`);
      } else {
        out.push(`; [视频位] ${comment(vp.title)}：${comment(vp.description)}（提示词见 video_plan.txt，把生成的 mp4 命名为 video_${sanitizeId(vp.id)}.mp4 放入 video 文件夹后刷新即启用）`);
      }
    }

    // CG 映射 key 为 `${chapter.chapter}_${scene.id}`（images.ts 按此记录），
    // 直接用 scene.id 查不到会导致 CG 演出整段被跳过；scene.cgFile 是生成阶段写入的捷径，两者都兜底。
    const cgFile = scene.cgFile || opts.assets.cg[`${chapter.chapter}_${scene.id}`] || opts.assets.cg[scene.id];
    const cg = scene.cgEvent;
    // 图片小说模式没有立绘舞台，CG 演出（清场/恢复立绘）整块跳过；分镜已承担画面切换
    if (cgFile && !imageOnly) {
      // CG 前记录立绘状态：播完 CG 原样恢复（不带入场动画），否则所有角色会带 enter 动画重新跳入
      const cgBefore = stageOrder
        .map((id) => ({ id, slot: stageSlot.get(id), file: lastFigureFile.get(id) }))
        .filter((b): b is { id: string; slot: "left" | "right"; file: string } => !!b.slot && !!b.file);
      // CG 整幅插画演出：先清空立绘（避免人物与 CG 同屏叠加），播 CG 后恢复原立绘状态
      out.push(`changeFigure:none -left${clearExit} -next;`);
      out.push(`changeFigure:none -right${clearExit} -next;`);
      stageSlot.clear();
      stageOrder.length = 0;
      // CG 后舞台实际已空，必须同步清立绘文件记忆，否则 CG 后同文件角色会被误判“未换装”而跳过 changeFigure，导致人物消失
      lastFigureFile.clear();
      out.push(`changeBg:${getBaseName(cgFile)} -duration=400 -ease=easeInOut -next;`);
      // 名场面特写运镜：缓慢推近 CG，强化冲击力
      out.push(`setTransform:{"scale":{"x":1.08,"y":1.08}} -target=bg-main -duration=2500 -next;`);
      // 有 cgEvent 用事件标题/描述，无事件（旧图残留/手动放图）也解锁，避免鉴赏室漏 CG
      out.push(`unlockCg:${getBaseName(cgFile)} -name=${esc(cg?.title || cg?.description || scene.location || "CG")};`);
      out.push(`:${esc(cg?.description || cg?.title || `${scene.location} ${scene.atmosphere || ""}`.trim() || "名场面")};`);
      out.push(`changeBg:${bgFile ? getBaseName(bgFile) : "none"} -duration=500 -ease=easeInOut -next;`);
      // 原样恢复 CG 前的立绘（无入场动画；状态同步回填，后续台词按原表情/服装继续）
      for (const b of cgBefore) {
        out.push(`changeFigure:${getBaseName(b.file)} -${b.slot} -next;`);
        out.push(`setTransform:${FIGURE_FRAMING} -target=fig-${b.slot} -duration=0 -next;`);
        stageSlot.set(b.id, b.slot);
        lastFigureFile.set(b.id, b.file);
        stageOrder.push(b.id);
      }
    }

    // 同一触发行支持多个物品事件：旧实现每个索引只保留第一个，多事件时后续事件被静默丢弃
    const eventIdxsByTrigger = new Map<number, number[]>();
    scene.itemEvents.forEach((ev, i) => {
      const arr = eventIdxsByTrigger.get(ev.triggerIndex) ?? [];
      arr.push(i);
      eventIdxsByTrigger.set(ev.triggerIndex, arr);
    });

    scene.lines.forEach((line, i) => {
      if (imageOnly) emitDueShots(i);
      const evIdxs = eventIdxsByTrigger.get(i);
      if (evIdxs) {
        for (const evIdx of evIdxs) out.push(...renderItemEvent(scene, evIdx, opts, itemById));
      }
      // 动作标签旁白（X说/叹气道：）不独立成行，吸收为下句对话的说话人/情绪线索
      const next = scene.lines[i + 1];
      if (line.type === "narration" && next?.type === "dialogue" && isActionTagNarration(line.text)) {
        const tagText = line.text.trim();
        const tagSpeaker = opts.characters.find((c) => tagText.includes(c.name));
        pendingTag = { speakerId: tagSpeaker?.id, emotion: emotionFromTag(tagText) };
        return;
      }
      renderLine(line, i, scene);
    });

    const lastEvIdxs = eventIdxsByTrigger.get(scene.lines.length);
    if (lastEvIdxs) {
      for (const evIdx of lastEvIdxs) out.push(...renderItemEvent(scene, evIdx, opts, itemById));
    }

    // 分支选择：场景末尾弹出选项，各分支为独立 label 块，结束后跳回合并点继续
    if (scene.choices && scene.choices.length) {
      const prefix = `ch${chapter.chapter + 1}_${sanitizeId(scene.id)}`;
      const joinLabel = `${prefix}_join`;
      const args = scene.choices
        .map((c, ci) => `${esc((c.prompt || "继续").replace(/\|/g, "｜"))}:${prefix}_c${ci + 1}`)
        .join("|");
      out.push("");
      out.push(`; ---- 分支选择 ----`);
      out.push(`choose:${args};`);
      scene.choices.forEach((c, ci) => {
        out.push(`label:${prefix}_c${ci + 1};`);
        c.lines.forEach((line, j) => renderLine(line, scene.lines.length + 1000 * (ci + 1) + j, scene));
        out.push(`jumpLabel:${joinLabel};`);
      });
      out.push(`label:${joinLabel};`);
    }
  }

  const isLast = chapter.chapter + 1 >= chapterCount;
  if (isLast) {
    out.push("");
    out.push(`end;`);
  } else {
    out.push("");
    out.push(`changeScene:ch${chapter.chapter + 2}.txt;`);
  }

  return out.join("\n");
}

export function renderStart(chapterCount: number, title: string): string {
  const out: string[] = [];
  out.push(`; ${comment(title)}`);
  out.push(`; 由 NovelForge 自动生成`);
  out.push("");
  if (chapterCount > 0) {
    out.push(`changeScene:ch1.txt;`);
  }
  return out.join("\n");
}

function cleanConfigValue(text: string): string {
  return (text || "").replace(/[;\r\n]+/g, " ").trim().slice(0, 60);
}

export type WebgalLanguage = "zh_CN" | "zh_TW" | "en" | "ja" | "ko";

export function renderConfig(
  title: string,
  gameKey: string,
  language: WebgalLanguage = "zh_CN",
  titleImg?: string,
  titleBgm?: string,
  gameLogo?: string,
  toggles?: { continue?: boolean; flowchart?: boolean; appreciation?: boolean },
): string {
  // 标题菜单各入口开关语义：
  //   continue      = Enable_Continue（继续游戏按钮）
  //   flowchart     = Enable_flowchart（流程图入口）
  //   appreciation  = Enable_Appreciation（鉴赏室入口）
  // 注意：引擎 4.6.3 没有 Enable_Save/Load/QuickSave/Options/Auto/Skip/Backlog 等键（全包 0 引用），
  // 这些菜单项无法通过配置关闭，不要臆造。
  const lines = [
    `Game_name:${cleanConfigValue(title)};`,
    `Game_key:${cleanConfigValue(gameKey)};`,
    `Enable_Appreciation:${toggles?.appreciation === false ? "false" : "true"};`,
    `Enable_Continue:${toggles?.continue === false ? "false" : "true"};`,
    `Enable_flowchart:${toggles?.flowchart === false ? "false" : "true"};`,
    `Show_panic:true;`,
    `Default_Language:${language};`,
    // 文本框排版（引擎 globalGameVar，UI99）：Max_line 限制一句内 `|` 分段的最多行数
    // （不写时 medium 字号默认只显示 2 行，长台词分页会被截掉），
    // Line_height 为行高（em），配合渲染层长台词 `|` 分页避免溢出对话框
    `Max_line:8;`,
    `Line_height:1.6;`,
  ];
  if (titleImg) lines.push(`Title_img:${cleanConfigValue(titleImg)};`);
  if (titleBgm) lines.push(`Title_bgm:${cleanConfigValue(titleBgm)};`);
  // 引擎把 Title_img / Game_Logo 按 ./game/background/<值> 解析（见 generateTitleArt）；
  // 缺失的 Title_img 会让入口页卡在白色遮罩，故只在确有文件时才写这两行
  if (gameLogo) lines.push(`Game_Logo:${cleanConfigValue(gameLogo)};`);
  return lines.join("\n");
}



