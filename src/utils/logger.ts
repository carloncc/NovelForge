/**
 * 统一日志工具：结构化、分级、带时间戳。
 * - 开发环境（import.meta.env.DEV）下输出到 console
 * - 所有环境都会记录到内存历史缓冲（getLogHistory / dumpLogHistory），便于 UI 或调试导出
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const HISTORY_LIMIT = 5000;
const history: LogEntry[] = [];

const DEV =
  typeof import.meta !== "undefined" &&
  !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

/** 截断长字符串/数组，避免日志被 base64 等长内容刷屏 */
export function truncate(value: unknown, maxLen = 200): unknown {
  if (typeof value === "string") {
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}…(+${value.length - maxLen}字符)`;
  }
  if (Array.isArray(value)) {
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncate(v, maxLen);
    }
    return out;
  }
  return value;
}

function stringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function push(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = { at: Date.now(), level, scope, message, data };
  if (history.length >= HISTORY_LIMIT) history.shift();
  history.push(entry);

  if (!DEV) return;
  const time = new Date(entry.at).toISOString();
  const suffix = data === undefined ? "" : ` ${stringify(truncate(data))}`;
  const line = `[NovelForge][${time}][${level.toUpperCase()}][${scope}] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug(scope: string, message: string, data?: unknown): void {
    push("debug", scope, message, data);
  },
  info(scope: string, message: string, data?: unknown): void {
    push("info", scope, message, data);
  },
  warn(scope: string, message: string, data?: unknown): void {
    push("warn", scope, message, data);
  },
  error(scope: string, message: string, data?: unknown): void {
    push("error", scope, message, data);
  },
  /** 计时辅助：返回一个函数，调用它传入结果即输出耗时日志 */
  time(scope: string, message: string): (result?: string) => void {
    const start = performance.now();
    return (result?: string) => {
      const ms = (performance.now() - start).toFixed(1);
      push("debug", scope, `${message}（耗时 ${ms}ms）${result ? "→ " + result : ""}`);
    };
  },
};

export function getLogHistory(): readonly LogEntry[] {
  return history;
}

export function clearLogHistory(): void {
  history.length = 0;
}

/** 导出内存日志为纯文本（供调试/复制） */
export function dumpLogHistory(): string {
  return history
    .map((e) => {
      const time = new Date(e.at).toISOString();
      const suffix = e.data === undefined ? "" : " " + stringify(truncate(e.data));
      return `[${time}][${e.level.toUpperCase()}][${e.scope}] ${e.message}${suffix}`;
    })
    .join("\n");
}

/** 记录一段异步操作：进入时打 debug，成功/失败分别打日志 */
export async function traced<T>(
  scope: string,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const done = log.time(scope, message);
  log.debug(scope, `开始：${message}`);
  try {
    const result = await fn();
    done("成功");
    return result;
  } catch (e) {
    done(`失败：${e instanceof Error ? e.message : String(e)}`);
    log.error(scope, `${message} 失败`, { error: e instanceof Error ? e.message : e });
    throw e;
  }
}
