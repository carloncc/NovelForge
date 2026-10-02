import { watchTx } from "../src/utils/vfsWeb";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * #1505 回归：IndexedDB 写事务必须同时挂 abort 与 error。
 *
 * 旧实现只挂 onerror。事务在**没有 error 事件**的情况下中止（配额耗尽时提交阶段 abort、
 * 或外部 tx.abort()）只触发 abort —— 此时 Promise 既不 resolve 也不 reject，
 * 调用方的 await 永久挂起（导入页 importing 标志永不复位，界面假死）。
 * 用最小 fake 事务直接驱动三个回调，锁住"abort 必须让 Promise 结算"。
 */
function fakeTx(): { tx: IDBTransaction; fire: (kind: "complete" | "error" | "abort") => void } {
  const handlers: Record<string, (() => void) | null> = { complete: null, error: null, abort: null };
  const tx = {
    error: null as DOMException | null,
    get oncomplete() { return handlers.complete; },
    set oncomplete(handler: (() => void) | null) { handlers.complete = handler; },
    get onerror() { return handlers.error; },
    set onerror(handler: (() => void) | null) { handlers.error = handler; },
    get onabort() { return handlers.abort; },
    set onabort(handler: (() => void) | null) { handlers.abort = handler; },
  } as unknown as IDBTransaction;
  return { tx, fire: (kind) => handlers[kind]?.() };
}

async function main(): Promise<void> {
  // 1) 正常提交 → resolve
  {
    const { tx, fire } = fakeTx();
    let settled = "";
    watchTx(tx, () => { settled = "resolved"; }, () => { settled = "rejected"; });
    assert(typeof tx.oncomplete === "function", "watchTx 必须挂 oncomplete");
    fire("complete");
    assert(settled === "resolved", "事务提交应 resolve");
  }

  // 2) error 事件 → reject
  {
    const { tx, fire } = fakeTx();
    let settled = "";
    watchTx(tx, () => { settled = "resolved"; }, () => { settled = "rejected"; });
    assert(typeof tx.onerror === "function", "watchTx 必须挂 onerror");
    fire("error");
    assert(settled === "rejected", "error 事件应 reject");
  }

  // 3) 关键回归：abort 事件（无 error）也必须 reject，不能让 await 永久挂起
  {
    const { tx, fire } = fakeTx();
    let settled = "";
    watchTx(tx, () => { settled = "resolved"; }, () => { settled = "rejected"; });
    assert(typeof tx.onabort === "function", "watchTx 必须挂 onabort（旧实现漏挂，导致 Promise 永不结算）");
    fire("abort");
    assert(settled === "rejected", "abort 事件必须 reject，否则调用方 await 永久挂起");
  }

  // 4) 真实 Promise 语义：abort 后必须能被 await 到（而不是挂起）
  {
    const { tx, fire } = fakeTx();
    const p = new Promise<void>((resolve, reject) => watchTx(tx, resolve, reject));
    fire("abort");
    const outcome = await p.then(() => "resolved", () => "rejected");
    assert(outcome === "rejected", "abort 后的 Promise 必须 reject 而非悬挂");
  }

  console.log("=== IndexedDB 事务 abort 结算（#1505 回归）测试通过 ===");
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
