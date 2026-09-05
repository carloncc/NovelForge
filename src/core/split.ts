import type { ApiConfig, ChapterInfo } from "./types";
import { chatJson } from "../api/openaiCompatible";
import { log } from "../utils/logger";

/**
 * AI 分章：把未切章的小说全文按章节边界切分为多个章节，并丢弃不适合进入视觉小说的杂项内容。
 * 策略：
 * 1. 按空行把全文切成「候选块」（自然段群），避免把正文段落当章节。
 * 2. 把候选块分组成批（每批多个块），交给 LLM 判断：
 *    - 哪些块是「章节标题」（新章的开头）
 *    - 哪些块是「杂项内容」（后记、插图说明、作者的话、目录、翻译注、章节预告等），应丢弃
 * 3. 汇总所有章节标题块的位置 → 用这些位置作为切分边界；正文块归入其后的章节，跳过被标记丢弃的块。
 * 说明：只让 LLM 识别「章节标题 / 应丢弃的块」，正文切分由本地按边界完成，
 * 因此即使文本再长，LLM 每次只判断一批块，不会超出上下文。
 */

const SYSTEM_PROMPT = `你是小说分章助手。用户会给你一批从同一部小说中顺序截取的「内容块」，每块用 [块N] 标记开头。
请完成两件事：
A. 找出「新的一章」的开头（章节标题所在块）。
B. 找出「杂项内容」块：这类内容不是小说的剧情正文，不应进入视觉小说，需要丢弃。

【A. 章节标题特征】（满足任意一条即为新章开头）：
- 形如「第X章/第X节/第X卷/第X回/第X话/第X部」且后面可能跟标题名
- 形如「序章/序言/楔子/尾声/终章/番外/后记/前言/引子」——注意：真正是剧情一部分的「番外/尾声/终章」算章节；纯粹的作者后记/鸣谢不算
- 形如「Chapter 1 / Episode 1 / Act I」等英文章节标记
- 或独立成行、明显是章节标题性质的短句（如「第一章 初入江湖」）
- 正文里的「第X章……」讨论、引用、对话，不是章节开头，不要误判。

【B. 杂项内容特征】（满足任意一条即为应丢弃的块）：
- 书籍信息、目录、版权页、作者简介
- 纯作者的话/后记/鸣谢/预告/求票求收藏/广告
- 插图说明、插图列表、图片占位（如「插图」「插画」「图：」）
- 翻译/校对注释、译后记、源文件说明
- 与剧情无关的碎碎念、标点符号串、网址
- 若某块同时包含剧情与杂项，不要整块丢弃——仍保留剧情部分

注意：
- 普通段落、描写、对话，既不是章节开头也不是杂项，保留。
- 保持顺序，从前往后依次输出。
- 只输出 JSON，不要输出任何其他文字。

输出格式（JSON 对象）：
{
  "chapters": [ { "index": 2, "title": "第一章 初入江湖" }, ... ],
  "discard": [5, 9, 11]
}
- chapters：章节标题块列表，按出现顺序；index 是 [块N] 中的数字 N，title 是该章的标题（若原文标题合适则用它，否则请起一个简短贴切的标题）。
- discard：应丢弃的杂项块编号数组（按从小到大）。若没有杂项，discard 为空数组 []。
若这批里没有章节开头，chapters 输出 []。`;

interface BlockMark {
  blockIndex: number;
  raw: string;
}

interface BatchResult {
  marks: BlockMark[];
  discard: number[];
}

/** 把全文按空行切成候选块（blockIndex 从 1 开始，与 LLM 编号一致） */
function splitBlocks(fullText: string): string[] {
  return fullText
    .split(/\n{2,}/)
    .map((b) => b.replace(/\r/g, "").trim())
    .filter((b) => b.length > 0);
}

/**
 * 识别给定一批候选块中的章节标题块 + 应丢弃的杂项块。
 */
async function detectBatch(
  cfg: ApiConfig,
  blocks: string[],
  startIndex: number,
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
): Promise<BatchResult> {
  // 块太长会撑爆上下文：每个块只取前 800 字给模型判断，足够判断是否为章节标题/杂项。
  const preview = blocks.map((b, i) => `[块${startIndex + i}] ${b.slice(0, 800)}`).join("\n\n");
  const fb = feedback ? `\n\n用户的分章意见（请严格参考）：${feedback}` : "";
  // 兼容两种返回格式：对象 {chapters, discard} 或 旧式数组 [{index, title}, ...]
  const model = await chatJson<unknown>(
    cfg,
    SYSTEM_PROMPT + fb,
    `以下是这批内容块：\n\n${preview}`,
    { maxTokens: 4000, temperature: 0.1, onUsage },
  );
  const marks: BlockMark[] = [];
  const chapters = Array.isArray(model)
    ? (model as unknown[])
    : Array.isArray((model as { chapters?: unknown })?.chapters)
      ? ((model as { chapters?: unknown[] }).chapters as unknown[])
      : [];
  for (const item of chapters) {
    const obj = item as { index?: unknown; title?: unknown };
    const n = Number(obj?.index);
    const title = typeof obj?.title === "string" ? obj.title.trim() : "";
    if (Number.isFinite(n) && n >= startIndex && n < startIndex + blocks.length && title) {
      marks.push({ blockIndex: n, raw: title });
    }
  }
  const discard: number[] = [];
  const discardList = Array.isArray(model)
    ? []
    : Array.isArray((model as { discard?: unknown })?.discard)
      ? ((model as { discard?: unknown[] }).discard as unknown[])
      : [];
  for (const d of discardList) {
    const n = Number(d);
    if (Number.isFinite(n) && n >= startIndex && n < startIndex + blocks.length) discard.push(n);
  }
  marks.sort((a, b) => a.blockIndex - b.blockIndex);
  discard.sort((a, b) => a - b);
  return { marks, discard };
}

const BEAT_SYSTEM = `你是网文改编分镜助手。用户会给你一批从同一章节中顺序截取的「内容块」（[块N] 标记开头），该章节太长，需要按剧情断点切成几段。
请找出适合切分的断点：场景切换、时间跳跃、视角转换、战斗开始/结束、大事件转折处优先；不要在对话中途、连续动作中途切开。
每段目标 15000～25000 字（按下限凑，宁可段少勿碎）。

只输出 JSON，不要输出任何其他文字，格式：
{"segments": [{"start": 1, "title": "夜探"}, {"start": 57, "title": "反杀"}]}
- segments：按出现顺序；start 是该段起始块的数字 N（第一段 start 必须为 1）；title 是该段 2～10 字的短标题（从剧情提炼，不要用"第一部分"这类机械名）。
- 若这批内容一气呵成不适合切分，segments 只含一个 start 为批首块号的元素。`;

interface BeatSegment {
  start: number;
  title: string;
}

/** 超长章节的剧情断点切分（章内无标题可用时，替代机械按字数硬切） */
async function detectBeatCuts(
  cfg: ApiConfig,
  blocks: string[],
  batchStart: number,
  onUsage?: (pt: number, ct: number) => void,
): Promise<BeatSegment[]> {
  const preview = blocks.map((b, i) => `[块${batchStart + i}] ${b.slice(0, 800)}`).join("\n\n");
  const model = await chatJson<unknown>(cfg, BEAT_SYSTEM, `以下是这批内容块：\n\n${preview}`, {
    maxTokens: 2000,
    temperature: 0.1,
    onUsage,
  });
  const list = Array.isArray(model)
    ? (model as unknown[])
    : Array.isArray((model as { segments?: unknown })?.segments)
      ? ((model as { segments?: unknown[] }).segments as unknown[])
      : [];
  const segs: BeatSegment[] = [];
  for (const item of list) {
    const obj = item as { start?: unknown; title?: unknown };
    const n = Number(obj?.start);
    const title = typeof obj?.title === "string" ? obj.title.trim().slice(0, 10) : "";
    if (Number.isFinite(n) && n >= batchStart && n < batchStart + blocks.length) {
      segs.push({ start: n, title: title || `段${segs.length + 1}` });
    }
  }
  segs.sort((a, b) => a.start - b.start);
  return segs.filter((s, i) => i === 0 || s.start !== segs[i - 1].start);
}

const BATCH = 40; // 每批候选块数量
// AI 分章并发数由文本 API 配置决定（concurrency 参数）；文本请求体较大，并发由该 API 的请求级限流器兜底，
// 避免同时向文本 API 发大量请求触发网关限流/连接失败。

/** 过小章节合并阈值：低于此字数的章节（插图/后记/特典碎章等）不再独占一章 */
export const MIN_CHAPTER_CHARS = 3000;

/** AI 分章统计（可选 out 参数，递归累加） */
export interface SplitStats {
  /** 丢弃的杂项块数 */
  discarded?: number;
  /** 参与识别的块数 */
  blocks?: number;
  /** 碎章合并数 */
  mergedTiny?: number;
}

/**
 * 碎章合并：小于 minChars 的章节并入相邻章节（优先并入前一章；首章并入后一章并保留后者标题）。
 * 解决"插图/后记/特典独占一章"这类机械感；纯函数，可单测。
 */
export function mergeTinyChapters(chapters: ChapterInfo[], minChars = MIN_CHAPTER_CHARS): { chapters: ChapterInfo[]; merged: number } {
  const out = chapters.map((c) => ({ ...c }));
  let merged = 0;
  for (let i = 0; i < out.length; i++) {
    if (out.length <= 1) break;
    if (out[i].text.length >= minChars) continue;
    if (i === 0) {
      out[1].text = `${out[0].text}\n\n${out[1].text}`;
      out[1].charCount = out[1].text.length;
      out.splice(0, 1);
      i = -1; // 下标变化，全量重扫
    } else {
      out[i - 1].text = `${out[i - 1].text}\n\n${out[i].text}`;
      out[i - 1].charCount = out[i - 1].text.length;
      out.splice(i, 1);
      i -= 1; // 配合 for 的 i++，下一轮复查被前移的新住户
    }
    merged++;
  }
  out.forEach((c, i) => (c.index = i));
  return { chapters: out, merged };
}

/**
 * 剧情断点切分：超长章节内找不到小标题时，按场景/事件断点切段（替代机械按字数硬切）。
 * 返回的标题形如"父标题·短标题"，起不出名时用"父标题·上/中/下"。
 */
export async function aiSplitBeats(
  cfg: ApiConfig,
  text: string,
  parentTitle: string,
  maxChapterChars = 40000,
  onUsage?: (pt: number, ct: number) => void,
  concurrency = 3,
): Promise<ChapterInfo[]> {
  const blocks = splitBlocks(text);
  if (blocks.length <= 1) return hardSplitBySentences(text, maxChapterChars);
  // 分批找断点（与分章同并发模型）
  const cuts = new Set<number>();
  const titles = new Map<number, string>();
  const queue: number[] = [];
  for (let i = 0; i < blocks.length; i += BATCH) queue.push(i);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const start0 = queue.shift()!;
      const batchBlocks = blocks.slice(start0, start0 + BATCH);
      const segs = await detectBeatCuts(cfg, batchBlocks, start0 + 1, onUsage);
      for (const s of segs) {
        if (s.start === start0 + 1) {
          if (!titles.has(s.start)) titles.set(s.start, s.title);
          continue;
        }
        cuts.add(s.start);
        if (!titles.has(s.start)) titles.set(s.start, s.title);
      }
      // 批首块恒为段起点（保证覆盖）
      if (!titles.has(start0 + 1)) titles.set(start0 + 1, "");
    }
  });
  await Promise.all(workers);
  const bounds = [1, ...[...cuts].filter((c) => c > 1 && c <= blocks.length).sort((a, b) => a - b)];
  // 断点过密（平均每段不足 3000 字）说明模型在碎切，只保留让每段尽量达标的稀疏子集
  const target = Math.max(15000, Math.floor(maxChapterChars / 2));
  const sparse: number[] = [1];
  let acc = 0;
  const blockLen = (i: number): number => blocks[i - 1]?.length ?? 0;
  for (let k = 1; k < bounds.length; k++) {
    let segLen = 0;
    for (let b = bounds[k - 1]; b < bounds[k]; b++) segLen += blockLen(b);
    acc += segLen;
    if (acc >= target) {
      sparse.push(bounds[k]);
      acc = 0;
    }
  }
  const use = sparse.length > 1 ? sparse : bounds;
  const chapters: ChapterInfo[] = [];
  const suffix = ["上", "中", "下", "四", "五", "六", "七", "八", "九", "十"];
  for (let i = 0; i < use.length; i++) {
    const start = use[i];
    const end = i + 1 < use.length ? use[i + 1] : blocks.length + 1;
    const segText = blocks.slice(start - 1, end - 1).join("\n\n").trim();
    if (!segText) continue;
    const beat = (titles.get(start) || "").trim();
    const title = beat ? `${parentTitle}·${beat}` : `${parentTitle}·${suffix[chapters.length] ?? chapters.length + 1}`;
    if (segText.length > maxChapterChars) {
      // 单段仍超限（巨型单块极少见）：退化为按句硬切，标题顺延
      const hard = hardSplitBySentences(segText, maxChapterChars);
      hard.forEach((h, j) => chapters.push({ ...h, index: -1, title: j === 0 ? title : `${title}（${j + 1}）` }));
    } else {
      chapters.push({ index: -1, title, text: segText, charCount: segText.length });
    }
  }
  if (!chapters.length) return hardSplitBySentences(text, maxChapterChars);
  chapters.forEach((c, i) => (c.index = i));
  return chapters;
}

/**
 * AI 分章：输入未切章全文，输出章节列表。
 * demo（无 API key 时）回退到简单规则：按固定块数切分。
 */
export async function aiSplitChapters(
  cfg: ApiConfig,
  fullText: string,
  onUsage?: (pt: number, ct: number) => void,
  maxChapterChars = 40000,
  feedback?: string,
  concurrency = 3,
  stats?: SplitStats,
): Promise<ChapterInfo[]> {
  const blocks = splitBlocks(fullText);
  if (blocks.length <= 1) {
    // 单块仍超长（如全文无空行）→ 按句子硬切分，避免超长章撑爆剧本阶段上下文
    if (fullText.length > maxChapterChars) {
      return hardSplitBySentences(fullText, maxChapterChars);
    }
    return [{ index: 0, title: "第一章", text: fullText, charCount: fullText.length }];
  }

  // 单个块自身超长 → 递归前先按句子硬切，保证最终章节都不超限
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].length > maxChapterChars) {
      const sub = hardSplitBySentences(blocks[i], maxChapterChars);
      blocks.splice(i, 1, ...sub.map((s) => s.text));
    }
  }

  // 分批识别章节标题块 + 杂项丢弃块（并发生成，并发数来自文本 API 配置）
  const marks: BlockMark[] = [];
  const discardSet = new Set<number>();
  const batches: number[][] = [];
  for (let i = 0; i < blocks.length; i += BATCH) {
    const end = Math.min(i + BATCH, blocks.length);
    const batch: number[] = [];
    for (let k = i + 1; k <= end; k++) batch.push(k);
    batches.push(batch);
  }
  const queue = [...batches];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const batch = queue.shift()!;
      const batchBlocks = batch.map((idx) => blocks[idx - 1]).filter((b): b is string => typeof b === "string");
      const result = await detectBatch(cfg, batchBlocks, batch[0], onUsage, feedback);
      marks.push(...result.marks);
      for (const d of result.discard) discardSet.add(d);
    }
  });
  await Promise.all(workers);
  marks.sort((a, b) => a.blockIndex - b.blockIndex);

  // 去重（同一章节标题可能横跨两批被重复识别，取第一次出现）
  const uniqueMarks: BlockMark[] = [];
  for (const m of marks) {
    if (!uniqueMarks.some((u) => u.blockIndex === m.blockIndex)) {
      uniqueMarks.push(m);
    }
  }

  // 章节标题块不应被当作杂项丢弃
  for (const m of uniqueMarks) discardSet.delete(m.blockIndex);

  // 若 LLM 一个章节标题都没识别到 → 回退：按块数均匀切成若干章
  if (!uniqueMarks.length) {
    log.warn("split", "AI 未识别到章节标题，回退为按字数切分", { blockCount: blocks.length });
    return fallbackSplit(blocks, fullText, maxChapterChars);
  }
  log.info("split", "分章识别结果", {
    chapterCount: uniqueMarks.length,
    discardCount: discardSet.size,
  });
  if (stats) {
    stats.discarded = (stats.discarded ?? 0) + discardSet.size;
    stats.blocks = (stats.blocks ?? 0) + blocks.length;
  }

  // 用标题块作为边界切分正文；跳过被标记丢弃的杂项块
  const isDiscarded = (idx: number): boolean => discardSet.has(idx);
  const chapters: ChapterInfo[] = [];
  const boundaryIndexes = uniqueMarks.map((m) => m.blockIndex);
  for (let i = 0; i < boundaryIndexes.length; i++) {
    const start = boundaryIndexes[i];
    const end = i + 1 < boundaryIndexes.length ? boundaryIndexes[i + 1] : blocks.length + 1;
    const title = uniqueMarks[i].raw;
    const chapterBlocks = blocks
      .slice(start - 1, end - 1)
      .filter((_, k) => !isDiscarded(start + k));
    const text = chapterBlocks.join("\n\n").trim();
    if (!text) continue;
    chapters.push({ index: chapters.length, title, text, charCount: text.length });
  }

  // 第一个章节标题前的「开头块」归入第一章（同样跳过杂项）
  if (boundaryIndexes[0] > 1) {
    const headBlocks = blocks.slice(0, boundaryIndexes[0] - 1).filter((_, k) => !isDiscarded(1 + k));
    const head = headBlocks.join("\n\n").trim();
    if (head && chapters.length) {
      chapters[0].text = `${head}\n\n${chapters[0].text}`;
      chapters[0].charCount = chapters[0].text.length;
    } else if (head && !chapters.length) {
      chapters.unshift({ index: 0, title: "第一章", text: head, charCount: head.length });
    }
  }

  // 章节内容可能仍超长（如整卷放在一章）：优先递归找内层小标题；
  // 章内无标题可用（递归只产出机械"第X部分"）时，改用剧情断点切分，不断在对话中途与连续动作中途
  const result: ChapterInfo[] = [];
  for (const ch of chapters) {
    if (ch.text.length > maxChapterChars) {
      const sub = await aiSplitChapters(cfg, ch.text, onUsage, maxChapterChars, feedback, concurrency, stats);
      const mechanical = sub.length > 1 && sub.every((s) => /^第\d+部分$/.test(s.title));
      if (mechanical) {
        log.info("split", `超长章无内层标题，改用剧情断点切分：${ch.title}`, { chars: ch.text.length });
        const beats = await aiSplitBeats(cfg, ch.text, ch.title, maxChapterChars, onUsage, concurrency);
        result.push(...beats.map((s, i) => ({ ...s, index: result.length + i })));
      } else {
        result.push(
          ...sub.map((s, i) => ({
            ...s,
            index: result.length + i,
            // 递归找到真实小标题则保留；机械名才挂父标题序号
            title: /^第\d+部分$/.test(s.title) ? `${ch.title} ${i + 1}` : s.title,
          })),
        );
      }
    } else {
      result.push(ch);
    }
  }
  result.forEach((c, i) => (c.index = i));
  // 碎章合并：插图/后记/特典等不足 MIN_CHAPTER_CHARS 的章节并入相邻章节，不再独占一章
  const merged = mergeTinyChapters(result, MIN_CHAPTER_CHARS);
  if (merged.merged > 0) {
    log.info("split", `碎章合并：${merged.merged} 个过小章节已并入相邻章节`, {});
    if (stats) stats.mergedTiny = (stats.mergedTiny ?? 0) + merged.merged;
  }
  return merged.chapters;
}

/** 回退分章：按近似字数把全文切分成若干章 */
function hardSplitBySentences(text: string, maxChars: number): ChapterInfo[] {
  const sentences = text.split(/(?<=[。！？!?；;\n])/).filter((s) => s.trim());
  const chapters: ChapterInfo[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      if (current.trim()) {
        chapters.push({ index: chapters.length, title: `第${chapters.length + 1}部分`, text: current.trim(), charCount: current.trim().length });
      }
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) {
    chapters.push({ index: chapters.length, title: `第${chapters.length + 1}部分`, text: current.trim(), charCount: current.trim().length });
  }
  return chapters.length ? chapters : [{ index: 0, title: "第一章", text, charCount: text.length }];
}

/** 回退分章：按近似字数把全文切分成若干章 */
function fallbackSplit(blocks: string[], fullText: string, maxChapterChars: number): ChapterInfo[] {
  const textLen = fullText.length;
  if (textLen <= maxChapterChars) {
    return [{ index: 0, title: "第一章", text: fullText, charCount: textLen }];
  }
  const count = Math.ceil(textLen / maxChapterChars);
  const perBlock = Math.ceil(blocks.length / count);
  const chapters: ChapterInfo[] = [];
  for (let i = 0; i < blocks.length; i += perBlock) {
    const text = blocks.slice(i, i + perBlock).join("\n\n").trim();
    if (!text) continue;
    chapters.push({
      index: chapters.length,
      title: `第${chapters.length + 1}部分`,
      text,
      charCount: text.length,
    });
  }
  return chapters;
}

/**
 * 无 LLM 时的分章回退：基于章节标题的正则规则切分。
 * 兼容多文件合并导入（未切章）的情况，保证 demo 模式也能分章。
 */
export function splitChaptersForFallback(fullText: string): ChapterInfo[] {
  const lines = fullText.split(/\r?\n/);
  const chapters: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } = { title: "第一章", lines: [] };
  let anyChapter = false;

  const isChapterTitle = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed.length > 40 || trimmed.length < 2) return false;
    if (
      /^\s*(第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部集幕篇](?:[\s·：:－—-][^。！？!?；;\n]{1,12})?|(?:序章|序言|楔子|尾声|终章|番外|后记|前言|引子)(?:[\s·：:－—-][^。！？!?；;\n]{1,12})?)\s*$/.test(
        trimmed,
      )
    ) {
      return true;
    }
    return /^(Chapter|CHAPTER|Episode|episode|Prologue|Epilogue|Act)\s*\d*.*$/i.test(trimmed);
  };

  for (const raw of lines) {
    if (isChapterTitle(raw)) {
      current = { title: raw.trim(), lines: [] };
      chapters.push(current);
      anyChapter = true;
    } else {
      current.lines.push(raw);
    }
  }
  if (!anyChapter) chapters.push({ title: "第一章", lines });

  const merged: ChapterInfo[] = [];
  for (const c of chapters) {
    const text = c.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    merged.push({ index: merged.length, title: c.title.trim(), text, charCount: text.length });
  }
  if (!merged.length) {
    merged.push({ index: 0, title: "第一章", text: fullText.trim(), charCount: fullText.length });
  }
  return merged;
}
