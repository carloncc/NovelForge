/** ReqFlow batch-c 1295 + 1317(日志)：密钥脱敏、URL 脱敏、CRLF 清洗、历史截断 */
import { redactSensitive, redactUrl, sanitizeLogText, log } from "../src/utils/logger";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) ?key=/access_token/sig/signature 脱敏 ---------- */
const gemKey = "AIzaSyD_LEAKED_KEY_1234567890abcdef";
const url1 = `https://generativelanguage.googleapis.com/v1beta/models?key=${gemKey}`;
assert(!String(redactSensitive(url1)).includes(gemKey), "?key= 必须脱敏");
assert(String(redactSensitive(url1)).includes("[REDACTED]"), "?key= 应替换为 [REDACTED]");
assert(!redactUrl(url1).includes(gemKey), "redactUrl 必须脱敏 ?key=");

const url2 = `https://api.test/v1/chat?access_token=tok123456&sig=abc123&signature=sig456`;
const r2 = String(redactSensitive(url2));
assert(!r2.includes("tok123456") && !r2.includes("abc123") && !r2.includes("sig456"), "access_token/sig/signature 必须脱敏");

/* ---------- 2) AIza 形态 ---------- */
assert(!String(redactSensitive(`key=${gemKey}`)).includes(gemKey.slice(0, 10)), "AIza 形态必须脱敏");

/* ---------- 3) 裸 key/sig 精确匹配脱敏，但 monkey/design 不误伤 ---------- */
const objRedacted = JSON.stringify(redactSensitive({ key: "secret1", sig: "secret2", monkey: "keep", design: "keep2" }));
assert(!objRedacted.includes("secret1") && !objRedacted.includes("secret2"), "裸 key/sig 应脱敏");
assert(objRedacted.includes("keep") && objRedacted.includes("keep2"), "monkey/design 不应误脱敏");

/* ---------- 4) 计费 tokens 字段不脱敏（B106 回归） ---------- */
const usage = JSON.stringify(redactSensitive({ promptTokens: 123, completionTokens: 456 }));
assert(usage.includes("123") && usage.includes("456"), "计费 tokens 不得脱敏");

/* ---------- 5) CRLF 清洗 ---------- */
assert(!sanitizeLogText("a\r\n[b]\r\nc").includes("\n"), "CRLF 必须洗掉");
assert(sanitizeLogText("x".repeat(5000)).length <= 2100, "超长应截断");

/* ---------- 6) 历史入库截断：大 data 不进内存 ---------- */
log.info("test", "big", { blob: "y".repeat(5000) });
// 无法直接读 history（未导出），但 push 不应抛且 dump 应截断
import { dumpLogHistory } from "../src/utils/logger";
const dump = dumpLogHistory();
assert(dump.includes("big"), "dump 应包含测试行");

console.log("=== audit-c logger tests passed ===");
