/**
 * 错误分类器：把任意 API 错误消息分类到 7 类，驱动不同的重试/提示词改写策略。
 * 与重试逻辑解耦，便于单测。
 */

type ErrorClass =
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
    // 中文内容政策回执（如 OpenAI/Gemini 中文翻译“可能违反了我们的内容政策…判断有误…重试或修改提示语”）
    /内容政策|内容准则|内容规范|内容安全策略|安全准则|社区准则/i,
    /违反(了)?(我们|我方|平台)?(的)?(内容|安全|审核|发布|服务|社区)?(政策|准则|规范|规则|规定)/i,
    // #1554：中文「不合规 / 安全策略」此前漏判 → 落 unknown 后既不会触发提示词改写，
    // 还会白跑 4 次退避重试；对内容审查这一类，「分类错」等于丢掉唯一的过审补救手段。
    /不合规|不符合.{0,6}(安全|规范|政策)|安全策略|被(拒绝|拦截|屏蔽)/i,
    /content[_-]?policy[_-]?violation/i,
    /判断有误|重试或修改(提示|提示语|提示词|prompt)/i,
  ],
  rate_limit: [
    /\b429\b/i,
    /too many requests/i,
    /rate.?limit/i,
    /quota/i,
    // 旧实现用 /exceed/i 兜底：任何 "exceed"（如 "prompt exceeds maximum length"）都被当限流无限退避重试。
    // 这里只保留「超出配额/余额/频率」的明确组合，超长/超限类永久错误交给 invalid_param 命中。
    /exceed(?:ed|s|ing)?.{0,30}(quota|rate|balance|credits?|requests? per|tokens? per|frequency|频率|限额)/i,
    /(quota|balance|credits?|rate limit|usage limit|额度|请求过于频繁|访问频繁|频率限制|限额).{0,30}(exceed|exhaust|depleted|reached|不足|超|用尽|耗尽)/i,
    /tokens? per min/i,
    /insufficient.{0,10}(balance|quota)/i,
    // #1554：billing_hard_limit_reached 是「额度用尽」，属配额类而非参数类——放在 invalid_param 会给出错的提示。
    /billing[_-]?hard[_-]?limit[_-]?reached/i,
    /余额不足|额度不足|配额|限流|触发限制|并发超限|请求过于频繁|访问过于频繁|频率超限/i,
  ],
  auth: [
    /\b401\b|\b403\b/i,
    /invalid api ?key/i,
    /unauthorized/i,
    /auth(entication)? (failed|error)/i,
    /api ?key.*(invalid|wrong|incorrect|missing)/i,
    /permission denied/i,
    /鉴权|密钥.*(无效|错误|非法)|api ?key.*(无效|错误|非法)/i,
    // #1554：中文线路常用「令牌/密钥 已过期 · 无权访问 · 未授权」；snake_case 形态
    // （api_key_invalid / authentication_error / permission_denied）此前也不匹配。
    // 漏判会落 unknown → 被当临时错误退避重试 4 次，而鉴权失败重试多少次都不会成功。
    /令牌.{0,6}(过期|失效|无效|错误|非法)|密钥.{0,6}(过期|失效)|无权访问|未授权|没有权限|权限不足/i,
    /api[_-]?key[_-]?(invalid|invalidated|revoked|expired)/i,
    /auth(?:entication)?[_-]?(failed|error)|permission[_-]?denied/i,
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
    // #1553：厂商常回 snake_case 错误码（model_not_found / invalid_request_error），
    // 只认带空格的 "not found" 会漏掉前者 → 落 unknown → 按网络错误退避重试 4 次，
    // 而模型名写错是永久错误，等于对注定失败的请求反复计费。
    /not[_\s-]?found/i,
    /not found/i,
    /prompt (is )?(too|must)/i,
    // 「超长/超限」类永久错误（context window、输出上限等）：必须在配额判定之前被识别，
    // 否则会被旧版 /exceed/ 误判成限流反复退避重试。
    /exceed(?:ed|s|ing)?.{0,30}(max(?:imum)?|context|length|tokens?|size|images?|characters?)/i,
    /(max(?:imum)?|context|length|prompt).{0,30}(exceed|too long|too large|超过|超长)/i,
    /too (long|large)\b/i,
    /too many (images|characters|tokens|pixels)/i,
    /超过.{0,8}(上限|最大|长度|限制)|超长|过长/i,
    /参数错误|参数不合法|格式错误|不存在|不支持/i,
    // #1554：中文既有词表只写了「超过」，而线路多写「超出」；snake_case 的
    // invalid_request_error / not_found_error 也不匹配。这些属永久错误，误判成可重试＝对注定失败的请求反复计费。
    /超出.{0,8}(上限|限制|长度|最大|范围)|长度超出|模型名(无效|错误)|模型.{0,4}(不存在|无效)/i,
    /invalid[_-]?request[_-]?error|not[_-]?found[_-]?error/i,
    // 真实 OpenAI 上下文超限原文形如「This model's maximum context length is 8192 tokens. However, your messages resulted in …」，
    // 通篇没有 exceed / too long，既有词表抓不到，会落 unknown 白重试 4 次。
    /maximum context length|context length is|reduce the length of the messages/i,
    /错误[：:]\s*4\d\d/i,
    // 剧本「scenes 为空」＝模型输出被截断/JSON 修复失败：脚本层已带提示重试过一次，
    // 外层不再退避重跑整章（避免每个失败章节放大成 4 次整章付费调用）
    /未产出任何场景|scenes 为空|无 scenes/i,
    // universal.ts 的「结果数据不是合法 base64/hex」「图片数据缺少已知文件头」
    // 「结果对象中未找到图片/音频字段」都是**永久**错误（模型返回了文本而不是图片/音频），
    // universal.ts 的注释也写明「改为硬错，由上层按 invalid_param 不重试」。但词表里没有这些
    // 文案 → 落 unknown → 被当临时错误退避重试（images.ts 会重新发起付费出图），
    // 等于对注定失败的请求反复付费。归入 invalid_param 与上面的「未产出任何场景」同类。
    /结果数据不是合法|图片数据缺少已知文件头|结果对象中未找到/,
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
    /server[_\s-]?error/i,
    /unavailable/i,
    /overloaded/i,
    /\bbusy\b/i,
    /internal server error/i,
    /\b5\d\d\b/i,
    /请求失败|连接失败|网络错误/i,
    // #1555：DNS 解析失败也是网络层瞬时故障（此前落 unknown；同为可重试，补上是为给出对的提示）
    /no such host|name resolution|getaddrinfo|dns/i,
    // #1554：中文线路的服务端故障措辞（此前落 unknown；同为可重试，但分类正确才有正确的用户提示）。
    /服务器(内部)?错误|上游服务.{0,6}(不可用|异常)|网关超时|连接超时|无可用渠道|负载已饱和|暂时不可用|服务不可用/i,
  ],
  // #1557：补齐 aborted 措辞——web 运行时 fetch 中止抛的是「The user aborted a request.」，
  // 只认 cancelled（双 l）/已中止 会漏掉它。这是**唯一的**中止判定来源，各处都应引用这里。
  aborted: [/已中止|已取消|请求被取消/i, /\baborted\b/i, /\bcancel+ed\b/i],
};

/** 从任意异常分类（message + HTTP status 双信号） */
export function classifyError(e: unknown, status?: number): ErrorClass {
  if (status !== undefined) {
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status >= 500) return "network";
    // 408 Request Timeout / 425 Too Early 是「请求本身没问题、只是时机不对」，与 400
    // 参数错误语义相反：原实现落进下面的 >= 400 兜底被判 invalid_param 而零重试，
    // 用户白等一个完整超时周期才看到失败。scripts/web-model-downloader.mjs 的
    // RETRYABLE_STATUS 已把 408 列为可重试，两处口径此前不一致。
    if (status === 408 || status === 425) return "network";
    if (status >= 400) {
      // 4xx 默认参数错，但若有审查/限流信号则优先。
      // B94：部分服务把限流也回成 400（文本里带 "rate limit exceeded"），必须先查 rate_limit，
      // 否则会被当成 invalid_param 直接失败，失去退避重试机会。
      const text = String(e instanceof Error ? e.message : e);
      if (hasAny(text, PATTERNS.content_moderation)) return "content_moderation";
      if (hasAny(text, PATTERNS.rate_limit)) return "rate_limit";
      return "invalid_param";
    }
  }
  const text = String(e instanceof Error ? e.message : e);
  if (!text || text === "未知错误") return "unknown";
  const lower = text.toLowerCase();
  // #1553：与 B94 同一思路——报文里的显式状态码比关键词更硬。没有 status 时（pipeline.ts:118
  // 等调用点就是不传 status 的），一条 5xx 报文只要正文里带了 "not found"/"not supported"，
  // 就会因为 invalid_param 在 PATTERNS 里排在 network 之前而被判成「永久参数错误、零重试」。
  // 5xx 属于服务端临时故障，必须先判 network。
  // #1555：gRPC 的 DEADLINE_EXCEEDED（Google/Gemini 系列的标准超时错误）必须判 network。
  // 否则「context deadline exceeded」会先命中 invalid_param 的
  // `(max|context|length|prompt).{0,30}(exceed|…)`——把**超时**读成了**上下文超长**，
  // 判成永久错误、零重试，用户白等一场却拿不到本该重试就能成功的结果。
  if (/deadline.?exceeded/.test(lower)) {
    return "network";
  }
  if (/\b5\d\d\b/.test(lower) || /(internal server error|bad gateway|service unavailable|gateway timeout)/.test(lower)) {
    return "network";
  }
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
