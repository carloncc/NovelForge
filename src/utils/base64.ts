/** Uint8Array → base64（Node/Browser 通用：优先 Buffer，回退分块 btoa） */
export function b64encode(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 合法 base64 字符集（允许尾部补位 =）；其余字符一律视为损坏数据 */
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * base64 → Uint8Array（Node/Browser 通用：优先 Buffer，回退 atob）。
 *
 * #1532：这段此前在三处各抄了一份，且**行为互不相同**——
 * Node 的 `Buffer.from(x, "base64")` 对非法字符静默丢弃（`"!!!"` → 0 字节），
 * 浏览器的 `atob` 则抛 InvalidCharacterError。同一份损坏数据，桌面端静默产出 0 字节文件，
 * web 端直接崩。这里统一成「两端都显式抛错」：base64 损坏属于真损坏（接口响应 / 下载分块），
 * 静默返回空数组只会让用户拿到一个没有内容的文件而看不到任何错误。
 * 合法输入的解码结果与旧实现逐字节一致（见 unit-base64-strict）。
 */
export function b64decode(dataB64: string): Uint8Array {
  // 少数接口会带换行/空白，先去掉再校验
  const s = dataB64.replace(/\s+/g, "");
  // 合法长度是 4 的倍数，或去掉补位后 %4 ∈ {0,2,3}；%4 === 1 一定是损坏数据
  if (!BASE64_CHARS.test(s) || s.length % 4 === 1) throw new Error("非法的 base64 数据");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
