import { b64encode, b64decode } from "../src/utils/base64";
import { errMsg } from "../src/utils/errors";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① errMsg 的返回值必须永远是 string（#1531）
  //    JSON.stringify(函数/Symbol) 返回的是 undefined 值，直接 return 会把
  //    字面量 "undefined" 拼进用户可见的错误文案。
  for (const v of [() => {}, Symbol("s"), Symbol.iterator, { a: 1 }, [1, 2], 0, false, "x", new Error("e"), new Error(""), null, undefined]) {
    const out: unknown = errMsg(v);
    assert(typeof out === "string", `errMsg 返回值必须是 string，实得 ${typeof out}（#1531）`);
    assert(out !== "undefined" && out !== "", `errMsg 不应产出 "undefined"／空串，实得 ${JSON.stringify(out)}（#1531）`);
  }
  assert(errMsg("boom") === "boom", "普通字符串应原样返回");
  assert(errMsg(new Error("坏了")) === "坏了", "Error 应取 message");
  assert(errMsg(new Error("")) === "未知错误", "空 message 应兜底");

  // ② b64decode 必须两端行为一致（#1532）
  //    合法输入逐字节保持不变（含带补位/无补位/空串）。
  for (const n of [0, 1, 2, 3, 4, 5, 17, 255, 256, 1024, 4096]) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = (i * 37 + 11) % 256;
    const back = b64decode(b64encode(data));
    assert(back.length === n, `len=${n} 往返长度应为 ${n}，实得 ${back.length}（#1532）`);
    for (let i = 0; i < n; i++)
      assert(back[i] === data[i], `len=${n} 第 ${i} 字节不一致（#1532）`);
  }
  assert(b64decode("").length === 0, "空串应解码为空");
  assert(b64decode("SGVsbG8=")[0] === 0x48, "带补位应正确解码");
  assert(b64decode("SGVsbG8")[0] === 0x48, "无补位也应正确解码");
  assert(b64decode("SGVsbG8\n")[0] === 0x48, "带换行空白应先剥离再解码");

  // ③ 损坏数据必须**显式抛错**，不能静默返回 0 字节——
  //    旧实现在 Node 下静默返回 0 字节（= 产出一个没有内容的文件），在浏览器下抛错。
  for (const bad of ["!!!", "###", "a", "abcde", "SGVsbG8=x", "ab==cd"]) {
    let threw = false;
    try { b64decode(bad); } catch { threw = true; }
    assert(threw, `损坏的 base64 "${bad}" 必须抛错而不是静默返回 0 字节（#1532）`);
  }

  console.log("=== base64 严格解码 + errMsg 类型契约测试通过（#1531/#1532）===");
}

main();
