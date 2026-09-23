/** ReqFlow batch-c 1301：AbortRegistry 仅持有者可清；imageEdits multipart 转义回归 */
import { registerRunAbort, unregisterRunAbort, activeAbortSignal, setActiveAbortSignal } from "../src/api/abort";
import { buildEditMultipart } from "../src/api/imageEdits";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) 注册/仅持有者可清 ---------- */
{
  const c1 = new AbortController();
  const c2 = new AbortController();
  registerRunAbort("run1", c1.signal);
  assert(activeAbortSignal() === c1.signal, "注册后 active 应为 run1");
  registerRunAbort("run2", c2.signal);
  assert(activeAbortSignal() === c2.signal, "后注册成为 active");
  // 非持有者清 run1 不得影响 active(run2)
  unregisterRunAbort("run1", c1.signal);
  assert(activeAbortSignal() === c2.signal, "清他人不得影响 active");
  // 旧无 owner clear 在有 owner 时不得清
  setActiveAbortSignal(undefined);
  assert(activeAbortSignal() === c2.signal, "无 owner clear 不得清掉有 owner 的信号");
  // 持有者可清
  unregisterRunAbort("run2", c2.signal);
  assert(activeAbortSignal() === undefined, "持有者清后 active 应空");
}

/* ---------- 2) imageEdits multipart 转义 ---------- */
{
  const body = buildEditMultipart(
    "B",
    { model: "gpt-image-2", prompt: "hi" },
    { name: 'im"age', filename: "a\r\nb.png", mime: "image/png", bytes: new Uint8Array([1, 2]) },
  );
  const text = new TextDecoder("latin1").decode(body);
  assert(text.includes('name="im\\"age"'), "file name 引号应转义");
  assert(!text.includes("a\r\nb.png"), "filename CRLF 应清洗");
}

console.log("=== audit-c abort tests passed ===");
