/**
 * 卡片编辑器的「同步判定」纯函数（从 EditCards.vue 抽出，2026-10-14）。
 *
 * 为什么要独立成模块：这些函数原先写在 `<script setup>` 里并被 `export` —— 而
 * **`<script setup>` 不允许 ES module 导出**（`@vue/compiler-sfc` 直接报
 * "<script setup> cannot contain ES module exports"），dev server 与 `vite build` 都会挂；
 * 更糟的是 `vue-tsc --noEmit` 与单测**都不编译 .vue**，所以这个错误在测试全绿的情况下
 * 一路溜到了开发者的屏幕上（见看板卡「门禁缺 SFC 编译」）。
 *
 * 抽成 .ts 后：组件 import 它、单测也 import 它 —— 测试测的是**真实实现**，
 * 不再是"同名镜像副本"（镜像会随组件漂移，而漂移本身没有任何门禁能发现）。
 *
 * 两件事必须一起看，它们互为前提：
 *
 * 1) 深拷贝改浅拷贝：旧实现 `JSON.parse(JSON.stringify(props.cards))` 是**真实的数据复制**，
 *    而卡片里的 referenceImage 是内联 base64（单张可达数 MB），于是同一份 base64 在
 *    projectState.lastResult.cards（reactive）与 local（reactive）各存一份，面板打开期间
 *    常驻内存翻倍。
 *
 * 2) 整份 JSON.stringify 比对改「字段级签名」：旧实现每次 watch 触发都要对两份完整卡片
 *    （含全部 base64）做 stringify，输入时每次按键都跑一遍，主线程明显卡顿。
 *
 * 签名里对 referenceImage 只取长度、绝不取内容：既能发现"参考图被换/被清"这类真实外部变更，
 * 又不会把几 MB 的 base64 拉进字符串比较。
 */
import type { ExtractionResult } from "../core/types";

export type CardSignatureInput = Record<string, unknown>;

/** 数组字段逐项浅拷贝（元素仍是共享引用）：用户增删服装/动作后 props 也能看到，
 *  与旧实现"保存后 emit(local.value)"的语义一致，但不再复制元素内部的大字段。 */
function copyArrayField<T>(value: T[] | undefined): T[] | undefined {
  return value ? [...value] : value;
}

/** 浅拷贝卡片：只复制顶层与数组容器，对象元素共享引用（避免 base64 被整份复制） */
export function shallowCopyCards(cards: ExtractionResult): ExtractionResult {
  // 元素只做一层展开：cards.items/scenes/characters 的元素内部可能带内联 base64
  // （referenceImage），深拷贝会把几 MB 的字符串整份复制进第二个 reactive ref。
  const copyList = <T extends object>(list: T[]): T[] => list.map((entry) => ({ ...entry }));
  const characters = (cards.characters ?? []).map((c) => ({
    ...c,
    // 这几个是唯一会被本面板增删的数组字段：容器必须换新数组，否则「添加服装」会
    // 就地改到 props.cards 上（用户点「放弃修改」也回不去）
    costumes: copyArrayField(c.costumes),
    actions: copyArrayField(c.actions),
    emotions: copyArrayField(c.emotions),
  }));
  return {
    ...cards,
    characters,
    items: copyList(cards.items ?? []),
    scenes: copyList(cards.scenes ?? []),
    lore: cards.lore ? copyList(cards.lore) : cards.lore,
  };
}

/** 参考图签名：只记长度，内容（base64）绝不进签名——否则等于把整份 base64 拉进比较 */
function refImageSignature(card: CardSignatureInput): string {
  const value = card.referenceImage;
  return typeof value === "string" ? `b64:${value.length}` : "none";
}

/**
 * 字段级签名：只保留"卡片编辑器能改的字段 + 参考图长度"，其余字段（含任何内联二进制）
 * 一律不参与。用途是判断「外部数据是否真的变了」，而不是"两份对象是否全等"——
 * 后者会把 base64 一起 stringify（F10），也会因为无关字段变化误报冲突。
 */
export function cardSignature(card: CardSignatureInput): string {
  const parts: string[] = [refImageSignature(card)];
  const keys = Object.keys(card)
    .filter((k) => k !== "referenceImage")
    .sort();
  for (const key of keys) {
    const value = card[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    } else if (value === undefined || value === null) {
      parts.push(`${key}=`);
    } else {
      // 结构化字段（服装/动作/情绪等）：只取浅层标量，避免把内联 base64 卷进来
      parts.push(`${key}=${shallowScalarJson(value)}`);
    }
  }
  return parts.join("\u0001");
}

/** 结构化值的浅层序列化：最多下钻 2 层，字符串超过 512 字符只记长度（内联 base64 的兜底） */
function shallowScalarJson(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > 512 ? `#len:${value.length}` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 2) return "#obj";
  if (Array.isArray(value)) return `[${value.map((v) => shallowScalarJson(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${k}:${shallowScalarJson((value as Record<string, unknown>)[k], depth + 1)}`)
      .join(",")}}`;
  }
  return String(value);
}

/** 整份卡片的签名：数量 + 每个元素逐项签名（顺序敏感：重排也算外部变更） */
export function cardsSignature(cards: ExtractionResult): string {
  const list = (name: string, arr: unknown[] | undefined): string =>
    `${name}[${(arr ?? []).map((entry) => cardSignature(entry as CardSignatureInput)).join("|")}]`;
  return [
    list("characters", cards.characters),
    list("items", cards.items),
    list("scenes", cards.scenes),
    list("lore", cards.lore),
  ].join("\n");
}

/**
 * 父组件回写卡片时的同步决策（F1 的核心判定，抽成纯函数以便单测）。
 *
 * 判据是**本地是否有未保存编辑**，而不是"外部数据是否变了"：
 *   - 本地与基线一致（localSig === lastSyncedSig）→ 没有未保存编辑 → "sync"：
 *     直接用外部数据刷新本地副本（重新生成后的正常同步、以及保存后父组件的等价回写）。
 *   - 本地与基线不一致 → 用户改过还没保存 → "conflict"：**保留本地编辑**，只更新基线并提示。
 *     这是必须保留的原有行为（不能拿重新生成的结果覆盖用户正在编辑的内容）。
 *
 * 为什么不能反过来用"props 与基线比"：保存成功后基线已对齐到刚保存的内容，
 * 此时重新生成出的**不同**结果会被误判为"无变化"而静默覆盖用户刚保存的编辑。
 * 而"保存成功后必然弹红色假警告"（F1）之所以消失，是因为 save() 里 markSynced()
 * 先把基线对齐到刚保存的内容——父组件的等价回写于是判定为"没有未保存编辑"。
 */
export function cardsSyncDecision(
  propsCards: ExtractionResult,
  localCards: ExtractionResult,
  lastSyncedSig: string,
): { action: "sync"; sig: string } | { action: "conflict"; sig: string } {
  const sig = cardsSignature(propsCards);
  return { action: cardsSignature(localCards) === lastSyncedSig ? "sync" : "conflict", sig };
}
