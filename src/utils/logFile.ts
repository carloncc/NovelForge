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
  const lines = buffer.splice(0, buffer.length);
  if (!lines.length || !logFilePath) return;
  const filePath = logFilePath;
  writeQueue = writeQueue.then(async () => {
    try {
      let existing = "";
      if (await tauri.pathExists(filePath)) {
        const result = await tauri.readTextFile(filePath);
        existing = result.text;
      }
      const merged = existing ? `${existing}\n${lines.join("\n")}` : lines.join("\n");
      const trimmed = merged.split("\n").slice(-LOG_LINE_LIMIT).join("\n");
      await tauri.writeTextFile(filePath, trimmed);
    } catch (error) {
      // 日志写入失败不应打断主流程
      console.error("[logFile] 写入日志文件失败", error);
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
    if (await tauri.pathExists(logFilePath)) {
      const existing = (await tauri.readTextFile(logFilePath)).text;
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

/** 读取当前日志文件内容 */
export async function readLogFile(): Promise<string> {
  if (!logFilePath) return "";
  try {
    const result = await tauri.readTextFile(logFilePath);
    return result.text;
  } catch {
    return "";
  }
}

export function getLogFilePath(): string {
  return logFilePath;
}
