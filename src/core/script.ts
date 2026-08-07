import type {
  ChapterInfo,
  ChapterScript,
  CharacterCard,
  CgEvent,
  ExtractionResult,
  ItemCard,
  ItemEvent,
  Line,
  SceneCard,
  SceneJSON,
} from "./types";
import { chatJson } from "../api/openaiCompatible";
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
   - 可选 action: 当该句台词有明显动作姿态（抬手指、拔剑、挥手、抱臂、蹲下等）时，从该角色的"动作列表"(见角色卡)中选最贴切的一个填 action: "动作id"；没有合适的动作就省略该字段
   - narration: {type:"narration", text}
   - 内心独白: {type:"narration", monologue:true, text}（数量要少，每章最多 2 条）
5. CG 事件：挑本章 1-3 个最具画面感的"名场面"（战斗高潮、重要相遇、宏大场景），
   为其中最多一个场景写 cg：{title, description(一两句), imagePrompt(整幅插画，含人物，电影构图，动漫风)}
6. 视频推荐点 videoPoints：对本章最具"动感"的名场面（战斗、追逐、大雨、重要转身等）标记 0-2 个视频推荐点：
   {id: 短标识(如 op1、ch2_battle), title, description(一两句), videoPrompt(可直接用于 AI 视频生成平台的英文提示词：画面内容/运镜/时长/风格), durationSecs: 建议时长秒数}
   注意：视频只是"推荐位"，不要因为标记视频而删减 CG 或台词。推荐点对应场景必须有足够的动态画面描写。
7. 物品事件 itemEvents：当剧情中出现"获得/交接/展示/使用重要物品"时，在该场景标记：
   {itemId: 物品卡id, action: "obtain"|"exchange"|"show"|"key", description}
   triggerIndex 我会在渲染时根据文本顺序自动对齐，你只需把 itemEvents 写在对应场景中。
8. 每章最后可以安排到下一章的自然收束，不要写 end 指令。
9. 只输出 JSON，不要输出任何文字。`;

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

  const model = await chatJson<ScriptModel>(cfg, SYSTEM_PROMPT, user, { maxTokens: 8000, onUsage });

  const scenes: SceneJSON[] = (model.scenes || []).map((s, i) => {
    const lines: Line[] = (s.lines || []).map((l) =>
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

    return {
      id: s.id || `s${i + 1}`,
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
    };
  });

  return {
    chapter: chapter.index,
    title: chapter.title,
    scenes: scenes.length ? scenes : [fallbackScene(chapter, cards)],
  };
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
