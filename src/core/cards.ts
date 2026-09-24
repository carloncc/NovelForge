import type { CharacterCard, ExtractionResult, ItemCard, LoreCard } from "./types";
import { sanitizeId } from "./render";
import { tauri } from "../utils/tauri";

export interface CardsSaveResult {
  scriptCacheCleared: number;
  imageCacheCleared: number;
}

/**
 * 录音互斥守卫（1401 纯函数）：
 * 任意一项为真都说明有进行中的录音/残留资源，此时再起新录音会泄漏旧音频流、
 * 双计时器叠加、参考音频混片。调用方（EditCards）应在 startSystemAudioRecording
 * 入口调用，返回 true 即拒绝并提示用户先停止/取消当前录音。
 */
export interface RecordingMutexState {
  recordingChar: string | null;
  hasRecorder: boolean;
  hasStream: boolean;
  hasTimer: boolean;
}

export function shouldBlockRecordingStart(state: RecordingMutexState): boolean {
  return !!state.recordingChar || state.hasRecorder || state.hasStream || state.hasTimer;
}

/**
 * 保存互斥守卫（1410 纯函数）：
 * AI 识别/音色克隆/AI 选音色/录音完成后只写内存（local），本身不落 cards.json。
 * 保存按钮若在这些操作在途时可用，会把不含新字段的快照写盘，内存与磁盘分叉、
 * 重启后付费结果丢失。返回 true 即应禁用「保存卡片」并在 save() 入口二次拦截。
 */
export interface CardSaveMutexState {
  saving: boolean;
  recognizing: boolean;
  voiceBusy: boolean;
  castBusy: boolean;
  recording: boolean;
}

export function shouldBlockCardSave(state: CardSaveMutexState): boolean {
  return state.saving || state.recognizing || state.voiceBusy || state.castBusy || state.recording;
}

/**
 * 保存编辑后的卡片。
 * 默认只清立绘/物品图缓存（外貌变化需重新出图），不清剧本缓存——
 * 剧本引用的是角色 id/name，多数编辑（音色/服装/外貌微调）不该触发全量重跑剧本，
 * 否则一章失败会让整个项目的剧本缓存被清空、下次全部重跑，白烧大量 token。
 * 明确改动了台词相关的角色信息时，可传 invalidateScriptCache=true 主动清剧本缓存。
 */
export async function saveEditedCards(
  outputDir: string,
  cards: ExtractionResult,
  log: (msg: string, level?: "info" | "warn" | "success") => void,
  invalidateScriptCache = false,
  demo = false,
): Promise<CardsSaveResult> {
  const metaDir = `${outputDir}/.novel2vn`;
  const cacheDir = `${metaDir}/cache`;

  // 保留旧缓存中的小说指纹（防止用户编辑被指纹校验误判作废），同时留一份旧卡片做差分
  let novelFp: string | undefined;
  let oldCards: ExtractionResult | null = null;
  for (const f of ["cards.json", "cards_demo.json"]) {
    try {
      const { text } = await tauri.readTextFile(`${metaDir}/${f}`);
      const parsed = JSON.parse(text) as ExtractionResult & { _novelFp?: string };
      if (parsed._novelFp && !novelFp) novelFp = parsed._novelFp;
      if (!oldCards && Array.isArray(parsed.characters)) oldCards = parsed;
    } catch {
      /* 无旧缓存 */
    }
  }
  // demo/正式隔离：只写当前模式的文件。旧实现同时写两份同一 payload，
  // demo 改卡污染正式、正式改卡污染 demo，且 _novelFp 被单值覆盖导致误作废。
  const cachePrefix = demo ? "cards_demo" : "cards";
  const payload = novelFp ? { ...cards, _novelFp: novelFp } : cards;

  await tauri.writeTextFile(`${metaDir}/${cachePrefix}.json`, JSON.stringify(payload, null, 2));

  let scriptCleared = 0;
  let imageCleared = 0;

  // 剧本缓存：仅显式要求时清空（默认保留，避免全量重跑白烧 token）
  if (invalidateScriptCache) {
    try {
      const entries = await tauri.listDir(cacheDir);
      for (const e of entries) {
        if (!e.isDir && /^script(_demo)?_ch\d+_/.test(e.name)) {
          await tauri.removePath(e.path).catch(() => {});
          scriptCleared++;
        }
      }
    } catch {
      /* cache 目录不存在 */
    }
  }

  // 立绘/物品图缓存失效：只清「被删除/绘画相关字段变化」的角色与物品。
  // 旧实现每次保存全删 figure_/item_：只改个音色也要重画全书立绘。绘画相关字段以外
  // （音色/性别/性格/主题色等）的改动不碰图片缓存。
  const IMAGE_FIELDS: (keyof CharacterCard)[] = ["imagePrompt", "threeViewPrompt", "actions", "costumes", "emotions"];
  const deadCharIds = new Set<string>();
  const deadItemIds = new Set<string>();
  if (oldCards) {
    const oldChars = new Map(oldCards.characters.map((c) => [c.id, c]));
    const newChars = new Map(cards.characters.map((c) => [c.id, c]));
    for (const [id, oc] of oldChars) {
      const nc = newChars.get(id);
      if (!nc) {
        deadCharIds.add(id);
        continue;
      }
      if (IMAGE_FIELDS.some((k) => JSON.stringify(oc[k] ?? null) !== JSON.stringify(nc[k] ?? null))) {
        deadCharIds.add(id);
      }
    }
    const oldItems = new Map((oldCards.items ?? []).map((i) => [i.id, i]));
    const newItems = new Map((cards.items ?? []).map((i) => [i.id, i]));
    for (const [id, oi] of oldItems) {
      const ni: ItemCard | undefined = newItems.get(id);
      if (!ni || oi.imagePrompt !== ni.imagePrompt) deadItemIds.add(id);
    }
  } else {
    // 无旧卡片可比对（首存）：沿用旧的全量清理，避免新旧混用
    for (const c of cards.characters) deadCharIds.add(c.id);
    for (const i of cards.items ?? []) deadItemIds.add(i.id);
  }
  try {
    const imageDir = `${cacheDir}/images`;
    const entries = await tauri.listDir(imageDir);
    // 存活 id 前缀保护（id "a" 与 "a_b" 的 figure 文件都会命中 figure_a_，后者不能误删）
    const liveFigurePrefix = cards.characters
      .filter((c) => !deadCharIds.has(c.id))
      .map((c) => `figure_${sanitizeId(c.id).toLowerCase()}_`);
    const liveThreeview = new Set(
      cards.characters.filter((c) => !deadCharIds.has(c.id)).map((c) => `threeview_${sanitizeId(c.id).toLowerCase()}`),
    );
    const liveItem = new Set(
      (cards.items ?? []).filter((i) => !deadItemIds.has(i.id)).map((i) => `item_${sanitizeId(i.id).toLowerCase()}`),
    );
    const baseNoExt = (name: string): string => name.replace(/\.(png|jpg|jpeg|webp)$/i, "");
    for (const e of entries) {
      if (e.isDir) continue;
      const lower = e.name.toLowerCase();
      const base = baseNoExt(lower);
      let dead = false;
      if (lower.startsWith("figure_")) {
        const hitDead = [...deadCharIds].some((id) => lower.startsWith(`figure_${sanitizeId(id).toLowerCase()}_`));
        const hitLive = liveFigurePrefix.some((pre) => lower.startsWith(pre));
        dead = hitDead && !hitLive;
      } else if (lower.startsWith("threeview_")) {
        const sid = [...deadCharIds].map((id) => `threeview_${sanitizeId(id).toLowerCase()}`);
        dead = sid.includes(base) && !liveThreeview.has(base);
      } else if (lower.startsWith("item_")) {
        const sid = [...deadItemIds].map((id) => `item_${sanitizeId(id).toLowerCase()}`);
        dead = sid.includes(base) && !liveItem.has(base);
      }
      if (dead) {
        await tauri.removePath(e.path).catch(() => {});
        imageCleared++;
      }
    }
  } catch {
    /* images 目录不存在 */
  }

  log(
    invalidateScriptCache
      ? `卡片已保存：剧本缓存清除 ${scriptCleared} 个，立绘/物品图缓存清除 ${imageCleared} 个（重新生成时将使用新卡片）`
      : imageCleared > 0
        ? `卡片已保存：${imageCleared} 个立绘/物品图缓存已失效（仅绘画相关改动，未改动的不重画）；剧本缓存保留，如需重写剧本请用「重新生成此章」`
        : "卡片已保存：本次改动不涉及绘画（音色/文字类），图片缓存全部保留",
    "success",
  );
  return { scriptCacheCleared: scriptCleared, imageCacheCleared: imageCleared };
}

/* ==================== #799 世界观卡片（纯函数：提取→剧本上下文→展示共用） ==================== */

const LORE_KINDS: ReadonlySet<string> = new Set(["map", "quest", "faction", "artifact", "system", "other"]);

/** 规范化一条 lore（空标题/空内容视为残卡返回 null；kind 非法回退 other） */
export function normalizeLoreCard(raw: unknown): LoreCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const content = typeof r.content === "string" ? r.content.trim() : "";
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!title || !content || !id) return null;
  const kind = typeof r.kind === "string" && LORE_KINDS.has(r.kind) ? (r.kind as LoreCard["kind"]) : "other";
  return {
    id,
    title,
    kind,
    content,
    sourceNote: typeof r.sourceNote === "string" && r.sourceNote.trim() ? r.sourceNote.trim() : undefined,
  };
}

/** lore 去重（标题精确一致并卡，content 取较长者；保序） */
export function dedupeLoreCards(list: unknown): LoreCard[] {
  if (!Array.isArray(list)) return [];
  const out: LoreCard[] = [];
  const byTitle = new Map<string, LoreCard>();
  for (const raw of list) {
    const card = normalizeLoreCard(raw);
    if (!card) continue;
    const key = card.title.toLowerCase().replace(/\s+/g, "");
    const hit = byTitle.get(key);
    if (hit && hit.title.trim() === card.title.trim()) {
      if (card.content.length > hit.content.length) hit.content = card.content;
      if (!hit.sourceNote && card.sourceNote) hit.sourceNote = card.sourceNote;
      continue;
    }
    byTitle.set(key, card);
    out.push(card);
  }
  return out;
}

/** 单条 lore 的剧本上下文行：`id（标题［类别］）：content 全文`（不概括压缩，#799） */
export function loreContextLine(l: LoreCard): string {
  return `${l.id}（${l.title}［${l.kind}］）：${l.content}`;
}

/** lore 区剧本上下文（供剧本提示词消费；无 lore 返回 ""，调用方按空即不注入处理） */
export function buildLoreContext(lore: LoreCard[] | undefined): string {
  const list = dedupeLoreCards(lore ?? []);
  if (!list.length) return "";
  return list.map(loreContextLine).join("\n");
}

/** 从 ExtractionResult 取 lore 上下文节（剧本 user 消息直接拼在场景卡之后） */
export function loreContextForScript(cards: Pick<ExtractionResult, "lore">): string {
  const body = buildLoreContext(cards.lore);
  return body ? `世界观设定卡：\n${body}` : "";
}
