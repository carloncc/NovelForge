/** 稳定短哈希（非加密，用于 id/文件名去碰撞） */
export function stableHash(text: string): string {
  let h = 2166136261;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

/**
 * 归一化实体 id：
 * - 纯 ASCII 标识直接清洗小写化（保持可读、兼容旧数据）；
 * - 含非 ASCII 字符（中文名等）时，旧实现 `[^a-z0-9_-] → _` 会把「林澈/苏晚」都变成 `__` 互相碰撞
 *   （后一个角色被判为已存在而合并、图片文件名互相覆盖），改为「前缀 + 稳定哈希」。
 * 同一输入始终得到同一 id，跨运行稳定。
 */
export function normalizeEntityId(raw: unknown, prefix: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  // 含非 ASCII（中文名等）：旧清洗会把「林澈/苏晚」都变成 `__` 互相碰撞（合并串人物、文件互相覆盖），
  // 直接生成「前缀 + 稳定哈希」，同一输入跨运行稳定且不同名字不碰撞
  if (/[^\x00-\x7F]/.test(text)) return `${prefix}_${stableHash(text)}`;
  const cleaned = text.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return /[a-z0-9]/.test(cleaned) ? cleaned : `${prefix}_${stableHash(text)}`;
}
