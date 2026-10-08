/**
 * #1533：日志脱敏的反向测试——不是「该脱敏的有没有脱」，而是「能不能让凭据漏出去」。
 *
 * 本轮用行为探针逐条试真实凭据形态，发现 redactUrl 只认 ? 和 & 两个分隔符，
 * 漏了 URL 片段的 #：`#key=SECRET` / `#access_token=SECRET` 原样进日志。
 *
 * 同时把「不该误伤的」也钉住：1295 修过的 ?monkey= / ?keyboard= 必须保持原样，
 * 否则脱敏器会把正常字段毁成 [REDACTED]。
 */
import { redactSensitive, redactUrl, sanitizeLogText } from "../src/utils/logger";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 断言给定的凭据字面量不会出现在输出里 */
function assertNoLeak(label: string, out: string, secrets: string[]): void {
  for (const secret of secrets)
    assert(!out.includes(secret), `【${label}】凭据 ${secret} 泄漏到日志：${out.slice(0, 140)}（#1533）`);
}

function main(): void {
  // ① URL 三个分隔符都必须覆盖（# 片段是本轮补上的）
  const URL_CASES: [string, string, string][] = [
    ["?key=", "https://a.com/v1?key=SECRET", "SECRET"],
    ["&key=", "https://a.com/v1?x=1&key=SECRET", "SECRET"],
    ["#key=", "https://a.com/v1#key=SECRET", "SECRET"],
    ["?access_token=", "https://a.com/v1?access_token=SECRET", "SECRET"],
    ["#access_token=", "https://a.com/v1#access_token=SECRET", "SECRET"],
    ["#token=", "https://a.com/v1#token=SECRET", "SECRET"],
    ["#sig=", "https://a.com/v1#sig=SECRET", "SECRET"],
    ["大写 KEY=", "https://a.com/v1?KEY=SECRET", "SECRET"],
  ];
  for (const [name, url, secret] of URL_CASES) {
    assertNoLeak("redactUrl " + name, redactUrl(url), [secret]);
    assertNoLeak("redactSensitive " + name, String(redactSensitive(url)), [secret]);
  }

  // ② 凭据形态：Bearer / sk- / AIza / JSON 字符串 / 各种键名
  const TEXT_CASES: [string, string, string[]][] = [
    ["Bearer", "Authorization: Bearer SECRET", ["SECRET"]],
    ["sk- 前缀", "sk-abcdefghijklmnop", ["sk-abcdefghijklmnop"]],
    ["AIza 前缀", "AIzaSyA1234567890abcdefghijklmnopqrstuv", ["AIzaSyA1234567890abcdefghijklmnopqrstuv"]],
    ["JSON 字符串", JSON.stringify({ apiKey: "SECRET" }), ["SECRET"]],
  ];
  for (const [name, text, secrets] of TEXT_CASES)
    assertNoLeak("redactSensitive " + name, String(redactSensitive(text)), secrets);

  const OBJECT_KEYS = ["apiKey", "api_key", "apikey", "authorization", "password",
    "secret", "token", "access_token", "refresh_token", "signature", "APIKEY", "x_api_key"];
  for (const key of OBJECT_KEYS) {
    assertNoLeak(`对象键 ${key}`, JSON.stringify(redactSensitive({ [key]: "SECRET" })), ["SECRET"]);
    assertNoLeak(`嵌套 ${key}`, JSON.stringify(redactSensitive({ cfg: { list: [{ [key]: "SECRET" }] } })), ["SECRET"]);
  }

  // ③ 不得误伤（1295 已经修过一次，回归要钉住）
  for (const safe of ["https://a.com/v1?monkey=SECRET", "https://a.com/v1?keyboard=SECRET",
    "https://a.com/v1?design=SECRET", "https://a.com/v1?tokenizer=SECRET"]) {
    assert(!redactUrl(safe).includes("[REDACTED]"), `不该脱敏却被脱敏：${safe}（1295 回归，#1533）`);
  }
  // 计费字段不得被脱敏（B106）
  for (const usage of [{ promptTokens: 12 }, { completionTokens: 34 }, { tokens: 56 }, { maxTokens: 4096 }])
    assert(!JSON.stringify(redactSensitive(usage)).includes("[REDACTED]"), `计费字段被误脱敏：${JSON.stringify(usage)}（B106 回归）`);

  // ④ sanitizeLogText 必须洗掉 CRLF（防伪造日志行）并限长
  assert(sanitizeLogText("a\r\nb") === "a b", "CRLF 未被压平（1317 回归）");
  assert(sanitizeLogText("y".repeat(3000)).length === 2001, "超长文本未按 2000+省略号限长（1317 回归）");

  console.log("=== 日志脱敏反向测试通过（#1533：三个分隔符 + 凭据形态全覆盖，且不误伤 monkey/keyboard/tokenizer 与计费字段）===");
}

main();
