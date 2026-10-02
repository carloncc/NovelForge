import { redactSensitive, setLogFileSink, type LogEntry } from "./logger";
import { tauri } from "./tauri";

/**
 * 把内存日志落盘到 <appConfigDir>/logs/novelforge.log，
 * 便于在用户机器上直接读取日志诊断问题（图片识别/生成/语音报错等）。
 * - 桌面版写入真实文件系统；Web 版写入 IndexedDB 虚拟文件系统。
 * - 批量防抖写入，文件只保留最近 LOG_LINE_LIMIT 行，避免无限增长。
 */

const LOG_LINE_LIMIT = 5000;
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH = 50;

let logFilePath = "";
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
/** 自上次「行数校验」以来已追加的行数（估算用；到达窗口才真正读一次磁盘核对） */
let appendedSinceCheck = 0;
/** 累积多少行后重新核对一次真实行数（决定是否会超过 LOG_LINE_LIMIT 并截断） */
const COMPACT_CHECK_EVERY = 200;
/** 日志文件当前是否已有内容（决定追加时要不要先补一个换行分隔符） */
let fileHasContent = false;

/**
 * 构造追加负载（#1502）：与旧的「读现有内容 → existing + "\n" + chunk」逐字一致。
 * 文件为空/不存在时不加前导换行；结尾一律不补换行（旧实现在文件末尾不留空行）。
 * 抽成纯函数是为了能被单测直接锁住——分隔符差一个字符就会让日志出现空行或行粘连。
 */
export function composeAppendPayload(hasExistingContent: boolean, chunk: string): string {
  if (!chunk) return "";
  return hasExistingContent ? `\n${chunk}` : chunk;
}

function format(entry: LogEntry): string {
  const time = new Date(entry.at).toISOString();
  let data = "";
  if (entry.data !== undefined) {
    try {
      data = " " + JSON.stringify(redactSensitive(entry.data)).slice(0, 800);
    } catch {
      data = " " + String(entry.data).slice(0, 800);
    }
  }
  return `[${time}][${entry.level.toUpperCase()}][${entry.scope}] ${entry.message}${data}`;
}

async function flush(): Promise<void> {
  if (!logFilePath) return;
  const lines = buffer.splice(0, buffer.length);
  if (!lines.length) return;
  const filePath = logFilePath;
  writeQueue = writeQueue.then(async () => {
    try {
      // #1502：直接追加。旧实现每次 flush 都要「读全量 + 拼 + 写全量」——日志越大越慢，
      // 且每次把整份内容在内存里复制一遍。现在只有「可能超过行数上限」时才做一次
      // 读全量 + 截断重写，其余情况成本与新增行数成正比。
      //
      // 计数维护：没必要每次 flush 都去数磁盘上的行数（那本身就是一次全量读）。
      // 用 memo 记录「上次已知行数」，够准时（还差一个窗口）才真正校验一次；失败/异常时
      // 把 memo 置为「未知」，下次强制复核。
      const appendedLines = appendedSinceCheck + lines.length;
      const needsCompaction = appendedLines >= COMPACT_CHECK_EVERY;
      if (!needsCompaction) {
        await tauri.appendTextFile(filePath, composeAppendPayload(fileHasContent, lines.join("\n")));
        fileHasContent = true;
        appendedSinceCheck += lines.length;
      } else {
        // 到达校验窗口：读一次，超过上限就整体截断
        let existing = "";
        if (await tauri.pathExists(filePath)) {
          existing = (await tauri.readTextFile(filePath)).text;
        }
        const merged = existing ? `${existing}\n${lines.join("\n")}` : lines.join("\n");
        const projectedLines = existing ? existing.split("\n").length + lines.length : lines.length;
        const next = projectedLines > LOG_LINE_LIMIT ? merged.split("\n").slice(-LOG_LINE_LIMIT).join("\n") : merged;
        await tauri.writeTextFile(filePath, next);
        appendedSinceCheck = 0;
        fileHasContent = next.length > 0;
      }
    } catch (error) {
      // B99：写失败不能丢行——放回 buffer 头部（保持时间顺序），下次 flush 重试。
      // 旧实现直接丢弃，磁盘日志会静默缺一段，恰好掩盖故障现场。
      buffer.unshift(...lines);
      // 若磁盘持续不可写，缓冲也不能无限增长占内存：封顶到与文件一致的行数，只保留最近的行
      if (buffer.length > LOG_LINE_LIMIT) buffer.splice(0, buffer.length - LOG_LINE_LIMIT);
      console.error("[logFile] 写入日志文件失败（日志行已放回缓冲，稍后重试）", error);
    }
  });
  await writeQueue;
}

/** 注册日志落盘，返回日志文件路径；失败时返回空串 */
export async function installLogFileSink(): Promise<string> {
  try {
    const configDir = (await tauri.appConfigDir()).replace(/\/+$/, "");
    const logsDir = `${configDir}/logs`;
    await tauri.mkdirAll(logsDir);
    logFilePath = `${logsDir}/novelforge.log`;
    // 初始化时记录文件是否已有内容，后续追加据此决定是否补换行分隔符
    if (await tauri.pathExists(logFilePath)) {
      const existing = (await tauri.readTextFile(logFilePath)).text;
      fileHasContent = existing.length > 0;
      const redacted = redactSensitive(existing) as string;
      if (redacted !== existing) await tauri.writeTextFile(logFilePath, redacted);
    }
    setLogFileSink((entry) => {
      // debug 过于嘈杂（每个文件读写都打一条），落盘只保留 info/warn/error，便于阅读
      if (entry.level === "debug") return;
      buffer.push(format(entry));
      if (buffer.length >= FLUSH_BATCH) {
        void flush();
      } else if (flushTimer === undefined) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, FLUSH_INTERVAL_MS);
      }
    });
    return logFilePath;
  } catch (error) {
    console.error("[logFile] 初始化日志文件失败", error);
    return "";
  }
}
