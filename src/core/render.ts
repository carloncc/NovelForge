import type { ChapterScript, CharacterCard, ItemCard, Line, SceneJSON } from "./types";
import { safeSlice } from "../utils/text";
import { normalizeEmotionId } from "./emotions";
import { normalizeEntityId } from "./ids";

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

interface RenderOptions {
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
  /** 天气粒子特效（pixiInit/pixiPerform，按场景氛围播雨/雪/樱花）：默认开启。
   *  与 useSe 共用同一个「氛围开关」语义：用户明确关掉氛围音时不再叠一层粒子动画
   *  （useSe===false 视为关闭，undefined/true 都输出），避免「静音但还在下雪」的半开状态。 */
  useWeather?: boolean;
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

/** 台词配音键（1462）：渲染与配音阶段共用同一公式，保证键一致。
 *  sanitizeId 会把非词字符折叠成 _，sc_a b 与 sc_a_b 会得到相同键（配音串台、分支 label 撞名）。
 *  仅当原始 id 被 sanitizeId「有损折叠」时才追加 4 位短哈希——如此既区分撞名 id，
 *  又让绝大多数（本就用 [A-Za-z0-9_-] 的）id 沿用历史键，旧配音文件无需迁移/重配。 */
export function sceneVocalKey(chapter: number, sceneId: string, idx: number): string {
  const clean = sanitizeId(sceneId);
  const suffix = clean === (sceneId || "") ? "" : `_${djb2Hash(sceneId).slice(0, 4)}`;
  return `ch${chapter}_${clean}${suffix}_${idx}`;
}

/** 旧版配音键（无哈希，1462 迁移用）：仅用于回退查找历史缓存，避免升级后旧项目装配时无声。 */
export function legacySceneVocalKey(chapter: number, sceneId: string, idx: number): string {
  return `ch${chapter}_${sanitizeId(sceneId)}_${idx}`;
}

/* ===== 文本框容量：一组必须同时成立的不变量 =====
 *
 * 引擎 4.6.6 的排版链路（反编译已核实）：
 *   TextBox 组件 → `const d = Number(globalGameVar.Max_line)`（NaN 时 medium=2/其余=2）
 *                → `Os(showText, d)`：先按**未转义** `|` 切段，再 `.slice(0, d)`
 *                → `p.map(...)`：**每个分段渲染成同级的一个 div**（key=`text-line-N`）
 * 即：`Max_line` **就是**文本框里铺出来的行数（不是「页数」，引擎没有翻页状态）。
 * 分段内部是 nowrap 的 span，所以**一个分段 = 一个视觉行**，长于一行宽度的部分被
 * `.text{overflow:hidden}` 与 nowrap 直接裁掉（既不折行也不换页）。
 *
 * 于是四个量必须自洽，任一项单独调大都会把文字裁掉（这正是 Max_line:8 那次 bug：
 * 8 行铺进只装得下 4 行的框，后 4 行玩家永远看不到，而 TTS 已经念完了全文）：
 *   textboxCharsPerLine()   ×  textboxVisibleLines()  =  textboxCapacityChars()
 *   textboxVisibleLines()      =  Max_line（config.txt，4.6.6 的引擎默认只有 2）
 *   TTS_SPEECH_MAX_CHARS       =  textboxCapacityChars()（单条消息不超一屏）
 *   TEXTBOX_PAGE_MAX_CHARS     =  textboxCharsPerLine()（1 个 `|` 分段 = 1 个视觉行）
 * tests/unit-fix-render.ts 会**直接解析 textbox.scss** 重算这些数并断言相等，几何一改就失败。
 * 当前值（2560×1440 舞台 / 590px 框 / 1.6 行高）：每行 41 字 × 5 行 = 205 字/条。
 */

/** 舞台尺寸（引擎常量 Qm={height:1440,width:2560}；#root 也是 2560×1440 再整体缩放）。 */
export const STAGE_WIDTH = 2560;
export const STAGE_HEIGHT = 1440;
/** 引擎根字号（index.css 的 `#root{font-size:160%}`）+ 正文字号（medium 时 HE()=205%）。
 *  1em 的绝对值 = 16 × 1.6 × 2.05 ≈ 52.48px，是下面所有像素推导的基准。 */
export const ROOT_FONT_SCALE = 1.6;
export const TEXTBOX_FONT_SCALE = 2.05;
/** 正文行高（em）：与 config.txt 的 Line_height、textbox.scss 的 line-height 三处同值。 */
export const TEXTBOX_LINE_HEIGHT_EM = 1.6;
/** 1 个中文字符的占位宽度（em）：全宽字形 1em + textbox.scss 的 letter-spacing 0.02em。 */
export const TEXTBOX_CHAR_WIDTH_EM = 1.02;

/** 文本框几何（设计像素）：与 src/gameExtra/game-ui/Stage/TextBox/textbox.scss 逐项对应。
 *  改动 SCSS 必须同步改这里（tests/unit-fix-render.ts 会直接解析 SCSS 重算，不一致即失败）。 */
export const TEXTBOX_GEOMETRY = {
  /** `.TextBox_main { max-height }`：装下 5 行所需的最小框高（322px 内容高只够 3 行）。
   *  430px 只够 3 行（≈123 字），500 字的配音台词会被裁掉三分之二，故提到 590px（5 行 ≈205 字）。 */
  boxHeightPx: 590,
  /** `.TextBox_main { left/right }` → 内容宽 = 舞台宽 − 2×96 */
  insetXPx: 96,
  /** `.TextBox_main { padding: 62px 80px 46px }`（上/左右/下） */
  paddingTopPx: 62,
  paddingXPx: 80,
  paddingBottomPx: 46,
  /** 引擎内联 `paddingLeft:"0.1em"` */
  enginePaddingLeftEm: 0.1,
} as const;

/** 一行最多放几个字符（向下取整）：nowrap 下超出即被裁，所以只能保守取整。 */
export function textboxCharsPerLine(): number {
  const em = 16 * ROOT_FONT_SCALE * TEXTBOX_FONT_SCALE * TEXTBOX_CHAR_WIDTH_EM;
  const width = STAGE_WIDTH - 2 * TEXTBOX_GEOMETRY.insetXPx - 2 * TEXTBOX_GEOMETRY.paddingXPx
    - TEXTBOX_GEOMETRY.enginePaddingLeftEm * 16 * ROOT_FONT_SCALE * TEXTBOX_FONT_SCALE;
  return Math.floor(width / em);
}

/** 文本框能完整显示的**整行**行数：部分露出的最后一行会被 overflow:hidden 拦腰裁断，
 *  故按 Math.floor 取整（不能四舍五入——0.9 行也只看得见半行字）。 */
export function textboxVisibleLines(): number {
  const lineHeightPx = 16 * ROOT_FONT_SCALE * TEXTBOX_FONT_SCALE * TEXTBOX_LINE_HEIGHT_EM;
  const content = TEXTBOX_GEOMETRY.boxHeightPx - TEXTBOX_GEOMETRY.paddingTopPx - TEXTBOX_GEOMETRY.paddingBottomPx;
  return Math.floor(content / lineHeightPx);
}

/** 单条消息的**可见**字符上限 = 整行数 × 每行字数。超过这个数的文字一定会被裁。 */
export function textboxCapacityChars(): number {
  return textboxVisibleLines() * textboxCharsPerLine();
}

/** 单条语音的合成上限（字符）：超长台词按句拆成多段配音，避免「玩家读到全文、听到的只有前 N 字」。
 *  voice 阶段的 buildVoiceJobs 与渲染层共用本常量与拆分函数，保证 key 一一对应。
 *  取值为 textboxCapacityChars()：一条消息 = 一屏可见，读数与听音严格同长。
 *  旧值 500 是「单条消息」的长度，而 500 字在 430px 高的框里只能显示约三分之一——
 *  播放器已经把全文念完时，玩家才读到一半（与旧版「引擎丢页」是同一类声画错位）。 */
export const TTS_SPEECH_MAX_CHARS = textboxCapacityChars();

/** 把超长台词切成 ≤maxChars 的若干段：优先在句末标点断句；最后一段过短则并入上一段。 */
export function splitLineForSpeech(text: string, maxChars = TTS_SPEECH_MAX_CHARS): string[] {
  const t = (text || "").trim();
  if (!t) return [""];
  if (t.length <= maxChars) return [t];
  const out: string[] = [];
  let buf = "";
  // #1545：长度按**码点**计，而不是 buf.length 的 UTF-16 码元数。
  // for...of 是按码点迭代的，一个 emoji / 生僻字算 1 个字符却是 2 个码元；
  // 旧实现 append 之后才判断 buf.length >= maxChars，于是 37 的上限能切出 38 长的一段。
  let bufLen = 0;
  for (const ch of t) {
    buf += ch;
    bufLen += 1;
    // 断句阈值仍按码元算：它只是「已过半」的启发式，不是上限，不参与 ≤maxChars 的保证
    const atSentence = /[。！？…；!?;]/.test(ch) && buf.trim().length >= maxChars * 0.5;
    if (atSentence || bufLen >= maxChars) {
      out.push(buf.trim());
      buf = "";
      bufLen = 0;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // #1545：短尾并入上一段时**必须同时守住 maxChars**。
  // 旧实现无条件拼接：前一段正好切到 maxChars、尾部不足 8 字时，拼出来就是 maxChars+7——
  // 直接违反上面「切成 ≤maxChars」的承诺（实测 500→503/507，maxChars=10 时更夸张到 16）。
  // TTS 侧的按段上限正是靠这个函数兜的，超限段会被整段送去做合成、超出部分不再被拆。
  // 尾部本来就只有几个字，与其拼出一个超限段，不如让它独立成段：短尾只是多一次合成，
  // 超限则是实打实越过接口约束。
  if (out.length > 1 && out[out.length - 1].length < 8) {
    const tail = out.pop()!;
    if (out[out.length - 1].length + tail.length <= maxChars) {
      out[out.length - 1] += tail;
    } else {
      out.push(tail); // 上一段已贴近上限，拼不动就独立成段
    }
  }
  return out.length ? out : [t];
}

/** 分段配音键：单段沿用原 key（兼容既有缓存）；多段时统一加 _pN 后缀（含第 1 段，
 *  避免旧的「截断版」缓存被当成第 1 段的正确音频复用）。 */
export function sceneVocalKeyPart(baseKey: string, si: number, total = 1): string {
  return total <= 1 ? baseKey : `${baseKey}_p${si + 1}`;
}

export function esc(text: string): string {
  return (text || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\./g, "\\.")
    // 反引号在引擎里不是元字符，其还原表（WSe）也只认 \\ \| \: \, \; \. 六条——
    // 旧实现把它转义成 \` 却没有还原规则，正文里的反引号会原样多出一个反斜杠。
    // 半角 [ ] 必须改全角：引擎的 qTe() 会把 [文本](值) 当增强文本解析成注音（ruby），
    // 正文里偶然出现的 [笑](laughing) 会被渲染成「笑」上标 laughing。选择支早已这么做。
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    // #1508：竖线必须转义。引擎的文本分页（Os）对**未转义**的 | 切段，而 NovelForge 自己又用 | 表示「分页」——
    // 台词里出现字面竖线（表格/分隔符）时会被当成翻页符，超出 Max_line 的后续段落被静默丢弃。
    // 引擎的还原表里有 \\| → |，转义后仍能正常显示为竖线。
    .replace(/\|/g, "\\|")
    // 空格+连字符会被引擎当成指令选项（`/ -/` 解析），导致该行文字从 " -" 处被腰斩；
    // 替换为非断连字符（视觉几乎一致，但不触发选项解析）
    .replace(/ -/g, " \u2011")
    .replace(/\r?\n/g, " ");
}

function comment(text: string): string {
  return safeSlice((text || "").replace(/\r?\n/g, " "), 80);
}

function sanitizeLabel(text: string): string {
  return safeSlice((text || "章节").replace(/[\\/:*?"<>|\r\n;]/g, "_"), 30);
}

/** 章节显示标题（1354）：统一宽口径去重 + 统一用重编号。
 *  宽正则 [章回节话篇部幕卷]（render 标题卡口径，修过“第1章·第一卷第一章”重复投诉）；
 *  标题自带编号时直接返回原标题，否则拼“第 N 章 · 原标题”。空标题只返回章号。 */
export function chapterDisplayTitle(chapterNumber: number, title: string): string {
  const raw = (title ?? "").trim();
  if (!raw) return `第 ${chapterNumber} 章`;
  if (/第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节话篇部幕卷]/.test(raw)) return raw;
  return `第 ${chapterNumber} 章 · ${raw}`;
}

/**
 * 渲染器已核实的 WebGAL 引擎版本（#1517）。
 *
 * 这是「渲染产物语法」的唯一事实来源：config.txt 的键集合、Max_line 的真实容量、
 * setFilter/setTransform 的语义差异等结论都只对 4.6.6 成立（见下方各处注释）。
 * 此前这个字面量在 pipeline.ts 两处 + project.ts 一处各写一遍，而模板版本由
 * scripts/fetch-webgal-template.mjs 独立升级——两处各改各的，渲染器就会对着
 * 未经核实的引擎语义生成游戏。故收敛到此处，并由组装阶段比对模板实际版本报警。
 *
 * 为什么从 4.6.3 提到 4.6.6：上游 4.6.4 起 changeFigure 的方位变化会清除旧的变换/滤镜，
 * 4.6.6 新增基于当前状态的 -v2 动画；本渲染器对这两点都已按「每次 changeFigure 后重发
 * FIGURE_FRAMING」兜住（见 renderLine），故结论在新版仍然成立。scripts/** 的下载版本
 * 与随包模板由 Lead 统一升级，两处必须同步（unit-webgal-version.ts 会拦漂移）。
 */
export const SUPPORTED_WEBGAL_VERSION = "4.6.6";

/** 引擎安全素材文件名（1452 纯函数，便于单测；渲染与落盘共用）。
 *  引擎把 ; 当截断、| 当分隔、“ -”当选项起点；文件名照抄 esc 口径映射，
 *  否则自备素材在脚本与磁盘“一致地一起坏掉”（有文件但 404）。 */
export function engineSafeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || name;
  return base.replace(/;/g, "；").replace(/\|/g, "｜").replace(/ -/g, " ‑");
}

function getBaseName(f: string): string {
  return engineSafeFileName(f);
}

/** 人名安全转义（1457）：ASCII 冒号映射为全角，禁止走 esc 的 \: 转义。
 *  引擎用裸 /:/ 切分“人名:台词”，\: 照样命中，导致名牌“ Alice\”+正文“Bob:Hi”。文本侧仍用 esc。 */
function escName(text: string): string {
  return esc((text || "").replace(/:/g, "："));
}

/** 短哈希（1462，djb2 变体）：sanitizeId 把非词字符折叠成 _，sc_a b 与 sc_a_b 会撞 label 与配音键。
 *  branchPrefix 与 sceneVocalKey 均追加本哈希；旧无哈希配音键由 legacySceneVocalKey 回退兼容。 */
export function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 分支 label 前缀（1462）：ch{N}_{sanitizeId}_{hash4}，保证原始 id 不同则前缀不同。 */
export function branchPrefix(chapterNumber: number, sceneId: string): string {
  return `ch${chapterNumber}_${sanitizeId(sceneId)}_${djb2Hash(sceneId).slice(0, 4)}`;
}

/** 选项文案清洗（1450）：WebGAL choose 按 -> 切分、按 (?<!\\): 切文本/目标，
 *  ( ) [ ] 是 showCondition/enableCondition/jump 保留字符；文本含任一即 TypeError 卡死
 *  （forward 在 currentSentenceId++ 前抛错，当前句永不消费）。仅全角化上述保留字符
 *  （: ; , 由 esc 的反斜杠转义处理，不在此改字形），清洗后为空兜底“继续”。 */
export function sanitizeChoicePrompt(prompt: string): string {
  const s = (prompt || "")
    .replace(/->/g, "→")
    .replace(/\(/g, "（").replace(/\)/g, "）")
    .replace(/\[/g, "【").replace(/\]/g, "】")
    .replace(/\|/g, "｜")
    .trim();
  return s || "继续";
}

/* ===== 人物动作：入场动画 + 情绪动作 + 剧情镜头震动 ===== */

const ENTRANCES = ["enter-from-left", "enter-from-right", "enter-from-bottom"];

/* ===== 立绘站位与取景（几何全部按舞台真实尺寸推导，见 tests/unit-fix-render.ts） ===== */

/** 引擎原生支持的 7 个站位（4.6.6 产物 PT=["center","left","right","left13","right13","left14","right14"]）。
 *  每个站位有独立的舞台状态键（H1: left13→figNameLeft13 …）与变换目标名（`fig-${position}`），
 *  横向落点由 q1() 决定：left=w/2（左缘贴边）、left13=w/3、center=w/2（居中）、right13=2w/3、
 *  right=w−w/2（右缘贴边）、left14=w/4、right14=3w/4。 */
export type StagePosition = "center" | "left" | "right" | "left13" | "right13" | "left14" | "right14";

/** 同台立绘的站位顺序（按舞台上的横向落点从两边向中间排）。
 *  引擎原生支持 7 个站位，但同屏 6 人以上必然互相压住，故上限取 5：
 *  3 人 = left/right/center（常规群戏），4–5 人再加 left13/right13（引擎原生的 1/3 与 2/3 位）。
 *  顺序即分配顺序：先来的角色先拿外侧位，中途加入的补中间位，视觉上不会「新人把老人挤走」。 */
export const STAGE_POSITIONS: readonly StagePosition[] = ["left", "right", "center", "left13", "right13"];
/** 同台立绘上限：与 STAGE_POSITIONS 长度一致（超出即驱逐最久没说话的角色）。 */
export const MAX_STAGE_FIGURES = STAGE_POSITIONS.length;

/** 立绘 contain 到舞台高度后的显示高度（引擎 addFigure：`A=Math.min(stageWidth/w, stageHeight/h)`）。
 *  1024² 素材在 2560×1440 舞台上 min(2.5, 1.40625)=1.40625 → 1440px（正好顶满舞台高）。 */
function figureContainedHeightPx(figureSize = 1024): number {
  return Math.min(STAGE_WIDTH / figureSize, STAGE_HEIGHT / figureSize) * figureSize;
}

/** 取景变换（scale + position 都是**舞台像素**，作用在立绘容器的 pivot 上）。
 *  pivot 是舞台底边中点（引擎 addFigure: `pivot.set(0, stageHeight/2)`，容器基线 y=stageHeight/2），
 *  所以放大是**绕底边**进行：图顶被推到舞台上方的负坐标区，再整体下移 position.y。
 *
 *  几何推导（1024² 立绘、2560×1440 舞台，与 tests/unit-fix-render.ts 的断言一致）：
 *    contain 后图高 S₀ = min(2560/1024, 1440/1024)×1024 = 1440px，底边贴舞台底（y=1440）、顶边在 y=0。
 *    绕底边放大 k 倍 → 顶边移到 y = 1440 − 1440k；再下移 Δ → 顶边 y = 1440 − 1440k + Δ。
 *    scale 1.75 / Δ=350：顶边 = 1440−2520+350 = **−730**
 *      → 画面内可见高度 = 1440 + 730 = 2170px，可见比例 2170/2520 ≈ **43.3%**
 *      → 头顶落在画面上方 1 − 730/2520 ≈ **71%** 处（约从腰部往上）。
 *    scale 1.96 / Δ=518：顶边 = 1440−2822+518 = −864 → 可见 2304px → **32.7%**（胸像级近景）。
 *
 *  旧注释按「1920×1080 舞台」推导出 57%，但引擎舞台是 2560×1440（常量 Qm），
 *  按真实几何重算后两档都**比注释更近**——数值本身是历史沿用的，这里只把推导改成事实
 *  （取景比声称的更近，属既有设计，改数值会连带影响所有既有产物的观感，故不动）。 */
export const FIGURE_FRAMING_SCALE = 1.75;
export const FIGURE_FRAMING_OFFSET_Y = 350;
export const FIGURE_FRAMING_ZOOM_SCALE = 1.96;
export const FIGURE_FRAMING_ZOOM_OFFSET_Y = 518;

/** 可见比例（0–1）：1 表示整张立绘都在画面内。纯函数，供单测锁住上面的几何推导。
 *  放大是**绕底边**做的（pivot 在舞台底边中点），所以：
 *    放大后总高 = 原高 × scale；被推出画面顶部的高度 = 总高 − 原高 + offsetY；
 *    可见高度   = 总高 − 溢出量 = 原高 − offsetY。 */
export function figureVisibleRatio(scale: number, offsetY: number, figureSize = 1024): number {
  const contained = figureContainedHeightPx(figureSize);
  const shown = contained - offsetY; // 原高减去下移量 = 仍留在画面内的部分
  const total = contained * scale;
  return Math.max(0, Math.min(1, shown / total));
}

/** 取景变换的 JSON（键顺序 scale→position 固定，便于产物 diff 与快照比对）。 */
function framingJson(scale: number, offsetY: number): string {
  return `{"scale":{"x":${scale},"y":${scale}},"position":{"x":0,"y":${offsetY}}}`;
}

/** 全身立绘 → 游戏内半身取景：素材按 head-to-feet 生成，舞台用「放大 + 下移」取到头像~腰部的构图
 *（近似旧版 thighs-up 立绘观感）。舞台真实尺寸是 2560×1440（引擎常量 Qm），可见比例约 43%，
 *  推导见上方 figureVisibleRatio 与 tests/unit-fix-render.ts 的断言。
 *  #1141：取景为固定行为（原先的 figureFraming 参数无任何调用方，'full' 分支是死代码，已移除）。 */
export const FIGURE_FRAMING = framingJson(FIGURE_FRAMING_SCALE, FIGURE_FRAMING_OFFSET_Y);
/** 高潮句推近：在半身取景基础上再放大一档（取到胸像近景，可见约 33%），结束后回到 FIGURE_FRAMING */
export const FIGURE_FRAMING_ZOOM = framingJson(FIGURE_FRAMING_ZOOM_SCALE, FIGURE_FRAMING_ZOOM_OFFSET_Y);

/** 取景指令的 target 必须与站位一一对应（引擎 H1/OT 两张表按站位名区分状态键与目标名）。
 *  旧实现把 target 写死成 fig-left/fig-right，站位一旦扩展（center/left13…）取景就会套到别人身上。 */
export function figureTransformTarget(position: StagePosition): string {
  return `fig-${position}`;
}

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
/** 环境音效匹配：按场景氛围/时间/地点关键词输出 SE（playEffect），无匹配返回 null。
 *  #1328：单字关键词（剑/门/风/夜/接近）误配专名（剑宗/门派/风铃/夜晚/接近真相），
 *  故动作类只认多字词（拔剑/敲门/风声…），tension 只看 atmosphere 的阴森/紧张词，
 *  时间/地点里的「夜」单独出现不再触发。 */
export function detectSe(scene: SceneJSON): string | null {
  const loc = scene.location || "";
  const atm = scene.atmosphere ?? "";
  const time = scene.time ?? "";
  const hay = `${loc} ${atm} ${time}`;
  if (/雨|下雨|大雨|雷雨|暴雨|骤雨/.test(hay)) return "rain";
  if (/雷|闪电|轰鸣/.test(hay)) return "thunder";
  if (/风声|呼啸|寒风|大风|狂风/.test(hay)) return "wind";
  if (/战斗|打斗|激战|厮杀|搏斗|混战|战场|交锋/.test(hay)) return "battle";
  if (/拔刀|挥剑|拔剑|剑光|剑气|舞剑|仗剑|武器|刀光|兵刃/.test(hay)) return "sword";
  if (/敲门|推门|叩门|门环|开门|关门/.test(hay)) return "door";
  if (/脚步|脚步声|走廊|巷|小巷|逼近/.test(hay)) return "step";
  // tension 只看氛围词（地点/时间专名不触发）；「夜」需与阴森/紧张等词共现才算
  if (/阴森|阴冷|紧张|危险|追杀|逃亡|悬念|寂静|恐怖/.test(atm)) return "tension";
  return null;
}

/** 持续性氛围音（雨/风/战斗/紧张）：必须带 `-id` 循环播放。
 *  官方文档（playEffect）：「为音效设置 id 后，音效可以循环播放。不同 id 的音效与无 id 的音效可以叠加播放」。
 *  内置 se_*.wav 实测 1.2–4.0 秒（se_rain/se_wind 都是 4.0s），不带 -id 时雨戏开头响 4 秒后**整场静音**，
 *  比不放更出戏。点状音（thunder/door/sword/step）保持一次性：它们本来就是「发生了一次」的事件。
 *  引擎侧已核实：`playEffect` 的 startFunction 里 `n && (a.loop=!0)`，n 即 id 是否存在。 */
export const AMBIENT_SE = new Set(["rain", "wind", "battle", "tension"]);

/** 环境音循环用的 id（`-id=amb_rain`）。带前缀是为了与将来可能的点状音 id、以及引擎内置 id 区分开。 */
export function ambientSeId(se: string): string {
  return `amb_${se}`;
}

/** 天气粒子特效：按场景氛围/地点/时间关键词判定（与 detectSe 同源，但**独立**判据）。
 *  官方文档（特效）：`pixiInit` 初始化、`pixiPerform:rain|snow|heavySnow|cherryBlossoms` 添加，
 *  且「特效作用后，如果没有重新初始化，特效会一直运行」——所以离开天气场景必须补 pixiInit 清除。
 *  模板 assets/ 已自带 rain/snow/cherryBlossoms 纹理，能力零成本。
 *  顺序即优先级：暴雪要先于雪（否则 heavySnow 永远判不出来），雨要先于雷（雷雨场景的主氛围是雨）。 */
export function detectWeather(scene: SceneJSON): string | null {
  const hay = `${scene.location || ""} ${scene.atmosphere ?? ""} ${scene.time ?? ""}`;
  if (/暴雪|风雪交加|鹅毛大雪/.test(hay)) return "heavySnow";
  if (/雪|飘雪|下雪|初雪|积雪|霜/.test(hay)) return "snow";
  if (/樱花|樱雨|落樱|春日|春天|花瓣/.test(hay)) return "cherryBlossoms";
  if (/雨|下雨|大雨|雷雨|暴雨|骤雨|细雨|小雨/.test(hay)) return "rain";
  return null;
}

/** 高潮句判定（1432）：按渲染文本语言无关匹配——zh 简/繁 + en/ja/ko 关键词组。
 *  管线是 分章→翻译→提取→剧本，render 拿到的是目标语言文本；旧实现只有简体中文，
 *  en/ja/ko 项目恒 false。英文用词边界避免误配，CJK/假名/谚文用子串匹配。 */
export function isDramatic(text: string): boolean {
  const t = text || "";
  if (/(轰鸣|爆炸|崩塌|巨响|震耳|怒吼|嘶吼|冲撞|猛然|狠狠|轰然|剧烈|颤抖|踉跄|飞扑|倒下|拔出|挥剑|斩|劈开)/.test(t)) return true;
  // zh_TW 繁体字形（轟鳴/巨響/衝撞/顫抖/踉蹌/飛撲/揮劍/劈開 等）
  if (/(轟鳴|巨響|衝撞|顫抖|踉蹌|飛撲|拔出|揮劍|劈開|崩塌|怒吼|嘶吼|猛然|狠狠|轟然|劇烈)/.test(t)) return true;
  // en：高潮/冲击/动作词（词边界，大小写不敏感）
  if (/\b(explosion|thunder|roar|crash|violent|tremble|stagger|lunge|collapse|slash|unsheathe|draw (?:his|her|their|the) sword|battle cry|scream)\b/i.test(t)) return true;
  // ja：爆発/轟音/咆哮/衝突/震え/斬 等
  if (/(爆発|轟音|咆哮|衝突|激しく|震え|よろめ|斬|抜刀|轟)/.test(t)) return true;
  // ko：폭발/굉음/포효/충돌/격렬/떨림/베기 等
  if (/(폭발|굉음|포효|충돌|격렬|떨림|비틀|베기|抜刀|굉)/.test(t)) return true;
  return false;
}

/** 长消息按句读拆成多条 WebGAL 消息（一屏一句，接近 galgame 节奏）。
 *  仅在「无配音」时拆分：有配音的台词保持单条，避免换页掐断语音。
 *  本阈值是「**一条消息**」的上限，比 textboxCharsPerLine()（一行）更严格是有意为之：
 *  拆得比一屏容量更细，读起来才是 galgame 的「一屏一句」节奏，也留出标点带来的余量。 */
export const MESSAGE_MAX_CHARS = 32;
/** 非 CJK（英文等）阈值：按单词边界切。英文单词被空格分隔，nowrap 下 80 字符会折成 2 行，
 *  仍在 textboxVisibleLines() 之内（拉丁文单条不追求「一行一句」，故不与中文阈值对齐）。 */
export const MESSAGE_MAX_CHARS_LATIN = 80;

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

/**
 * 把一句台词渲染成可直接写入脚本的文本（已转义、分页符是真竖线）（#1508）。
 *
 * 顺序很关键，且此前是错的：
 * 引擎 `Os(text, Max_line)` 的实现是 `text.split(/(?<!\\)\|/).map(qC)` ——
 * **先按未转义竖线切段，再对每段做转义还原**。所以旧的 `esc(paginateForTextBox(x))`
 * 会把分页符也转义成 `\\|`，切段时不再匹配 → 整句挤在一屏，超出 Max_line:2 的部分被裁掉，
 * 「长台词自动分页」实际上从未生效。
 * 正确顺序：先转义（字面竖线变 `\\|`），再按字符数插入**未转义**的 `|` 作为分页符。
 */
export function renderSpokenText(text: string, maxChars = TEXTBOX_PAGE_MAX_CHARS): string {
  // 分页阈值必须按**原文长度**算（玩家看到的字符数），所以先只把字面竖线占位保护起来：
  // 用 \u0000 临时顶替——它不可能是正文内容，也不会被 paginateForTextBox 当成分隔符或断句标点。
  // 顺序：原文 → 竖线占位 → 按长度分页 → 逐页转义 → 还原竖线为转义形式 → 用未转义 | 拼回分页符。
  // 这样「字面竖线」与「分页符」在产物里严格区分：引擎先按裸 | 切段，再把转义竖线还原成字面竖线。
  const raw = text || "";
  if (!raw) return "";
  const PLACEHOLDER = String.fromCharCode(0);
  const protectedRaw = raw.split("|").join(PLACEHOLDER);
  const paginated = paginateForTextBox(protectedRaw, maxChars);
  return paginated.split("|").map(function (page) {
    return esc(page.split(PLACEHOLDER).join("|"));
  }).join("|");
}

/** 文本框单页（= 一个 `|` 分段 = 一个视觉行）字符上限。
 *  引擎把每个分段渲染成一个 nowrap 的 div（`Os` + `p.map`），所以「一页」既不能折行也不能
 *  超过文本框宽度——超出部分被 overflow:hidden 裁掉，既不报错也不换行。
 *  因此这里**必须**等于 textboxCharsPerLine()：页容量 × 页数(Max_line) = 一屏可见字数，
 *  三者与 TTS_SPEECH_MAX_CHARS 是同一条不变量（见文件上方「文本框容量」一节）。
 *  旧值 64 是按「每行 32 字 × 2 行」估算的引擎默认样式，与本项目 2560 设计像素的
 *  textbox.scss 不符：64 字在 nowrap 下会被裁成一行。 */
export const TEXTBOX_PAGE_MAX_CHARS = textboxCharsPerLine();
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

/**
 * 动作标签 → 情绪推断（供渲染层吸收动作标签时使用）。
 *
 * #1567：**类别判定顺序必须与 script.ts 的 `emotionOf` 一致**（怒 → 笑 → 惊 → 叹）。
 * 原实现把 sad 排在最前，与 `emotionOf` 相反；而关键词重叠时**顺序决定归属**——
 * 于是同一条台词在「剧本期」（由台词文本推情绪）与「渲染期」（由动作标签推情绪）
 * 可能被判成两种不同情绪，进而选出不同的表情差分图。原注释只写「同口径」，
 * 但顺序并不一致，属注释承诺落空。
 *
 * 关键词是 `emotionOf` 的**超集**（渲染层额外吸收动作词：落寞/沉默/得意/暴/愣）——
 * 这是有意为之的扩展，不违反本注释；被钉住的是**顺序**。
 */
function emotionFromTag(text: string): string | undefined {
  if (/(怒|吼|咬牙|冷冷|斥|暴)/.test(text)) return "angry";
  if (/(笑|高兴|开心|喜|得意)/.test(text)) return "happy";
  if (/(惊|怔|愕|愣)/.test(text)) return "surprised";
  if (/(叹|哀|难过|哭|忧|落寞|沉默)/.test(text)) return "sad";
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
  // 清场：避免上一章节的立绘残留（图片小说模式无立绘，整族 changeFigure 指令都不输出，见 #810）。
  const useActions = opts.figureActions !== false;
  const clearExit = useActions ? " -exit=exit" : "";
  // 必须覆盖全部 5 个可用站位：上一章末尾可能停在 center/left13/right13 上，
  // 只清 left/right 会让那些立绘带着上一章的表情黏连进新章第一章（多站位引入的新残留面）。
  if (!imageOnly) {
    out.push(`changeFigure:none -left${clearExit} -next;`);
    // 中位保持不带 -exit：引擎的默认站位就是 center，历史产物与既有断言都以 `changeFigure:none -next;`
    // 这一形式为准（多一个 -exit=exit 会让「中位清场」这条回归断言失配，而它并不影响引擎行为）。
    out.push(`changeFigure:none -next;`);
    out.push(`changeFigure:none -right${clearExit} -next;`);
    out.push(`changeFigure:none -left13${clearExit} -next;`);
    out.push(`changeFigure:none -right13${clearExit} -next;`);
  }
  // 跨章演出复位（#789/1463）：引擎的 changeScene 不清舞台，上一章的 BGM/黑边/滤镜/背景会残留进本章。
  // 章首显式归零，避免「上一章的紧张黑边/胶片颗粒/音乐带进本章无配乐场景」。
  // 1463：首场景无背景 visual 时上一章最后一幕会带着 Ken Burns 缩放黏连进新章（整场用错图），
  // 此时无条件 changeBg:none + bg-main 全量归零；有 visual 的首场景靠自身 changeBg 覆盖，不额外闪黑。
  out.push(`; ---- 跨章复位 ----`);
  out.push(`bgm:none -enter=0 -next;`);
  out.push(`filmMode:none;`);
  out.push(`setTransform:{"oldFilm":0} -target=bg-main -duration=0 -next;`);
  out.push(`setTransform:{"godrayFilm":0} -target=bg-main -duration=0 -next;`);
  {
    const firstScene = chapter.scenes[0];
    const firstHasVisual = !!firstScene && !!(
      opts.assets.bg[firstScene.id] ||
      (imageOnly && (firstScene.shots ?? []).some((s) => opts.assets.shot?.[s.id]))
    );
    if (!firstHasVisual) {
      out.push(`changeBg:none -duration=0 -next;`);
      out.push(`setTransform:{"blur":0,"oldFilm":0,"godrayFilm":0,"scale":{"x":1,"y":1}} -target=bg-main -duration=0 -next;`);
    }
  }
  // 章节标题卡：黑屏全屏章节名（成熟视觉小说标配，点击继续）。
  // 1354：统一用 chapterDisplayTitle（宽口径去重 + 重编号），与流程图同口径。
  out.push(`; ---- 章节标题卡 ----`);
  const cardTitle = chapterDisplayTitle(chapter.chapter + 1, chapter.title ?? "");
  out.push(`intro:${esc(cardTitle)} -fontColor=rgba(255,255,255,1) -fontSize=large -hold;`);

  // 舞台立绘管理：同台最多 MAX_STAGE_FIGURES(5) 个角色，按 STAGE_POSITIONS 顺序分配引擎原生站位，
  // 新角色出现且站位满员时按最近说话顺序驱逐（旧实现只有 left/right 两槽，第 3 人必然顶掉第 1 人，
  // 群戏被压成 1v1；引擎本身支持 7 个站位，见 STAGE_POSITIONS 注释）
  const stageSlot = new Map<string, StagePosition>();
  const stageOrder: string[] = [];
  const lastFigureFile = new Map<string, string>();
  // 换装状态：角色标注 costume 后沿用该服装，直到再次标注（跨场景保留，章节结束重置）
  const costumeState = new Map<string, string>();
  let entranceIdx = 0;
  // BGM 状态：WebGAL 的 changeScene 不自动清舞台，跨场景/跨章节残留的音乐需显式停止
  let lastBgm: string | null = null;
  let lastSe: string | null = null;
  // 1453：CG 恢复背景在 bgFile 为空时回填上一张已发射背景（避免整场纯黑）；按章重置（1463 跨章不沿用）。
  let lastBgEmitted: string | null = null;
  const bgmUnlocked = new Set<string>();
  // 自动电影黑边 / 影调滤镜 状态（按值变化输出，避免每行重复指令）
  let lastFilm = false;
  let lastFilter = "";
  // 当前正在循环的氛围音 / 正在运行的天气粒子：都按值变化输出，切换时必须显式收尾（见各自发射处）
  let lastAmbientSe: string | null = null;
  let lastWeather: string | null = null;
  // 动作标签吸收状态：形如「老铁匠叹了口气：」的旁白并入下句对话（不独立成行）
  let pendingTag: { speakerId?: string; emotion?: string } | null = null;
  // 热循环预索引：避免每行/每道具事件线性扫描（数千行 × 数十角色）
  const charById = new Map(opts.characters.map((c) => [c.id, c]));
  const itemById = new Map(opts.items.map((i) => [i.id, i]));

  // 配音键回退（1462 迁移）：优先新键（含哈希），未生成时回退旧的无哈希键，
  // 保证升级后旧项目仅「重新组装」也能沿用历史配音文件而不静音（新键由配音阶段按内容索引 0 计费认领）。
  const vocalFor = (scene: SceneJSON, idx: number, si = 0, total = 1): string | undefined => {
    const baseKey = sceneVocalKey(chapter.chapter, scene.id, idx);
    const legacyKey = legacySceneVocalKey(chapter.chapter, scene.id, idx);
    return opts.assets.vocal[sceneVocalKeyPart(baseKey, si, total)]
      ?? opts.assets.vocal[sceneVocalKeyPart(legacyKey, si, total)];
  };

  // 台词文本输出（立绘版/图片版共用）：超长台词按句拆成多段（每段一条消息 + 独立配音），
  // 修复「玩家读到全文、听到的却只有前 500 字」的声画不一致
  // 1449：配音一律用显式键 -vocal=（引擎裸选项白名单只认 ogg/mp3/wav/opus，flac/m4a 会被当成普通开关整行静音）
  const emitDialogueText = (line: Line, scene: SceneJSON, idx: number, name: string): void => {
    const vocalFile = vocalFor(scene, idx);
    const vocalArg = vocalFile ? ` -vocal=${getBaseName(vocalFile)}` : "";
    const speechParts = splitLineForSpeech(line.text);
    if (speechParts.length > 1) {
      speechParts.forEach((seg, si) => {
        const partFile = vocalFor(scene, idx, si, speechParts.length);
        out.push(`${name}:${renderSpokenText(seg)}${partFile ? ` -vocal=${getBaseName(partFile)}` : ""};`);
      });
    } else {
      // 长句按句读拆成多条消息（一屏一句）；有配音的保持单条，避免换页掐断语音
      const segs = splitUnvoicedMessage(line.text, !!vocalFile);
      segs.forEach((seg, si) => {
        out.push(`${name}:${renderSpokenText(seg)}${si === 0 ? vocalArg : ""};`);
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
        // 1431：背景震动/虚化与人物动作无关，去掉 useActions 门控（否则 figureActions:false 时专属效果永不输出）。
        // 1456：同目标 -next 在同一收集窗按 performName 折叠（只剩最后一条），复位 blur:0 去掉 -next 落到下一窗，
        // 否则 blur:5 与 shake 都被折叠、演出全灭。shake 与 blur:5 仍同窗（至少虚化可见），已在注释说明局限。
        if (isDramatic(line.text)) {
          out.push(`setAnimation:shake -target=bg-main -next;`);
          out.push(`setTransform:{"blur":5} -target=bg-main -duration=700 -next;`);
          out.push(`setTransform:{"blur":0${useActions ? `,"scale":{"x":1.04,"y":1.04}` : ""}} -target=bg-main -duration=900;`);
        }
        const speaker = charById.get(line.characterId || "") ?? opts.characters.find((c) => c.id === line.characterId);
        if (speaker) {
          emitDialogueText(line, scene, idx, escName(speaker.name));
        } else {
          // 说话人不可识别时按旁白输出，避免生成「???」人名
          const narVocal = vocalFor(scene, idx);
          out.push(`:${renderSpokenText(line.text)}${narVocal ? ` -vocal=${getBaseName(narVocal)}` : ""};`);
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
      // 服装 id 归一化兜底：提取阶段会把中文 id 归一化成 `ct_<hash>`（extract.ts / extractAgent.ts），
      // 而剧本 LLM 可能照抄卡面里的中文名 → 只查裸 id / 消毒 id 会漏，角色静默退回默认立绘。
      const costumeFile = wornId
        ? (opts.assets.figure[`${effCharId}_ct_${wornId}`]
          ?? opts.assets.figure[`${effCharId}_ct_${sanitizeId(wornId)}`]
          ?? opts.assets.figure[`${effCharId}_ct_${normalizeEntityId(wornId, "ct")}`])
        : undefined;
      const worn = costumeFile ? wornId : undefined;
      const figureFile = costumeFile ?? opts.assets.figure[effCharId];
      // 立绘优先级：台词指定动作 → 对应动作立绘；否则（无换装时）表情差分立绘；否则默认/服装立绘
      let displayFile = figureFile;
      if (line.action) {
        // 动作 id 含中文/空格等特殊字符时，生产用裸 id、此处消毒，两边对不上；
        // 先裸查再消毒查，兜住历史存量；再补一层 normalizeEntityId —— 提取阶段已把中文动作 id
        // 归一化成 `a_<hash>`（extract.ts / extractAgent.ts），剧本 LLM 若照抄中文名，
        // 只查裸 id / 消毒 id 会全部落空、静默退回默认立绘。
        const actionFile = opts.assets.figure[`${effCharId}_act_${line.action}`]
          ?? opts.assets.figure[`${effCharId}_act_${sanitizeId(line.action)}`]
          ?? opts.assets.figure[`${effCharId}_act_${normalizeEntityId(line.action, "a")}`];
        if (actionFile) displayFile = actionFile;
      } else if (opts.figureEmotions !== false && effEmotion && effEmotion !== "normal") {
        // 表情 id 在任务构建时会 sanitize（自定义中文表情名）：先裸查再消毒查，兜住历史与新数据。
        // 换装时优先找该服装的表情差分；没有就回退默认服装的表情差分（旧实现直接放弃表情，哭泣/大笑只有平静脸）。
        // 三层兜底：裸 id（卡面原样）→ 消毒 id（历史存量）→ 归一化 id（提取阶段把中文表情映射成
        // happy/sad 或 emo_<hash>，见 emotions.ts；剧本 LLM 偶尔照抄中文名）。用 Set 去重避免重复查表。
        const emoSuffixes = [...new Set([effEmotion, sanitizeId(effEmotion), normalizeEmotionId(effEmotion)])];
        // 换装 id 同样三层兜底（裸 / 消毒 / 归一化）：否则中文服装名下的表情差分也查不到，
        // 换装期间会一路退到默认服装的表情差分（旧实现甚至直接放弃表情）。
        const wornKeys: string[] = worn ? [...new Set([worn, sanitizeId(worn), normalizeEntityId(worn, "ct")])] : [];
        const candidates = worn
          ? [
              ...wornKeys.flatMap((w) => emoSuffixes.map((e) => `${effCharId}_ct_${w}_${e}`)),
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
      // 舞台管理 + 人物动作：最多 MAX_STAGE_FIGURES 个角色同台，新角色入场 / 表情切换 / 情绪动作
      let slot = stageSlot.get(effCharId);
      const appearing = !!displayFile && !slot;
      if (displayFile) {
        const figureChanged = appearing || displayFile !== lastFigureFile.get(effCharId);
        if (appearing) {
          // 分配站位：按 STAGE_POSITIONS 顺序取第一个空位；满员才驱逐最久没说话的角色。
          // 引擎原生 7 站位（left/right/center/left13/right13/left14/right14），本项目用前 5 个，
          // 每个站位都有独立的舞台状态键与 `fig-<position>` 变换目标。
          const used = new Set(stageSlot.values());
          const free = STAGE_POSITIONS.find((p) => !used.has(p));
          if (free) {
            slot = free;
          } else {
            // 只从真正占着站位的角色里挑最久没说话的：stageOrder 可能包含无立绘角色（无 slot），
            // 旧实现直接取 stageOrder 末位，其 victimSlot 为 undefined 时输出 `-undefined`，
            // 引擎按 center 处理 → 多人重叠、后续特写失效
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
              // 兜底（状态异常理论不可达）：清空全部站位重新分配，避免 undefined 站位
              for (const p of STAGE_POSITIONS) out.push(`changeFigure:none -${p} -next;`);
              stageSlot.clear();
              stageOrder.length = 0;
              lastFigureFile.clear();
              slot = STAGE_POSITIONS[0];
            }
          }
          stageSlot.set(effCharId, slot);
          if (useActions) {
            const entrance = ENTRANCES[entranceIdx++ % ENTRANCES.length];
            out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -enter=${entrance} -next;`);
          } else {
            out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -next;`);
          }
          // 半身取景：立绘就位后立即套用取景变换（duration=0 与入场动画不叠加）。
          // target 必须跟着站位走（fig-center/fig-left13…）：写死 fig-left/fig-right 时，
          // 第 3 人起取景会套到别人的立绘上，自己仍是全身缩略图。
          out.push(`setTransform:${FIGURE_FRAMING} -target=${figureTransformTarget(slot)} -duration=0 -next;`);
        } else if (figureChanged && slot) {
          // slot 必然存在（appearing 为假即代表本角色已在台上），显式判断只为让类型收窄
          out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -next;`);
          out.push(`setTransform:${FIGURE_FRAMING} -target=${figureTransformTarget(slot)} -duration=0 -next;`);
        }
        lastFigureFile.set(effCharId, displayFile);
      }
      // 情绪动作：说话时的震动/弹出/跳动（入场那一句跳过，避免与入场动画叠加）
      // 1448：setTempAnimation 从单位变换起播（ignoreDefault=true），末帧回到 {0,0}/{1,1} 会摧毁半身取景。
      // 取景只在 figureChanged 时补发，丢一次就丢到下次换图。补复位行；复位不用 -next（1456 同窗折叠会吞掉 motion 本体）。
      if (useActions && displayFile && !appearing && slot && effEmotion && effEmotion !== "normal") {
        const motion = motionFor(effEmotion);
        if (motion) {
          // 取到局部常量：slot 在本函数里被反复赋值，闭包/回调中 TS 无法沿用收窄结果
          const motionSlot: StagePosition = slot;
          out.push(`setTempAnimation:${motion} -target=${figureTransformTarget(motionSlot)} -next;`);
          out.push(`setTransform:${FIGURE_FRAMING} -target=${figureTransformTarget(motionSlot)} -duration=0;`);
        }
      }
      // 高潮台词演出：背景虚化 + 说话立绘特写推进（1500ms），句末回到半身取景
      // 1456：同目标 -next 同窗按 performName 折叠（bg 只剩 blur:0、fig 只剩收尾取景，演出全灭）。
      // 初段（blur:5/bg + zoom/fig，不同 target，可同窗）保留 -next；复位段去掉 -next 落到后续窗，保住初段演出。
      if (useActions && isDramatic(line.text)) {
        if (slot) {
          out.push(`setTransform:{"blur":5} -target=bg-main -duration=700 -next;`);
          out.push(`setTransform:${FIGURE_FRAMING_ZOOM} -target=${figureTransformTarget(slot)} -duration=1500 -next;`);
          out.push(`setTransform:${FIGURE_FRAMING} -target=${figureTransformTarget(slot)} -duration=800;`);
          out.push(`setTransform:{"blur":0,"scale":{"x":1.04,"y":1.04}} -target=bg-main -duration=800;`);
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
      const name = escName(char?.name || effCharId || "???");
      emitDialogueText(line, scene, idx, name);
    } else {
      // 旁白与内心独白统一走普通旁白行：intro: 指令不带语音播放，
      // 之前独白渲染成 intro:…-v.mp3 导致引擎忽略语音后缀、独白全程无声。
      // 改回 ':' 旁白行后与配音任务同 key，语音正常播放。
      // 1456：复位 blur:0 去掉 -next（同窗折叠会吞掉 shake/blur:5）。
      if (useActions && isDramatic(line.text)) {
        out.push(`setAnimation:shake -target=bg-main -next;`);
        out.push(`setTransform:{"blur":5} -target=bg-main -duration=700 -next;`);
        out.push(`setTransform:{"blur":0,"scale":{"x":1.04,"y":1.04}} -target=bg-main -duration=900;`);
      }
      // 旁白同样带配音，避免整段静默；超长旁白与对话同口径按句拆段配音
      const narVocalFile = vocalFor(scene, idx);
      const narVocalArg = narVocalFile ? ` -vocal=${getBaseName(narVocalFile)}` : "";
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
          const partFile = vocalFor(scene, idx, si, narParts.length);
          out.push(`:${renderSpokenText(wrapMonologue(seg))}${partFile ? ` -vocal=${getBaseName(partFile)}` : ""};`);
        });
      } else {
        // 内心独白用「」包裹区分（WebGAL 无行内样式，括号标记最稳妥；独白不拆行）
        const narText = wrapMonologue(line.text);
        const narSegs = splitUnvoicedMessage(narText, !!narVocalFile || !!line.monologue);
        narSegs.forEach((seg, si) => {
          out.push(`:${renderSpokenText(seg)}${si === 0 ? narVocalArg : ""};`);
        });
      }
    }
  };

  for (const scene of chapter.scenes) {
    out.push("");
    out.push(`; ---- 场景：${comment(scene.location)}（${comment(scene.atmosphere)} ${comment(scene.time)}）----`);

    // 影调滤镜 + 视频黑边（1459：已核实引擎 4.6.3 语义）。
    // filmMode 并不是「电影黑边」：它 setStage("enableFilm")，只有两处消费——① 视频覆盖层 letterbox
    // （FullScreenPerform 高度 76%/top 12%）；② 把文本框切到 IOe 分支（不渲染说话人名、无黑色底板、
    // 字号 50*textSize+200%，medium=250%）。故 atmosphere 命中就 filmMode:true 会把绝大多数动作/冲突场景
    // 的对话框弄坏；现改为只有本场景确实播放视频时才开（letterbox 唯一正确用途），氛围改走 setTransform 滤镜。
    const mood = `${scene.atmosphere || ""} ${scene.location || ""}`;
    const tenseMood = /紧张|激烈|决战|战斗|高潮|危机|追逐|逃生|对峙/i.test(mood);
    const wantFilter = /回忆|梦境|往事|过去|童年|记忆|梦/i.test(mood) ? "oldFilm" : tenseMood ? "godrayFilm" : "";
    const sceneHasVideo = (scene.videoPoints || []).some((vp) => !!opts.videos?.[sanitizeId(vp.id)]);
    const wantFilm = sceneHasVideo;
    if (wantFilm !== lastFilm) {
      // 引擎语义：不填或填 none 才关闭电影模式，其他任何字符串（包括 "false"）都会开启。
      // 旧实现输出 filmMode:false，进入紧张场景后电影模式永不退出（自定义对话框消失、说话人名字不显示）
      out.push(`filmMode:${wantFilm ? "true" : "none"};`);
      lastFilm = wantFilm;
    }
    if (wantFilter !== lastFilter) {
      // setFilter 在 WebGAL 4.6.x 是空实现（处理器直接返回，不解析参数）：滤镜必须走 setTransform 的同名键。
      // 该指令已从 lint 白名单移除（lint.ts 的 KNOWN_DEAD_CMD_RE 会直接报错），别在这里改回去。
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
        // #1460 结论作废（#1507 实测更正）：引擎在**解析期**就会给资源类指令的 content 补上目录——
        // assets/index-*.js 里 `case Ae.unlockBgm:return r(e,Or.bgm)` / `case Ae.unlockCg:return r(e,Or.background)`，
        // 而 `r` 即 `yi()`：`case 0:r=\`./game/background/${e}\`` / `case 1:r=\`./game/bgm/${e}\``。
        // unlock 处理器随后把 **content 本身**当 url 存进 appreciationData（AEe/EEe: `const t=e.content … {url:t}`），
        // 鉴赏页再把 url 原样当图片 src / 音频 src。所以 content 必须是**裸文件名**：
        // 写成 game/bgm/x.mp3 会被引擎再补一次，得到 ./game/bgm/game/bgm/x.mp3 → 缩略图与试听全 404。
        // 对照：Title_img 也走同一个 yi()，而 renderConfig 只写裸文件名——这就是引擎的约定。
        out.push(`unlockBgm:${getBaseName(bgmFile)} -name=${esc(bgmName)};`);
      }
      lastBgm = bgmFile;
    } else if (lastBgm) {
      out.push(`bgm:none -enter=600 -next;`);
      lastBgm = null;
    }

    const bgFile = opts.assets.bg[scene.id];
    // CG 映射（1453 预读）：triggerIndex<=0 的 CG 在场景开场即播，此时跳过前置 changeBg（否则淡入两次）。
    const cgFilePeek = scene.cgFile || opts.assets.cg[`${chapter.chapter}_${scene.id}`] || opts.assets.cg[scene.id];
    const cgTriggerPeek = (scene.cgEvent as { triggerIndex?: number } | undefined)?.triggerIndex ?? 0;
    const cgAtStart = !!cgFilePeek && !imageOnly && cgTriggerPeek <= 0;
    // 图片小说分镜（#810）：按 triggerLineIndex 排序，只保留已有产物的分镜；有分镜时不再铺场景背景
    const shotList = imageOnly
      ? (scene.shots ?? [])
          .map((shot) => ({ shot, file: opts.assets.shot?.[shot.id] }))
          .filter((entry): entry is { shot: NonNullable<SceneJSON["shots"]>[number]; file: string } => !!entry.file)
          .sort((a, b) => a.shot.triggerLineIndex - b.shot.triggerLineIndex)
      : [];
    if (bgFile && (!imageOnly || !shotList.length) && !cgAtStart) {
      // 场景切换：干净利落的交叉淡化（WebGAL changeBg 自带透明度淡入，500ms 即完成），
      // 叠加轻微推近（Ken Burns 运镜）制造电影感，符合主流 galgame 的 dissolve 过渡。
      // 注意不要在此叠加 blur 聚焦——changeBg 已含淡入，双重动画叠加是"生硬"的来源。
      out.push(`changeBg:${getBaseName(bgFile)} -duration=500 -ease=easeInOut -next;`);
      lastBgEmitted = getBaseName(bgFile);
      if (useActions) {
        out.push(`setTransform:{"scale":{"x":1.04,"y":1.04}} -target=bg-main -duration=3000 -next;`);
      }
    }
    // 分镜切换：只淡入（#814 决策 9），不推近；同时解锁鉴赏室（分镜按 CG 画廊展示，1460 带目录路径）
    let shotCursor = 0;
    const emitDueShots = (lineIndex: number): void => {
      while (shotCursor < shotList.length && shotList[shotCursor].shot.triggerLineIndex <= lineIndex) {
        const { shot, file } = shotList[shotCursor++];
        out.push(`changeBg:${getBaseName(file)} -duration=400 -ease=easeInOut -next;`);
        lastBgEmitted = getBaseName(file);
        out.push(`unlockCg:${getBaseName(file)} -name=${esc(shot.note || scene.location || "分镜")};`);
      }
    };
    // 触发点 ≤ 0 的分镜在第一句之前就切换
    // #1369：图片小说场景必须以自己的首张分镜开场——首分镜触发点 >0 时此前整场沿用上一场景画面。
    // 场景开始即淡入首图（后续分镜按触发点正常切换；首图触发点 ≤0 时走原有 emitDueShots(0)）。
    // 全无分镜的场景仍保留上一张图（images.ts 有意不产出黑屏，见 #809 注释）。
    if (imageOnly) {
      if (shotList.length && shotList[0].shot.triggerLineIndex > 0) {
        const { shot, file } = shotList[shotCursor++];
        out.push(`changeBg:${getBaseName(file)} -duration=400 -ease=easeInOut -next;`);
        lastBgEmitted = getBaseName(file);
        out.push(`unlockCg:${getBaseName(file)} -name=${esc(shot.note || scene.location || "分镜")};`);
      } else {
        emitDueShots(0);
      }
    }
    // 环境音效（SE）：按场景氛围匹配播放（用户可用同名文件覆盖内置音效）
    // useSe === false（新项目默认）时完全不输出 playEffect；undefined 兼容旧项目仍按氛围输出
    const se = opts.useSe === false ? null : detectSe(scene);
    const seVolume = opts.seVolume ?? 35;
    // 持续氛围音（雨/风/战斗/紧张）带 `-id` 循环；点状音（雷/门/剑/脚步）不带 id、只响一次。
    // 关键差别在**收尾**：循环音不会自己结束，离开氛围时必须显式停（否则雨会一直下到下一场）。
    // 引擎语义：`playEffect:none`（或空路径）停止当前音效，故停循环音与清一次性音效是同一条指令。
    const ambientId = se && AMBIENT_SE.has(se) ? ambientSeId(se) : null;
    if (se && ambientId) {
      // 切换氛围时先停上一条循环（引擎同一时刻只保留一路 playEffect，换文件本身即替换，
      // 但显式 none 能让「雨→风」这类切换在脚本里可读、可 lint、可回溯）
      if (lastAmbientSe && lastAmbientSe !== se) {
        out.push(`playEffect:none -next;`);
        lastSe = null;
      }
      if (se !== lastSe) {
        lastSe = se;
        lastAmbientSe = se;
        out.push(`playEffect:se_${se}.wav -id=${ambientId} -volume=${seVolume} -next;`);
      }
    } else if (se) {
      // 点状音：上一条循环音必须先停，否则雨声会盖着雷声一起响到场景结束
      if (lastAmbientSe) {
        out.push(`playEffect:none -next;`);
        lastAmbientSe = null;
        lastSe = null;
      }
      if (se !== lastSe) {
        lastSe = se;
        out.push(`playEffect:se_${se}.wav -volume=${seVolume} -next;`);
      }
    } else {
      // #1327：无 SE 场景复位 lastSe（与 BGM 的 lastBgm 置 null 对称）。
      // 否则同章同种氛围第二次出现时 se===lastSe 被跳过而静音（[雨,晴,雨] 的 C 场景无声）。
      // 若此前在循环氛围音，这里必须显式停掉：一次性音效播完即止，循环音不会。
      if (lastAmbientSe) {
        out.push(`playEffect:none -next;`);
        lastAmbientSe = null;
      }
      lastSe = null;
    }

    // 天气粒子特效：与 SE 判据独立（雷雨场景 detectSe 返回 thunder，但画面该下雨）。
    // 官方文档：pixiInit 初始化/清除，pixiPerform 添加；「特效作用后，如果没有重新初始化，
    // 特效会一直运行」——所以任何天气变化（含「变成晴天」）都要先 pixiInit 清场。
    // 只依赖 useSe 开关（用户明确关掉氛围时不叠粒子），不依赖 useActions：
    // 粒子属于场景氛围而非人物动作，图片小说模式同样成立（它在背景特效层，不遮文本框）。
    const weather = opts.useSe === false || opts.useWeather === false ? null : detectWeather(scene);
    if (weather !== lastWeather) {
      out.push(`pixiInit;`);
      if (weather) out.push(`pixiPerform:${weather};`);
      lastWeather = weather;
    }

    // 视频推荐位：有用户放置的视频文件则播放，否则注释占位（不执行）
    for (const vp of scene.videoPoints || []) {
      const vfile = opts.videos?.[sanitizeId(vp.id)];
      if (vfile) {
        out.push(`; ---- 视频演出：${comment(vp.title)} ----`);
        out.push(`playVideo:${getBaseName(vfile)};`);
      } else {
        out.push(`; [视频位] ${comment(vp.title)}：${comment(vp.description)}（提示词见 video_plan.txt，把视频命名为 video_${sanitizeId(vp.id)}.mp4 放入 video 文件夹后，需重新组装（结果区点「重新组装生效」）才会写入演出指令）`);
      }
    }

    // CG 映射 key 为 `${chapter.chapter}_${scene.id}`（images.ts 按此记录），
    // 直接用 scene.id 查不到会导致 CG 演出整段被跳过；scene.cgFile 是生成阶段写入的捷径，两者都兜底。
    // 1453：CG 按 cgEvent.triggerIndex 在台词流中触发（与 itemEvents 同索引表），不再固定场景开场；
    // trigger<=0/缺失保持开场（兼容旧数据）；bg 为空时回填 lastBgEmitted 而非 none（避免后半整场纯黑）。
    const cgFile = scene.cgFile || opts.assets.cg[`${chapter.chapter}_${scene.id}`] || opts.assets.cg[scene.id];
    const cg = scene.cgEvent;
    const cgTrigger = (cg as { triggerIndex?: number } | undefined)?.triggerIndex ?? 0;
    let cgEmitted = false;
    const emitCg = (): void => {
      if (!cgFile || imageOnly || cgEmitted) return;
      cgEmitted = true;
      // CG 前记录立绘状态：播完 CG 原样恢复（不带入场动画），否则所有角色会带 enter 动画重新跳入
      const cgBefore = stageOrder
        .map((id) => ({ id, slot: stageSlot.get(id), file: lastFigureFile.get(id) }))
        .filter((b): b is { id: string; slot: StagePosition; file: string } => !!b.slot && !!b.file);
      // CG 整幅插画演出：先清空立绘（避免人物与 CG 同屏叠加），播 CG 后恢复原立绘状态。
      // 清场必须覆盖全部站位（旧实现只清 left/right，第 3 人起会留在台上压在 CG 上）
      for (const p of STAGE_POSITIONS) out.push(`changeFigure:none -${p}${clearExit} -next;`);
      stageSlot.clear();
      stageOrder.length = 0;
      // CG 后舞台实际已空，必须同步清立绘文件记忆，否则 CG 后同文件角色会被误判“未换装”而跳过 changeFigure，导致人物消失
      lastFigureFile.clear();
      out.push(`changeBg:${getBaseName(cgFile)} -duration=400 -ease=easeInOut -next;`);
      lastBgEmitted = getBaseName(cgFile);
      // 名场面特写运镜：缓慢推近 CG，强化冲击力
      out.push(`setTransform:{"scale":{"x":1.08,"y":1.08}} -target=bg-main -duration=2500 -next;`);
      // 有 cgEvent 用事件标题/描述，无事件（旧图残留/手动放图）也解锁，避免鉴赏室漏 CG
      out.push(`unlockCg:${getBaseName(cgFile)} -name=${esc(cg?.title || cg?.description || scene.location || "CG")};`);
      out.push(`:${esc(cg?.description || cg?.title || `${scene.location} ${scene.atmosphere || ""}`.trim() || "名场面")};`);
      out.push(`changeBg:${bgFile ? getBaseName(bgFile) : (lastBgEmitted ?? "none")} -duration=500 -ease=easeInOut -next;`);
      if (bgFile) lastBgEmitted = getBaseName(bgFile);
      // 原样恢复 CG 前的立绘（无入场动画；状态同步回填，后续台词按原表情/服装继续）。
      // 取景 target 按各自站位重发：center/left13 的目标名与 left/right 不同，写死会恢复成全身缩略图。
      for (const b of cgBefore) {
        out.push(`changeFigure:${getBaseName(b.file)} -${b.slot} -next;`);
        out.push(`setTransform:${FIGURE_FRAMING} -target=${figureTransformTarget(b.slot)} -duration=0 -next;`);
        stageSlot.set(b.id, b.slot);
        lastFigureFile.set(b.id, b.file);
        stageOrder.push(b.id);
      }
    };
    // 图片小说模式没有立绘舞台，CG 演出整块跳过；分镜已承担画面切换。开场 CG 只在 trigger<=0 时播。
    if (cgTrigger <= 0) emitCg();

    // 同一触发行支持多个物品事件：旧实现每个索引只保留第一个，多事件时后续事件被静默丢弃
    const eventIdxsByTrigger = new Map<number, number[]>();
    scene.itemEvents.forEach((ev, i) => {
      const arr = eventIdxsByTrigger.get(ev.triggerIndex) ?? [];
      arr.push(i);
      eventIdxsByTrigger.set(ev.triggerIndex, arr);
    });

    scene.lines.forEach((line, i) => {
      if (imageOnly) emitDueShots(i);
      // 1453：CG 按 triggerIndex 在台词流中触发（开场已播的不重复）。
      if (!imageOnly && cgFile && !cgEmitted && cgTrigger === i) emitCg();
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
    // 1453：trigger 越界（>=lines.length）或 CG 从未触发，兜底在场景末播出，避免名场面丢失。
    if (!imageOnly && cgFile && !cgEmitted && cgTrigger >= scene.lines.length) emitCg();

    // 分支选择：场景末尾弹出选项，各分支为独立 label 块，结束后跳回合并点继续
    // 1450：选项文案全角化保留字符（->()[]|:;,），空兜底“继续”，避免 choose 解析 TypeError 卡死。
    // 1462：label 前缀追加短哈希，避免 sc_a b 与 sc_a_b 撞名跳错场景（vocalKey 暂不动，需 voice.ts 同步）。
    // 1461：分支台词走 renderLine 会改舞台（changeFigure/setTransform），join 后按快照复原，避免分支角色带进下一场景。
    if (scene.choices && scene.choices.length) {
      const prefix = branchPrefix(chapter.chapter + 1, scene.id);
      const joinLabel = `${prefix}_join`;
      const args = scene.choices
        .map((c, ci) => `${esc(sanitizeChoicePrompt(c.prompt || "继续"))}:${prefix}_c${ci + 1}`)
        .join("|");
      // 1461 快照：choose 之前记录舞台（槽位/顺序/文件/BGM），join 后复原。
      const branchSlots = new Map(stageSlot);
      const branchOrder = [...stageOrder];
      const branchFiles = new Map(lastFigureFile);
      const branchBgm: string | null = lastBgm;
      out.push("");
      out.push(`; ---- 分支选择 ----`);
      out.push(`choose:${args};`);
      scene.choices.forEach((c, ci) => {
        out.push(`label:${prefix}_c${ci + 1};`);
        c.lines.forEach((line, j) => renderLine(line, scene.lines.length + 1000 * (ci + 1) + j, scene));
        out.push(`jumpLabel:${joinLabel};`);
      });
      out.push(`label:${joinLabel};`);
      // 1461 复原：清空当前（分支残留）舞台，按快照重发 changeFigure + 取景；BGM 若被分支改动则恢复。
      out.push(`; ---- 分支舞台复原 ----`);
      // 清场覆盖全部站位：分支里新登场的角色可能落在 center/left13 等站位上
      for (const p of STAGE_POSITIONS) out.push(`changeFigure:none -${p} -next;`);
      stageSlot.clear();
      stageOrder.length = 0;
      lastFigureFile.clear();
      for (const id of branchOrder) {
        const slot = branchSlots.get(id);
        const file = branchFiles.get(id);
        if (slot && file) {
          out.push(`changeFigure:${getBaseName(file)} -${slot} -next;`);
          out.push(`setTransform:${FIGURE_FRAMING} -target=${figureTransformTarget(slot)} -duration=0 -next;`);
          stageSlot.set(id, slot);
          lastFigureFile.set(id, file);
          stageOrder.push(id);
        }
      }
      out.push(`setTransform:{"blur":0} -target=bg-main -duration=0 -next;`);
      if (lastBgm !== branchBgm) {
        if (branchBgm) out.push(`bgm:${getBaseName(branchBgm)} -enter=600 -next;`);
        else if (lastBgm) out.push(`bgm:none -enter=600 -next;`);
        lastBgm = branchBgm;
      }
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

function cleanConfigValue(text: string, isFile = false): string {
  // 1452：旧实现只清 ; 与换行，不清 | 与“ -”（同样截断引擎解析）；且无条件 slice(0,60)
  // 会把 Title_img/Game_Logo/Title_bgm 真实文件名截成不存在的路径（入口白屏/标题静音）。
  // 文件类值不再截断，只清洗；标题类保留 60 截断。
  // #1515：文件类值此前把 ; | 替换成「空格」，而 copyAssets 落盘走 engineSafeFileName
  // 映射成全角 ；｜。两边口径不同 → cover;art.png 在 config.txt 里变成 cover art.png，
  // 引擎去 ./game/background/cover art.png 取图必然 404（标题页卡白遮罩）。
  if (isFile) return engineSafeFileName((text || "").replace(/[\r\n]+/g, "")).trim();
  const s = (text || "").replace(/[;\r\n|]+/g, " ").replace(/ -/g, " ‑").trim();
  return safeSlice(s, 60);
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
  // 注意：引擎 4.6.6 没有 Enable_Save/Load/QuickSave/Options/Auto/Skip/Backlog 等键（全包 0 引用），
  // 这些菜单项无法通过配置关闭，不要臆造。
  const lines = [
    `Game_name:${cleanConfigValue(title)};`,
    `Game_key:${cleanConfigValue(gameKey)};`,
    `Enable_Appreciation:${toggles?.appreciation === false ? "false" : "true"};`,
    `Enable_Continue:${toggles?.continue === false ? "false" : "true"};`,
    `Enable_flowchart:${toggles?.flowchart === false ? "false" : "true"};`,
    `Show_panic:true;`,
    `Default_Language:${language};`,
    // 文本框排版（引擎 globalGameVar）。已核实 4.6.6 引擎实现（assets/index-*.js）：
    //   const d = Number(globalGameVar.Max_line)   // NaN 时 medium=2，其余=2（默认值）
    //   const p = Os(showText, d)                  // 按**未转义** | 切段后 .slice(0, d)
    //   p.map(...)                                 // 每段渲染成同级一个 div（key=text-line-N）
    // 即 Max_line **就是**文本框里铺出来的行数，不存在「翻页」：写小了后续分段被引擎丢弃，
    // 写大了多出来的行被 `.text{overflow:hidden}` 裁掉。旧注释断言「Max_line 不是可见行数、
    // 可见行数由 CSS 决定、与 Max_line 无关」——后半句是错的推论：两者必须相等，
    // 否则无论谁大谁小都会丢字（4.6.3 时代的 Max_line:8 就是「8 行铺进 4 行的框」）。
    // 取值 = 一屏可见的整行数（textboxVisibleLines()，由 textbox.scss 几何算出），
    // 与 TEXTBOX_PAGE_MAX_CHARS / TTS_SPEECH_MAX_CHARS 构成同一条不变量，见文件上方注释。
    `Max_line:${textboxVisibleLines()};`,
    // Line_height 为行高（em）。与 textbox.scss 的 `line-height:1.6 !important` 同值——
    // 引擎默认 medium 是 2.2em，本项目的框高是按 1.6em 算出来的，两处必须一起改。
    `Line_height:${TEXTBOX_LINE_HEIGHT_EM};`,
  ];
  if (titleImg) lines.push(`Title_img:${cleanConfigValue(titleImg, true)};`);
  if (titleBgm) lines.push(`Title_bgm:${cleanConfigValue(titleBgm, true)};`);
  // 引擎把 Title_img / Game_Logo 按 ./game/background/<值> 解析（见 generateTitleArt）；
  // 缺失的 Title_img 会让入口页卡在白色遮罩，故只在确有文件时才写这两行
  if (gameLogo) lines.push(`Game_Logo:${cleanConfigValue(gameLogo, true)};`);
  return lines.join("\n");
}



