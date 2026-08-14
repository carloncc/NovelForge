import type { ApiConfig, CharacterAction, CharacterCard, ExtractionResult, ItemCard, SceneCard } from "./types";
import { chatCompletion, chatJson } from "../api/openaiCompatible";
import type { ChatMessage, ChatTool, ToolCall } from "../api/openaiCompatible";
import { inputCharBudget, resolveContextLength } from "../api/providers";
import { voiceLibraryFor } from "../stores/config";
import { normalizeExtractionResult } from "./extract";
import { log as logger } from "../utils/logger";

/**
 * Agent 模式的「角色/场景/物品」提取：
 * 把经典的一次性大调用拆成多步自主流程——
 *   ① 扫描（分多段，逐段用工具调用收集候选卡片）
 *   ② 合并（按名称去重，跨段归并同一角色）
 *   ③ 补全（批量 LLM 调用补全 imagePrompt/threeViewPrompt/actions/voiceName 等）
 *   ④ 校验（复用 normalizeExtractionResult）
 * 若模型/接口不支持 function calling，自动回退到「文本动作协议」（每轮输出一个 JSON 动作）。
 */

export type AgentLog = (message: string, level?: "info" | "warn" | "success") => void;

export interface ExtractAgentOptions {
  onUsage?: (pt: number, ct: number) => void;
  /** 返回 true 表示已中止（外部 abort），agent 停止调度下一步 */
  isAborted?: () => boolean;
  /** 进度日志回调（写入管线日志） */
  log?: AgentLog;
  /** 用户对上一版提取结果的修改意见（注入扫描与补全步骤） */
  feedback?: string;
}

/** 单次工具调用的结构化参数（供状态机执行） */
export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 状态机执行一个工具调用的结果（回传给模型的 tool 消息） */
export interface AgentToolResult {
  callId: string;
  ok: boolean;
  content: string;
}

/** 提取 agent 的内存状态：按 id 收拢角色/场景/物品 */
export interface ExtractAgentState {
  characters: Map<string, CharacterCard>;
  scenes: Map<string, SceneCard>;
  items: Map<string, ItemCard>;
}

export interface AgentChatResponse {
  content: string;
  toolCalls?: ToolCall[];
}

/** LLM 交互函数（工具模式或文本模式）；测试时可用脚本化假实现替换 */
export type AgentChatFn = (messages: ChatMessage[], tools: ChatTool[], opts: { json?: boolean }) => Promise<AgentChatResponse>;

/** 每段扫描的最大往返轮数（防止模型陷入死循环） */
const MAX_ROUNDS_PER_CHUNK = 40;
/** 文本协议每次输出一个动作；tools 为空时即走文本协议 */
const TEXT_ACTION_RE = /^\s*\{\s*"action"\s*:\s*"([a-z_]+)"\s*(?:,\s*"data"\s*:\s*(\{.*\}))?\s*\}\s*$/s;

const DEFAULT_COLORS = ["#3b5bdb", "#9775fa", "#e8590c", "#2f9e44", "#c92a2a", "#0b7285", "#5f3dc4", "#e67700"];

function defaultColor(index: number): string {
  return DEFAULT_COLORS[index % DEFAULT_COLORS.length] ?? "#3b5bdb";
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function omit<T extends Record<string, unknown>>(obj: T, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) out[k] = obj[k];
  }
  return out;
}

function pickNonEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v == null || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/* ==================== 工具定义（OpenAI 兼容 function calling） ==================== */

function charParams(required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: "英文或拼音小写唯一标识，如 linxiao" },
      name: { type: "string", description: "中文姓名" },
      appearance: { type: "string", description: "外貌描述（发型、眼睛、体型、气质）" },
      clothing: { type: "string", description: "服装描述（颜色、款式）" },
      personality: { type: "string", description: "性格特征" },
      voiceDesc: { type: "string", description: "适合的音色描述（如「清冷的女声」）" },
      color: { type: "string", description: "十六进制主题色，如 #3b5bdb" },
      isNpc: { type: "boolean", description: "是否次要角色/NPC（有台词但戏份少）；主要角色填 false" },
      costumes: {
        type: "array",
        description: "服装差分列表（数量按剧情决定、不设上限；剧情出现换装就要收录）",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "简短英文标识，如 casual/formal/battle/pajama" },
            name: { type: "string", description: "服装中文名，如 日常服/礼服/战斗服" },
            prompt: { type: "string", description: "该服装的英文图像提示词（人物外貌一致 + 服装款式颜色材质，全身，纯色背景）" },
          },
          required: ["id", "name", "prompt"],
        },
      },
    },
    required,
  };
}

export const SCAN_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "add_character",
      description: "新增一个角色卡片。只收录有台词或推动剧情的主要角色；若该角色已存在请改用 update_character。",
      parameters: charParams(["id", "name"]),
    },
  },
  {
    type: "function",
    function: {
      name: "update_character",
      description: "更新已有角色的字段（appearance/clothing/personality/voiceDesc/color 等）。patch 里不要包含 id/name。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "已有角色的 id" },
          patch: { type: "object", description: "要更新的字段对象" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_scene",
      description: "新增一个故事发生的地点场景。若场景已存在请保持 id 一致。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "唯一标识，如 classroom" },
          location: { type: "string", description: "地点名，如「城门前」" },
          atmosphere: { type: "string", description: "氛围，如「阴沉的黄昏」" },
          time: { type: "string", description: "时间" },
        },
        required: ["id", "location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_item",
      description: "新增一个重要物品（获得、交接、使用的关键道具）。若物品已存在请保持 id 一致。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "唯一标识，如 xingyun" },
          name: { type: "string", description: "物品名" },
          appearance: { type: "string", description: "外观描述" },
          note: { type: "string", description: "它在剧情中的意义" },
        },
        required: ["id", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_extraction",
      description: "处理完当前片段后调用，表示本段扫描结束。",
      parameters: { type: "object", properties: {} },
    },
  },
];

/* ==================== 状态机：执行工具调用 ==================== */

export function applyTool(state: ExtractAgentState, call: AgentToolCall): AgentToolResult {
  const fail = (msg: string): AgentToolResult => ({ callId: call.id, ok: false, content: msg });
  const ok = (content: string): AgentToolResult => ({ callId: call.id, ok: true, content });
  try {
    switch (call.name) {
      case "add_character": {
        const name = str(call.args.name).trim();
        if (!name) return fail("add_character 缺少 name");
        const id = str(call.args.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_") || `c${state.characters.size + 1}`;
        const existing = state.characters.get(id);
        if (existing) {
          Object.assign(existing, omit(call.args, "id", "name"));
          existing.name = existing.name || name;
          return ok(`角色「${name}」(${id}) 已存在，已合并补充字段，当前共 ${state.characters.size} 个角色`);
        }
        const card: CharacterCard = {
          id,
          name,
          appearance: str(call.args.appearance),
          clothing: str(call.args.clothing),
          personality: str(call.args.personality),
          voiceDesc: str(call.args.voiceDesc),
          color: str(call.args.color) || defaultColor(state.characters.size),
          isNpc: call.args.isNpc === true,
          imagePrompt: "",
          threeViewPrompt: "",
          actions: [],
        };
        state.characters.set(id, card);
        return ok(`已收录角色「${name}」(${id})，当前共 ${state.characters.size} 个角色`);
      }
      case "update_character": {
        const id = str(call.args.id);
        const existing = state.characters.get(id);
        if (!existing) return fail(`角色 ${id} 不存在，请用 add_character 添加`);
        const patch = call.args.patch;
        if (patch && typeof patch === "object") {
          Object.assign(existing, omit(patch as Record<string, unknown>, "id", "name"));
        }
        return ok(`已更新角色「${existing.name}」(${id})`);
      }
      case "add_scene": {
        const location = str(call.args.location).trim();
        if (!location) return fail("add_scene 缺少 location");
        const id = str(call.args.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_") || `s${state.scenes.size + 1}`;
        state.scenes.set(id, {
          id,
          location,
          atmosphere: str(call.args.atmosphere),
          time: str(call.args.time),
          imagePrompt: "",
        });
        return ok(`已收录场景「${location}」(${id})，当前共 ${state.scenes.size} 个场景`);
      }
      case "add_item": {
        const name = str(call.args.name).trim();
        if (!name) return fail("add_item 缺少 name");
        const id = str(call.args.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_") || `i${state.items.size + 1}`;
        state.items.set(id, {
          id,
          name,
          appearance: str(call.args.appearance),
          note: str(call.args.note),
          imagePrompt: "",
        });
        return ok(`已收录物品「${name}」(${id})，当前共 ${state.items.size} 个物品`);
      }
      case "finish_extraction":
        return ok("扫描完成");
      default:
        return fail(`未知工具 ${call.name}`);
    }
  } catch (e) {
    return fail(`执行 ${call.name} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ==================== 文本协议：解析单轮 JSON 动作 ==================== */

export function parseTextAction(content: string): { name: string; data?: Record<string, unknown> } | null {
  const cleaned = content.trim().replace(/^```(?:json)?|```$/g, "").trim();
  const match = TEXT_ACTION_RE.exec(cleaned);
  if (match) {
    let data: Record<string, unknown> | undefined;
    if (match[2]) {
      try {
        data = JSON.parse(match[2]) as Record<string, unknown>;
      } catch {
        /* data 解析失败视为无 data */
      }
    }
    return { name: match[1], data };
  }
  // 容忍：模型直接输出完整 JSON 对象而非严格单行
  try {
    const obj = JSON.parse(cleaned) as { action?: unknown; data?: unknown };
    if (obj && typeof obj.action === "string") {
      return { name: obj.action, data: typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : undefined };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/* ==================== 分片 ==================== */

export function splitNovelForAgent(novelText: string, budget: number): string[] {
  const chunks: string[] = [];
  const sep = "\n\n";
  const budgetSafe = Math.max(100, budget);
  let start = 0;
  while (start < novelText.length) {
    let end = Math.min(start + budgetSafe, novelText.length);
    if (end < novelText.length) {
      const boundary = novelText.lastIndexOf(sep, end);
      if (boundary > start + budgetSafe / 2) end = boundary;
    }
    chunks.push(novelText.slice(start, end));
    start = end;
  }
  if (!chunks.length) chunks.push("");
  return chunks;
}

/* ==================== 扫描循环 ==================== */

export function stateSummary(state: ExtractAgentState): string {
  const compact = {
    characters: [...state.characters.values()].map((c) => ({
      id: c.id,
      name: c.name,
      appearance: c.appearance,
      clothing: c.clothing,
      personality: c.personality,
      voiceDesc: c.voiceDesc,
    })),
    scenes: [...state.scenes.values()].map((s) => ({ id: s.id, location: s.location, atmosphere: s.atmosphere, time: s.time })),
    items: [...state.items.values()].map((i) => ({ id: i.id, name: i.name, note: i.note })),
  };
  const json = JSON.stringify(compact);
  return json.length > 12000 ? json.slice(0, 12000) + "\n……(摘要截断)" : json;
}

/**
 * 对单个片段执行扫描循环：模型每轮返回若干工具调用（或文本动作），驱动执行并回传结果，
 * 直到模型调用 finish_extraction / 输出 finish 动作，或达到轮数上限。
 * @returns 是否正常以 finish 结束
 */
export async function runScanChunk(
  chat: AgentChatFn,
  system: string,
  user: string,
  state: ExtractAgentState,
  opts: { maxRounds?: number; toolCalls: boolean; isAborted?: () => boolean },
): Promise<boolean> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS_PER_CHUNK;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  for (let round = 0; round < maxRounds; round++) {
    if (opts.isAborted?.()) throw new Error("已中止");
    const response = await chat(messages, opts.toolCalls ? SCAN_TOOLS : [], { json: !opts.toolCalls });
    if (opts.toolCalls) {
      const calls = response.toolCalls ?? [];
      if (!calls.length) {
        // 模型没调用工具就收尾：提示一次继续处理，最后一轮则退出
        if (round < maxRounds - 1) {
          messages.push({ role: "assistant", content: response.content || null });
          messages.push({ role: "user", content: "请调用工具继续处理当前片段，处理完成后调用 finish_extraction。" });
          continue;
        }
        return false;
      }
      messages.push({ role: "assistant", content: response.content || null, tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = applyTool(state, { id: call.id, name: call.function.name, args });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
        if (call.function.name === "finish_extraction") return true;
      }
    } else {
      const action = parseTextAction(response.content);
      if (!action) {
        messages.push({ role: "assistant", content: response.content || null });
        messages.push({
          role: "user",
          content: '请输出合法的 JSON 动作，如 {"action":"add_character","data":{"id":"linxiao","name":"林澈"}}；处理完成后输出 {"action":"finish"}。不要输出解释文字。',
        });
        continue;
      }
      if (action.name === "finish") return true;
      const result = applyTool(state, { id: `text_${round}_${messages.length}`, name: action.name, args: action.data ?? {} });
      messages.push({ role: "assistant", content: response.content || null });
      messages.push({ role: "user", content: `动作执行结果：${result.content}` });
    }
  }
  return false;
}

/* ==================== 合并去重 ==================== */

function normalizeName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, "");
}

function mergeCharacter(target: CharacterCard, source: CharacterCard): void {
  for (const k of ["appearance", "clothing", "personality", "voiceDesc", "imagePrompt", "threeViewPrompt", "color"] as const) {
    if (!target[k] && source[k]) (target as unknown as Record<string, unknown>)[k] = source[k];
  }
  if (!target.voiceName && source.voiceName) target.voiceName = source.voiceName;
  const actionMap = new Map<string, CharacterAction>();
  for (const a of [...(target.actions ?? []), ...(source.actions ?? [])]) {
    if (a?.id) actionMap.set(a.id, a);
  }
  target.actions = [...actionMap.values()];
}

/** 跨片段合并：同名（归一化后一致）角色视为同一人，保留先收录的更完整字段 */
export function mergeCandidates(state: ExtractAgentState): void {
  const byName = new Map<string, string[]>();
  for (const [id, c] of state.characters) {
    const key = normalizeName(c.name);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(id);
    byName.set(key, list);
  }
  for (const ids of byName.values()) {
    if (ids.length < 2) continue;
    const keep = ids[0];
    const kept = state.characters.get(keep);
    if (!kept) continue;
    for (let i = 1; i < ids.length; i++) {
      const other = state.characters.get(ids[i]);
      if (!other) continue;
      mergeCharacter(kept, other);
      state.characters.delete(ids[i]);
    }
  }
}

/* ==================== 补全（批量 LLM 调用） ==================== */

const ENRICH_SYSTEM = `你是视觉小说美术与制作总监。下面给出从小说中初步提取到的角色/场景/物品卡片，字段可能不完整。请补全后输出完整 JSON（只输出 JSON，不要其他文字）：

{
  "characters": [完整角色卡...],
  "scenes": [完整场景卡...],
  "items": [完整物品卡...]
}

角色卡字段：
- id（保持原值不变）、name（中文姓名）
- appearance（外貌描述）、clothing（服装描述）、personality（性格特征）
- voiceDesc（适合的音色描述）
- voiceName（必须从"可用音色列表"中选最接近的一个，不要编造列表外的值）
- imagePrompt：用于 AI 绘画生成立绘的完整英文 prompt，只描述人物本身（全身像、服装、发型、表情、姿态），禁止写任何背景/底色/场地/环境描述（系统会自动附加纯绿幕背景），风格统一为"动漫风格，精美立绘"
- threeViewPrompt：用于生成该角色"三视图参考图"（正面/侧面/背面）的完整英文 prompt：同一角色设定、站姿自然、表情平静、全身可见，同样禁止写任何背景/底色描述（系统会自动附加纯绿幕背景），务必与人物的 imagePrompt 描述完全一致
- actions：该角色可能做出的经典动作 [{id, name, prompt}]（prompt 为英文，保持人物外观完全一致，纯色背景，全身可见，动漫风格；数量不限，按角色特点给出）
- costumes：该角色的服装差分 [{id, name, prompt}]（数量按剧情决定、不设上限；剧情出现换装就要收录；prompt 为英文，人物外貌一致 + 服装款式颜色材质，全身可见，纯色背景）
- color：十六进制主题色
- isNpc：布尔值。次要角色/NPC（有台词但戏份少）填 true；主要角色填 false

场景卡字段：id、location（地点名）、atmosphere（氛围）、time（时间）、imagePrompt（英文背景 prompt，无人物，动漫场景风格）
物品卡字段：id、name、appearance（外观描述）、note（剧情意义）、imagePrompt（英文物品特写 prompt，居中构图，干净浅色背景）

规则：
- 补全缺失字段，不要删除已有信息，不要改变 id。
- 角色/场景/物品数量一律按剧情决定、不设上限（上限会损害最终游戏效果）。`;

async function enrichCards(
  cfg: ApiConfig,
  state: ExtractAgentState,
  title: string,
  lib: string[],
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
): Promise<void> {
  const payload = {
    characters: [...state.characters.values()],
    scenes: [...state.scenes.values()],
    items: [...state.items.values()],
  };
  const fb = feedback ? `\n\n用户意见（请严格参考并落实）：${feedback}` : "";
  const user = `小说标题：${title}\n\n可用音色列表：${lib.join(", ")}${fb}\n\n当前卡片 JSON：\n${JSON.stringify(payload)}`;
  const outputTokens = Math.min(resolveContextLength(cfg), 240_000);
  const enriched = await chatJson<{ characters?: CharacterCard[]; scenes?: SceneCard[]; items?: ItemCard[] }>(
    cfg,
    ENRICH_SYSTEM,
    user,
    { maxTokens: outputTokens, onUsage },
  );

  if (Array.isArray(enriched.characters)) {
    const next = new Map<string, CharacterCard>();
    for (const c of enriched.characters) {
      if (!c || !c.id) continue;
      const prev = state.characters.get(c.id);
      const name = c.name || prev?.name || c.id;
      next.set(c.id, { ...(prev ?? {}), ...pickNonEmpty(c as unknown as Record<string, unknown>), id: c.id, name } as CharacterCard);
    }
    // 模型漏掉的卡保留原样（避免丢卡）
    for (const [id, card] of state.characters) if (!next.has(id)) next.set(id, card);
    state.characters = next;
  }
  if (Array.isArray(enriched.scenes)) {
    const next = new Map<string, SceneCard>();
    for (const s of enriched.scenes) {
      if (!s || !s.id) continue;
      const prev = state.scenes.get(s.id);
      next.set(s.id, { ...(prev ?? {}), ...pickNonEmpty(s as unknown as Record<string, unknown>), id: s.id } as SceneCard);
    }
    for (const [id, card] of state.scenes) if (!next.has(id)) next.set(id, card);
    state.scenes = next;
  }
  if (Array.isArray(enriched.items)) {
    const next = new Map<string, ItemCard>();
    for (const it of enriched.items) {
      if (!it || !it.id) continue;
      const prev = state.items.get(it.id);
      next.set(it.id, { ...(prev ?? {}), ...pickNonEmpty(it as unknown as Record<string, unknown>), id: it.id } as ItemCard);
    }
    for (const [id, card] of state.items) if (!next.has(id)) next.set(id, card);
    state.items = next;
  }
}

/* ==================== 汇总输出 ==================== */

export function finalizeState(state: ExtractAgentState, lib: string[], title: string): ExtractionResult {
  const result: ExtractionResult = {
    title,
    // 数量一律按剧情决定，不做任何上限（上限会损害最终游戏效果）
    characters: [...state.characters.values()],
    scenes: [...state.scenes.values()],
    items: [...state.items.values()],
  };
  return normalizeExtractionResult(result, lib, title);
}

/* ==================== 工具不支持探测 ==================== */

export function isToolUnsupportedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/400|error|失败|不支持|unsupported/i.test(msg)) return false;
  return /tools|function|tool_call|函数|工具/i.test(msg);
}

function scanSystemPrompt(feedback?: string): string {
  const fb = feedback ? `\n\n用户意见（请严格参考并落实）：${feedback}` : "";
  return `你是视觉小说制作人的「角色提取代理」。小说会被分成多段陆续发给你，你的任务是用工具逐步收集制作视觉小说所需的卡片。

工具说明：
- add_character(id, name, appearance, clothing, personality, voiceDesc, color, isNpc)：新增一个角色。所有有台词或推动剧情发展的人物都要收录，数量按剧情决定、不要人为设限；有台词但戏份少的次要角色/NPC 请把 isNpc 设为 true。同一角色已存在时请用 update_character 更新，不要新建重复 id。
- update_character(id, patch)：更新已有角色的字段。
- add_scene(id, location, atmosphere, time)：新增一个故事场景地点。
- add_item(id, name, appearance, note)：新增重要物品（获得、交接、使用的关键道具）。
- finish_extraction()：处理完当前片段后调用，表示本段扫描结束。

规则：
- 只从当前片段识别，不要编造当前片段未出现的人物/场景/物品。
- id 用英文或拼音小写（如 linxiao），必须唯一；若角色已在「当前已收录卡片」中出现，保持原 id 并用 update_character 补充或修正。
- 场景/物品若已存在，请保持 id 一致。
- 外貌、服装、性格、音色描述用中文，简洁准确。
- 不要输出解释文字，只调用工具。${fb}`;
}

/* ==================== 主入口 ==================== */

export async function extractFromNovelAgent(
  cfg: ApiConfig,
  novelText: string,
  title: string,
  opts: ExtractAgentOptions = {},
): Promise<ExtractionResult> {
  const lib = voiceLibraryFor(cfg);
  const isAborted = opts.isAborted ?? (() => false);
  const onUsage = opts.onUsage;
  const logFn = opts.log;

  const chat: AgentChatFn = async (messages, tools, co) => {
    const res = await chatCompletion(cfg, messages, {
      tools: tools.length ? tools : undefined,
      json: !!co.json,
      maxTokens: 4000,
      onUsage,
    });
    return { content: res.content, toolCalls: res.toolCalls };
  };

  // 每段文本预算打八折，给系统提示 + 已收录卡片摘要 + 工具往返留出上下文余量
  const chunks = splitNovelForAgent(novelText, Math.max(100, Math.floor(inputCharBudget(cfg) * 0.8)));
  const system = scanSystemPrompt(opts.feedback);
  const state: ExtractAgentState = { characters: new Map(), scenes: new Map(), items: new Map() };

  const scanAll = async (toolCalls: boolean): Promise<void> => {
    for (let i = 0; i < chunks.length; i++) {
      if (isAborted()) throw new Error("已中止");
      logFn?.(`扫描第 ${i + 1}/${chunks.length} 段（${toolCalls ? "工具" : "文本"}协议）…`);
      const user = `小说标题：${title}\n\n这是第 ${i + 1}/${chunks.length} 段小说文本：\n${chunks[i]}\n\n当前已收录卡片（JSON）：\n${stateSummary(state)}`;
      const finished = await runScanChunk(chat, system, user, state, { toolCalls, isAborted });
      if (!finished) logFn?.(`第 ${i + 1}/${chunks.length} 段扫描到达轮数上限，已按已收集结果继续`, "warn");
    }
  };

  try {
    await scanAll(true);
  } catch (e) {
    if (!isToolUnsupportedError(e)) throw e;
    logger.warn("extractAgent", "模型不支持 function calling，切换文本动作协议重跑", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    logFn?.("当前模型/接口不支持 function calling，已自动切换为文本动作协议重跑…", "warn");
    state.characters.clear();
    state.scenes.clear();
    state.items.clear();
    await scanAll(false);
  }

  logFn?.(`扫描完成：${state.characters.size} 角色 / ${state.scenes.size} 场景 / ${state.items.size} 物品，正在合并去重…`);
  mergeCandidates(state);
  logFn?.(`合并完成：${state.characters.size} 角色 / ${state.scenes.size} 场景 / ${state.items.size} 物品，正在补全详细设定…`);
  await enrichCards(cfg, state, title, lib, onUsage, opts.feedback);
  const result = finalizeState(state, lib, title);
  logFn?.(`Agent 提取完成：${result.characters.length} 角色 / ${result.scenes.length} 场景 / ${result.items.length} 物品`, "success");
  return result;
}
