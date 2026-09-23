/**
 * 统一日志工具：结构化、分级、带时间戳。
 * - 开发环境（import.meta.env.DEV）下输出到 console
 * - 所有环境都会记录到内存历史缓冲（dumpLogHistory），便于 UI 或调试导出
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
const SENSITIVE_KEY = /api[_-]?key|authorization|token|secret|password|access_token|signature/i;
/** B106：计费/用量字段（promptTokens / completionTokens / maxTokens / *_tokens 等）以 tokens 结尾，
 * 但不是凭据。旧实现见 key 含 token 就整键脱敏，把计费数字写成 [REDACTED]，成本与用量日志失真。 */
const USAGE_TOKEN_KEY = /tokens$/i;
/** 裸 `key` / `sig` 只在精确匹配时视为凭据（1295：Gemini `?key=` 风格）。
 * 不能进 SENSITIVE_KEY 子串匹配，否则 `monkey`/`design`/`keyboard` 等正常字段会被误脱敏。 */
const SENSITIVE_EXACT_KEY = /^(key|sig)$/i;
const REDACTED = "[REDACTED]";
/** 内存历史入库截断（1317）：history 5000 条此前存全量 data，大 data 可达数百 MB。
 * 入库即截断，文件 sink 的 800 截断保持不变。 */
const HISTORY_DATA_LIMIT = 800;
/** 单条日志文本上限（1317）：message/scope 洗换行后截断，防止 CRLF 伪造行刷屏。 */
const LOG_TEXT_LIMIT = 2000;

function isSensitiveKey(key: string): boolean {
  if (USAGE_TOKEN_KEY.test(key)) return false;
  return SENSITIVE_KEY.test(key) || SENSITIVE_EXACT_KEY.test(key.trim());
}

/** URL 脱敏（1295）：`?key=`/`access_token`/`sig`/`signature` 等查询参数值一律脱敏。
 * 日志侧 URL 统一经此函数再入库，不只靠字段名。 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:api[_-]?key|authorization|token|secret|password|access_token|sig|signature|key)=)[^&\s"']+/gi, `$1${REDACTED}`);
}

/** 日志文本清洗（1317）：洗掉 CRLF（防伪造行）并限长。 */
export function sanitizeLogText(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  return flat.length > LOG_TEXT_LIMIT ? `${flat.slice(0, LOG_TEXT_LIMIT)}…` : flat;
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
      try {
        return JSON.stringify(redactSensitive(JSON.parse(value)));
      } catch {
        // Not JSON; apply token-pattern redaction below.
      }
    }
    return redactUrl(value)
      .replace(/("(?:api[_-]?key|authorization|token|secret|password|access_token|sig|signature|key)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`)
      .replace(/Bearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
      .replace(/\bsk-[A-Za-z0-9._-]{6,}/g, REDACTED)
      .replace(/\bAIza[0-9A-Za-z._-]{20,}/g, REDACTED);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 凭据键脱敏；*Tokens 计费字段例外（B106）；裸 key/sig 精确匹配才脱敏（1295）
      out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(item, seen);
    }
    return out;
  }
  return value;
}

/** 可插拔的日志文件写入器（由应用启动时注册，写入磁盘，便于离线诊断） */
export type LogFileSink = (entry: LogEntry) => void;
let logFileSink: LogFileSink | null = null;

export function setLogFileSink(sink: LogFileSink | null): void {
  logFileSink = sink;
}

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
  // 1295/1317：scope/message 先做 URL 脱敏 + CRLF 清洗再入库；data 脱敏后立即截断（防大 data 撑爆内存）
  const cleanScope = sanitizeLogText(String(redactSensitive(scope)));
  const cleanMessage = sanitizeLogText(String(redactSensitive(message)));
  const entry: LogEntry = {
    at: Date.now(),
    level,
    scope: cleanScope,
    message: cleanMessage,
    data: data === undefined ? undefined : (truncate(redactSensitive(data), HISTORY_DATA_LIMIT) as unknown),
  };
  if (history.length >= HISTORY_LIMIT) history.shift();
  history.push(entry);
  logFileSink?.(entry);

  if (!DEV) return;
  const time = new Date(entry.at).toISOString();
  const suffix = entry.data === undefined ? "" : ` ${stringify(truncate(entry.data))}`;
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
