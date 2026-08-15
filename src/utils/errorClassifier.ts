/**
 * 错误分类器：把任意 API 错误消息分类到 7 类，驱动不同的重试/提示词改写策略。
 * 与重试逻辑解耦，便于单测。
 */

export type ErrorClass =
  | "content_moderation" // 内容审查：自动改写提示词重试
  | "rate_limit" // 429/配额/限流：退避重试
  | "auth" // 鉴权/密钥：不重试
  | "invalid_param" // 参数/格式/资源不存在：不重试
  | "network" // 网络/5xx/服务端临时：退避重试
  | "aborted" // 用户中止
  | "unknown";

const PATTERNS: Record<Exclude<ErrorClass, "unknown">, RegExp[]> = {
  content_moderation: [
    /content.{0,20}(policy|filter|moderation|review|safety|sensitive|rejected)/i,
    /(refused|reject|block|deny).{0,40}(by|safety|policy|reviewer|moderation|filter|审核|审查|敏感)/i,
    /sensitive.{0,20}(word|content|term)/i,
    /\bsafety_filter\b/i,
    /\bcontent_blocked\b/i,
    /审核未通过|内容安全|敏感内容|违规内容|触发审核|屏蔽词|安全审查/i,
    /prompt.{0,10}(敏感|违规|unsafe|blocked)/i,
    // 常见图像审查错误的中文/英文表述（裸露/色情/情色/防护/未成年/成人内容等）
    /裸露|色情|情色|涩情|性化|未成年|成人内容|不当内容|防护限制|安全防护|violates? (our )?(safety|content|moderation)/i,
    /(explicit|sexual|adult|nude|nudity|pornographic).{0,30}(content|image|depiction|policy|not allowed)/i,
    /cannot (help|generate|produce).{0,30}(sexually|explicit|adult|sexualized)/i,
  ],
  rate_limit: [
    /\b429\b/i,
    /too many requests/i,
    /rate.?limit/i,
    /quota/i,
    /exceed/i,
    /insufficient.{0,10}(balance|quota)/i,
    /余额不足|额度不足|配额|限流|触发限制|并发超限/i,
  ],
  auth: [
    /\b401\b|\b403\b/i,
    /invalid api ?key/i,
    /unauthorized/i,
    /auth(entication)? (failed|error)/i,
    /api ?key.*(invalid|wrong|incorrect|missing)/i,
    /permission denied/i,
    /鉴权|密钥.*(无效|错误|非法)|api ?key.*(无效|错误|非法)/i,
  ],
  invalid_param: [
    /\b400\b|\b404\b/i,
    /invalid params?/i,
    /invalid[_\s-]?request/i,
    /bad request/i,
    /not supported/i,
    /unsupported/i,
    /missing required/i,
    /does not exist/i,
    /not found/i,
    /prompt (is )?(too|must)/i,
    /参数错误|参数不合法|格式错误|不存在|不支持/i,
    /错误[：:]\s*4\d\d/i,
  ],
  network: [
    /timeout|timed ?out/i,
    /network/i,
    /socket/i,
    /connect/i,
    /\beco?nn\b/i,
    /etimedout/i,
    /fetch failed/i,
    /econnrefused/i,
    /econnreset/i,
    /broken pipe/i,
    /server error/i,
    /unavailable/i,
    /overloaded/i,
    /\bbusy\b/i,
    /internal server error/i,
    /\b5\d\d\b/i,
    /请求失败|连接失败|网络错误/i,
  ],
  aborted: [/已中止/i, /\baborted\b/i, /\bcancelled\b/i, /\bcanceled\b/i],
};

/** 从任意异常分类（message + HTTP status 双信号） */
export function classifyError(e: unknown, status?: number): ErrorClass {
  if (status !== undefined) {
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status >= 500) return "network";
    if (status >= 400) {
      // 4xx 默认参数错，但若有审查/限流信号则优先
      const text = String(e instanceof Error ? e.message : e);
      if (hasAny(text, PATTERNS.content_moderation)) return "content_moderation";
      return "invalid_param";
    }
  }
  const text = String(e instanceof Error ? e.message : e);
  if (!text || text === "未知错误") return "unknown";
  const lower = text.toLowerCase();
  for (const cls of Object.keys(PATTERNS) as Exclude<ErrorClass, "unknown">[]) {
    if (hasAny(lower, PATTERNS[cls])) return cls;
  }
  return "unknown";
}

function hasAny(text: string, regs: RegExp[]): boolean {
  return regs.some((r) => r.test(text));
}

export const ERROR_CLASS_LABEL: Record<ErrorClass, string> = {
  content_moderation: "内容审查",
  rate_limit: "限流/配额",
  auth: "鉴权失败",
  invalid_param: "参数错误",
  network: "网络/服务端错误",
  aborted: "用户中止",
  unknown: "未知错误",
};

export const ERROR_CLASS_ICON: Record<ErrorClass, string> = {
  content_moderation: "🛡",
  rate_limit: "⏱",
  auth: "🔑",
  invalid_param: "⚙️",
  network: "🌐",
  aborted: "⏹",
  unknown: "❌",
};

/** 是否值得自动改写提示词后重试（仅内容审查） */
export function isPromptRewriteable(e: unknown, status?: number): boolean {
  return classifyError(e, status) === "content_moderation";
}

/** 是否应该退避重试（网络/限流） */
export function isBackoffRetryable(e: unknown, status?: number): boolean {
  const cls = classifyError(e, status);
  return cls === "network" || cls === "rate_limit";
}

/** 是否应该直接失败不重试（鉴权/参数/中止/未知中的硬错） */
export function isHardFailure(e: unknown, status?: number): boolean {
  const cls = classifyError(e, status);
  return cls === "auth" || cls === "invalid_param" || cls === "aborted";
}
