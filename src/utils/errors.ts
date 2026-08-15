/**
 * 统一的错误处理和用户友好的错误提示
 */

export class NovelForgeError extends Error {
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
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 错误类型枚举
 */
export enum ErrorCode {
  // 文件系统错误
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  FILE_READ_ERROR = "FILE_READ_ERROR",
  FILE_WRITE_ERROR = "FILE_WRITE_ERROR",
  DIRECTORY_NOT_FOUND = "DIRECTORY_NOT_FOUND",
  
  // 路径错误
  INVALID_PATH = "INVALID_PATH",
  PATH_PERMISSION_DENIED = "PATH_PERMISSION_DENIED",
  
  // 模板错误
  TEMPLATE_NOT_FOUND = "TEMPLATE_NOT_FOUND",
  TEMPLATE_INVALID = "TEMPLATE_INVALID",
  
  // API 错误
  API_REQUEST_FAILED = "API_REQUEST_FAILED",
  API_TIMEOUT = "API_TIMEOUT",
  API_INVALID_RESPONSE = "API_INVALID_RESPONSE",
  
  // 项目错误
  PROJECT_INVALID = "PROJECT_INVALID",
  PROJECT_GENERATION_FAILED = "PROJECT_GENERATION_FAILED",
  
  // 导出错误
  EXPORT_FAILED = "EXPORT_FAILED",
  ZIP_CREATION_FAILED = "ZIP_CREATION_FAILED",
  
  // 通用错误
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * 用户友好的错误消息映射
 */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.FILE_NOT_FOUND]: "文件未找到",
  [ErrorCode.FILE_READ_ERROR]: "读取文件失败",
  [ErrorCode.FILE_WRITE_ERROR]: "写入文件失败",
  [ErrorCode.DIRECTORY_NOT_FOUND]: "目录不存在",
  [ErrorCode.INVALID_PATH]: "路径格式无效",
  [ErrorCode.PATH_PERMISSION_DENIED]: "无权限访问该路径",
  [ErrorCode.TEMPLATE_NOT_FOUND]: "未找到 WebGAL 引擎模板",
  [ErrorCode.TEMPLATE_INVALID]: "模板文件损坏或不完整",
  [ErrorCode.API_REQUEST_FAILED]: "API 请求失败",
  [ErrorCode.API_TIMEOUT]: "API 请求超时",
  [ErrorCode.API_INVALID_RESPONSE]: "API 返回数据格式错误",
  [ErrorCode.PROJECT_INVALID]: "项目文件无效",
  [ErrorCode.PROJECT_GENERATION_FAILED]: "项目生成失败",
  [ErrorCode.EXPORT_FAILED]: "导出失败",
  [ErrorCode.ZIP_CREATION_FAILED]: "压缩包创建失败",
  [ErrorCode.UNKNOWN_ERROR]: "未知错误",
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
