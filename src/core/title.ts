/**
 * 作品标题解析：小说文件名常是「175812 gbk」「未命名」这类无意义串，
 * 不能再把它当作品名（用户实测：游戏标题/菜单/PWA 都显示成了文件名）。
 * 优先级：导出标题 → 卡片标题（过滤垃圾串）→ 输出目录名 → 文件名兜底。
 */

/** 文件名式垃圾标题：纯数字/编号、编码标记、临时副本等 */
export function isJunkTitle(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t) return true;
  if (/^[\d\s._\-()（）[\]【】]+$/.test(t)) return true;
  if (/(^|[^a-z])(gbk|utf-?8|ansi|cp936|big5|copy|final|tmp|untitled)([^a-z]|$)/i.test(t)) return true;
  return false;
}

function baseName(path: string): string {
  const trimmed = (path ?? "").replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").trim();
}

function fileStem(fileName: string): string {
  return (fileName ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").trim();
}

export function resolveProjectTitle(args: {
  exportTitle?: string;
  cardsTitle?: string;
  outputDir?: string;
  fileName?: string;
}): string {
  const candidates = [args.exportTitle, args.cardsTitle, baseName(args.outputDir ?? ""), fileStem(args.fileName ?? "")];
  for (const candidate of candidates) {
    const t = (candidate ?? "").trim();
    if (t && !isJunkTitle(t)) return t;
  }
  return (args.cardsTitle || fileStem(args.fileName ?? "") || "未命名作品").trim();
}
