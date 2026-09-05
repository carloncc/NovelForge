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
} from "./types";
import { chatJson } from "../api/openaiCompatible";
import { resolveContextLength } from "../api/providers";
import { log as logger } from "../utils/logger";
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
      monologue?: boolean;
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
        monologue?: boolean;
        text: string;
      }[];
    }[];
  }[];
}

const SYSTEM_PROMPT = `你是视觉小说编剧。根据小说章节文本与角色卡、物品卡，将该章改编为视觉小说分镜 JSON。

规则：
1. 忠实于原文，对话尽量使用原文台词；旁白精简提炼。
2. 每章拆分为 2-6 个场景（scene）。每个场景 = 一个地点 + 一段连续剧情。
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
   - narration: {type:"narration", text}
   - 内心独白: {type:"narration", monologue:true, text}（数量要少，每章最多 2 条）
5. CG 事件：挑本章 1-3 个最具画面感的"名场面"（战斗高潮、重要相遇、宏大场景），
   为其中最多一个场景写 cg：{title, description(一两句), imagePrompt(整幅插画，含人物，电影构图，动漫风)}
6. 视频推荐点 videoPoints：对本章最具"动感"的名场面（战斗、追逐、大雨、重要转身等）标记 1-3 个视频推荐点（按剧情需要，不设上限）：
   {id: 短标识(如 op1、ch2_battle), title, description(一两句), videoPrompt(可直接用于 AI 视频生成平台的英文提示词：画面内容/运镜/时长/风格), durationSecs: 建议时长秒数}
   注意：视频只是"推荐位"，不要因为标记视频而删减 CG 或台词。推荐点对应场景必须有足够的动态画面描写。
7. 物品事件 itemEvents：当剧情中出现"获得/交接/展示/使用重要物品"时，在该场景标记：
   {itemId: 物品卡id, action: "obtain"|"exchange"|"show"|"key", description}
   triggerIndex 我会在渲染时根据文本顺序自动对齐，你只需把 itemEvents 写在对应场景中。
8. 分支选择 choices（可选）：当剧情出现真正的"抉择时刻"（如留下/离开、相信/怀疑、帮助/旁观等影响角色关系的关键决定）时，
   在该场景写 choices 数组（一个场景最多 1 次，每章最多 1 次）：
   - 每个选项 {id: 短标识, prompt: 选项按钮文本（简洁有力，2-8 字）, lines: 该选项后的短暂分支剧情（1-4 句 dialogue/narration，格式与 lines 相同）}
   - 分支剧情必须自然收束，玩家选择后最终都会汇合回主线继续，不要写 end / jump / 跳转指令
   - 没有真正的抉择时刻就不要写 choices，宁可全线性也不强行加
 9. 每章最后可以安排到下一章的自然收束，不要写 end 指令。
10. 只输出 JSON，不要输出任何文字。
11. 台词完整性（硬约束，优先级高于精简）：
    - 原文「」内的每一句对话都必须原样保留，一句不许删、一句不许合并，短句/语气词（嗯、诶、真的……？等）同样不许丢；
    - 只允许压缩旁白，禁止改写对话文字（仅允许统一标点）；
    - 内心独白按原文比例保留，不要机械砍到只剩 2 条。
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
      return `${c.id}（${c.name}）：外貌${c.appearance}；服装${c.clothing}；性格${c.personality}${acts}`;
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
}

export async function scriptChapter(
  cfg: ApiConfig,
  chapter: ChapterInfo,
  cards: ExtractionResult,
  onUsage?: (pt: number, ct: number) => void,
  opts: ScriptChapterOptions = {},
): Promise<ChapterScript> {
  const extra: string[] = [];
  if (opts.style) {
    extra.push(`\n文风要求：请严格按「${opts.style}」这一风格来编写/改写本章的台词与旁白（包括遣词、语气、节奏），但保持人物设定与剧情走向不变。`);
  }
  if (opts.feedback) {
    extra.push(`\n用户的修改意见（重新生成时请严格参考并落实）：${opts.feedback}`);
  }
  const user = [
    `章节：第 ${chapter.index + 1} 章 ${chapter.title}`,
    `\n角色卡：\n${buildCharacterContext(cards.characters)}`,
    `\n物品卡：\n${buildItemContext(cards.items)}`,
    `\n场景卡：\n${cards.scenes.map((s) => `${s.id}（${s.location}）：${s.atmosphere}`).join("\n")}`,
    ...extra,
    `\n章节正文：\n${chapter.text}`,
  ].join("\n");

  // 剧本输出 token 上限：取模型上下文与 32k 的较小值。
  // 注意不要随 contextLength 无限放大（用户配置 1M 上下文时若 max_tokens=240k，
  // 多数代理会拒绝返回 400 Param Incorrect）；32k 足够容纳一章完整剧本 + 推理思考。
  const scriptOutputTokens = Math.min(resolveContextLength(cfg), 32_768);
  // 剧本请求体大、输出长：给足超时（默认 180s 对不稳定中转代理偏紧，放宽到 300s）
  const model = await chatJson<ScriptModel>(cfg, SYSTEM_PROMPT, user, { maxTokens: scriptOutputTokens, onUsage, timeoutSecs: 300 });

  const resolveSceneId = makeSceneIdResolver(cards, chapter.index);
  const scenes: SceneJSON[] = (model.scenes || []).map((s, i) => {
    const lines: Line[] = (s.lines || [])
      // 过滤空文本行：LLM 可能输出无 text 的 narration/dialogue，会令渲染阶段 esc(undefined) 崩溃
      .filter((l) => typeof l?.text === "string" && l.text.trim().length > 0)
      .map((l) =>
        l.type === "dialogue"
          ? {
              type: "dialogue" as const,
              characterId: l.characterId || cards.characters[0]?.id || "narrator",
              emotion: l.emotion || "normal",
              action: l.action || undefined,
              text: l.text,
            }
          : {
              type: "narration" as const,
              text: l.text,
              monologue: !!l.monologue,
            },
      );

    const itemEvents: ItemEvent[] = (s.itemEvents || []).map((ie, j) => ({
      triggerIndex: Math.min(j * 2 + 1, Math.max(lines.length - 1, 0)),
      itemId: ie.itemId,
      action: ie.action || "show",
      description: ie.description || "",
    }));

    const cgEvent: CgEvent | undefined = s.cg
      ? {
          triggerIndex: Math.max(0, Math.floor(lines.length / 3)),
          title: s.cg.title,
          description: s.cg.description,
          imagePrompt: s.cg.imagePrompt,
          videoSuggestion: undefined,
        }
      : undefined;

    const mapLine = (l: ScriptModel["scenes"][number]["lines"][number]): Line =>
      l.type === "dialogue"
        ? {
            type: "dialogue" as const,
            characterId: l.characterId || cards.characters[0]?.id || "narrator",
            emotion: l.emotion || "normal",
            action: l.action || undefined,
            text: l.text,
          }
        : {
            type: "narration" as const,
            text: l.text,
            monologue: !!l.monologue,
          };

    const choices: Choice[] = (s.choices || []).slice(0, 3).map((c, k) => ({
      id: c.id || `choice_${s.id || i}_${k}`,
      prompt: (c.prompt || "继续").slice(0, 20),
      lines: (c.lines || []).filter((l) => typeof l?.text === "string" && l.text.trim().length > 0).slice(0, 6).map(mapLine),
    }));
    // 截断告警：prompt 约定每场景≤1分支、每分支≤6句，超限静默丢剧情很难察觉，此处打日志提示
    if ((s.choices || []).length > 3) {
      logger.warn("script", "分支选项超限截断", { scene: s.id || i, total: (s.choices || []).length, kept: 3 });
    }
    for (const [ci, c] of (s.choices || []).entries()) {
      if ((c.lines || []).length > 6) {
        logger.warn("script", "分支台词超限截断", { scene: s.id || i, choice: ci, total: (c.lines || []).length, kept: 6 });
        break;
      }
    }

    return {
      id: resolveSceneId(s, i),
      location: s.location,
      atmosphere: s.atmosphere,
      time: s.time,
      bgPrompt: s.bgPrompt,
      bgm: s.bgm || "",
      cgEvent,
      itemEvents,
      videoPoints: (s.videoPoints || []).map((vp, k) => ({
        id: vp.id || `vp_${s.id || i}_${k}`,
        title: vp.title,
        description: vp.description || "",
        videoPrompt: vp.videoPrompt,
        durationSecs: vp.durationSecs || 5,
      })),
      lines,
      figures: [],
      choices: choices.length ? choices : undefined,
    };
  });

  return {
    chapter: chapter.index,
    title: chapter.title,
    scenes: scenes.length ? scenes : [fallbackScene(chapter, cards)],
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

function fallbackScene(chapter: ChapterInfo, cards: ExtractionResult): SceneJSON {
  const sc = cards.scenes[0];
  const lines: Line[] = [
    { type: "narration", text: chapter.text.slice(0, 200) },
    ...cards.characters.slice(0, 2).map(
      (c): Line => ({ type: "dialogue", characterId: c.id, emotion: "normal", text: "……" }),
    ),
  ];
  return {
    id: "s1",
    location: sc?.location || "未知地点",
    atmosphere: sc?.atmosphere || "",
    time: sc?.time || "",
    bgPrompt: sc?.imagePrompt || "anime background, dim room",
    lines,
    figures: [],
    itemEvents: [],
  };
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

export function demoScriptChapter(chapter: ChapterInfo, cards: ExtractionResult): ChapterScript {
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
export const SPEECH_VERBS = /(说|道|答|喊|叹|笑|问|吩咐|回应|开口|沉声道|缓缓道)/;

/** 原文「」引用计数 */
export function countSourceQuotes(text: string): number {
  const m = (text || "").match(/「[^」]*」/g);
  return m ? m.length : 0;
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
  notFoundCount: number;
  orderSuspectCount: number;
  speakerIssues: SpeakerIssue[];
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
  const aliasToId = new Map<string, string>();
  const idToNames = new Map<string, string[]>();
  for (const c of characters) {
    const aliases = nameAliases(c.name);
    idToNames.set(c.id, [c.name, ...aliases]);
    for (const a of aliases) {
      if (!aliasToId.has(a)) aliasToId.set(a, c.id);
    }
  }
  const idToName = new Map(characters.map((c) => [c.id, c.name]));
  const originalQuoteCount = countSourceQuotes(src);
  let dialogueCount = 0;
  let notFoundCount = 0;
  let orderSuspectCount = 0;
  const speakerIssues: SpeakerIssue[] = [];
  let cursor = 0;

  const guessFromContext = (pos: number, needleLen: number): string | undefined => {
    const before = src.slice(Math.max(0, pos - 14), pos);
    const after = src.slice(pos + needleLen, pos + needleLen + 14);
    for (const [alias, id] of aliasToId) {
      if (before.includes(alias)) return id;
    }
    for (const [alias, id] of aliasToId) {
      if (after.startsWith(alias) && SPEECH_VERBS.test(after.slice(alias.length, alias.length + 6))) return id;
    }
    return undefined;
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
      if (guessed && guessed !== line.characterId) {
        speakerIssues.push({
          sceneIndex: si,
          lineIndex: li,
          text: text.slice(0, 60),
          llmSpeakerId: line.characterId || "",
          llmSpeakerName: speakerName,
          suggestedSpeakerId: guessed,
          suggestedSpeakerName: idToName.get(guessed) || guessed,
          reason: "context-mismatch",
          detail: `原文上下文指向${idToName.get(guessed) || guessed}，剧本归属${speakerName}`,
        });
      }
      if (needleLen > 0) cursor = pos + needleLen;
    });
  });

  return {
    originalQuoteCount,
    dialogueCount,
    keptRatio: originalQuoteCount > 0 ? dialogueCount / originalQuoteCount : 1,
    notFoundCount,
    orderSuspectCount,
    speakerIssues,
  };
}
