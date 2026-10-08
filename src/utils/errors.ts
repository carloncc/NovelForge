/**
 * 统一的错误处理和用户友好的错误提示
 */

class NovelForgeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NovelForgeError";
  }
}

/** 从任意异常取值（Tauri invoke 常以纯字符串 reject，Error.message 会取到 undefined） */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || "未知错误";
  if (e === null || e === undefined) return "未知错误";
  try {
    const json = JSON.stringify(e);
    // #1531：函数 / Symbol 的 JSON.stringify 返回的是 undefined 值（不是字符串）。
    // 直接 return 会让调用方把字面量 "undefined" 拼进用户可见的错误文案。
    return typeof json === "string" ? json : String(e);
  } catch {
    return String(e);
  }
}

/**
 * 错误类型枚举（仅保留实际使用的成员；此前的 16 个枚举里 15 个从未被抛出过）
 */
export enum ErrorCode {
  // 模板错误
  TEMPLATE_NOT_FOUND = "TEMPLATE_NOT_FOUND",
}

/**
 * 用户友好的错误消息映射
 */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.TEMPLATE_NOT_FOUND]: "未找到 WebGAL 引擎模板",
};

/**
 * 创建用户友好的错误对象
 */
export function createError(
  code: ErrorCode,
  details?: Record<string, unknown>,
  customMessage?: string
): NovelForgeError {
  const message = customMessage || ERROR_MESSAGES[code];
  return new NovelForgeError(message, code, details);
}

/**
 * 安全执行异步操作，捕获并格式化错误
 */
export async function safeAsync<T>(
  operation: () => Promise<T>,
  errorCode: ErrorCode,
  context?: Record<string, unknown>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NovelForgeError) {
      throw error;
    }
    throw createError(errorCode, {
      ...context,
      originalError: error instanceof Error ? error.message : String(error),
    });
  }
}
