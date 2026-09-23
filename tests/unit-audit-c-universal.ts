/** ReqFlow batch-c 1297 + 1317(universal)：原型污染、multipart 注入、hex 校验、SSRF、裸对象 */
import {
  setByPath,
  buildMultipartBody,
  escapeDispositionName,
  hexToBase64,
  httpStatusError,
  isAllowedResultUrl,
} from "../src/api/universal";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) setByPath 拒绝原型污染 ---------- */
let threw = false;
try {
  setByPath({}, "__proto__.polluted", "x");
} catch {
  threw = true;
}
assert(threw, "setByPath 必须拒绝 __proto__");
assert(({} as Record<string, unknown>)["polluted" as string] === undefined, "不得污染 Object.prototype");

threw = false;
try {
  setByPath({}, "a.constructor.polluted", "x");
} catch {
  threw = true;
}
assert(threw, "setByPath 必须拒绝 constructor");

threw = false;
try {
  setByPath({}, "a[0].prototype.x", "y");
} catch {
  threw = true;
}
assert(threw, "setByPath 必须拒绝 prototype");

// 正常路径仍可用
const o: Record<string, unknown> = {};
setByPath(o, "contents[0].parts[0].text", "hi");
assert((o as { contents: { parts: { text: string }[] }[] }).contents[0].parts[0].text === "hi", "正常 setByPath 不得破坏");

/* ---------- 2) multipart name 转义 ---------- */
assert(escapeDispositionName('a"b\r\nc') === 'a\\"b_c', `转义失败：${escapeDispositionName('a"b\r\nc')}`);
const mp = buildMultipartBody({ 'a"b': "v", "x\r\ny": 1 });
assert(!mp.body.includes('name="a"b"'), "引号不得直接插值");
assert(mp.body.includes('name="a\\"b"'), "引号应转义");

/* ---------- 3) hex 非法硬错 ---------- */
let hexThrew = false;
try {
  hexToBase64("zzzz");
} catch {
  hexThrew = true;
}
assert(hexThrew, "非法 hex 必须抛错");
hexThrew = false;
try {
  hexToBase64("abc");
} catch {
  hexThrew = true;
}
assert(hexThrew, "奇长 hex 必须抛错");
assert(hexToBase64(Buffer.from("OK").toString("hex")) === Buffer.from("OK").toString("base64"), "合法 hex 应正常解码");

/* ---------- 4) 结果 URL SSRF ---------- */
assert(!isAllowedResultUrl("http://127.0.0.1/x.png", "https://api.test.com"), "回环必须拦");
assert(!isAllowedResultUrl("http://192.168.1.5/x.png", "https://api.test.com"), "私网必须拦");
assert(!isAllowedResultUrl("http://169.254.169.254/", "https://api.test.com"), "link-local 必须拦");
assert(!isAllowedResultUrl("http://evil.test/x.png", "https://api.test.com"), "http 外链必须拦");
assert(isAllowedResultUrl("https://cdn.test/x.png", "https://api.test.com"), "https 公网应放行");
assert(isAllowedResultUrl("http://127.0.0.1:11434/x.png", "http://127.0.0.1:11434/v1"), "同 host 回源应放行");

/* ---------- 5) httpStatusError 带 status 保栈 ---------- */
const e = httpStatusError(429, "HTTP 429");
assert(e instanceof Error && (e as { status?: number }).status === 429, "httpStatusError 必须挂 status");

console.log("=== audit-c universal tests passed ===");
