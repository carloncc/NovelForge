import "fake-indexeddb/auto";
import { watchTx, vfsWriteTextFile, vfsExists, vfsRemove, vfsCopyDirAll, vfsReadTextFile } from "../src/utils/vfsWeb";

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

  await testRemoveIsAtomic();
  await testCopyDirAllIsAtomic();

  console.log("=== IndexedDB 事务 abort 结算 + 目录删/拷原子性（#1505/#1490 回归）测试通过 ===");
}

/* ---------------- 目录级写路径的原子性（#1490 同口径） ----------------
 * vfsRemove / vfsCopyDirAll 此前是「逐键独立事务」：每个键一个 readwrite 事务，
 * 中途配额耗尽/事务 abort 时前面的删除（或写入）已经提交，目录只删/只拷了一半，
 * 而调用方只看到一次失败。这里用 fake-indexeddb 真实驱动事务：
 *  - 拦下第 1 个 readwrite 事务并在它提交前 abort()（等价于配额中断）；
 *  - 断言 Promise 必须 reject（不能永久挂起），且 VFS 状态完整回滚。
 * 旧实现下这两个用例都会失败（状态被改掉一半 / 出现多个 readwrite 事务）。
 */

interface TxSpy {
  /** 已开启的 readwrite 事务数：原子实现必须是 1（逐键实现 = N） */
  readwriteCount: number;
  restore: () => void;
}

/** 给 IDBDatabase.prototype.transaction 打桩：统计 readwrite 事务，并 abort 第 abortAt 个 */
function spyTransactions(abortAt: number): TxSpy {
  const proto = IDBDatabase.prototype as unknown as {
    transaction: (...args: unknown[]) => IDBTransaction;
  };
  const original = proto.transaction;
  const spy: TxSpy = { readwriteCount: 0, restore: () => { proto.transaction = original; } };
  proto.transaction = function (this: IDBDatabase, ...args: unknown[]): IDBTransaction {
    const tx = original.apply(this, args);
    if (args[1] === "readwrite") {
      spy.readwriteCount++;
      if (spy.readwriteCount === abortAt) {
        // 必须在事务结算前 abort：onabort 才是配额中断实际触发的事件（onerror 不触发）。
        // 延后到微任务再 abort —— 真实配额中断发生在提交阶段（同步请求已全部发出之后），
        // 而 fake-indexeddb 的 tx.abort() 是同步生效的：立刻 abort 会让紧接着的
        // objectStore() 直接抛 InvalidStateError，测不到「半提交」这一真实形态。
        queueMicrotask(() => tx.abort());
      }
    }
    return tx;
  };
  return spy;
}

async function expectReject(run: () => Promise<void>, what: string): Promise<void> {
  let settled = "";
  const p = run().then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
  await Promise.race([p, timeout]);
  assert(settled === "rejected", `${what}：事务中断必须 reject（settled=${settled || "挂起"}）`);
}

async function testRemoveIsAtomic(): Promise<void> {
  const root = "/app/atomic-remove";
  await vfsWriteTextFile(`${root}/a.txt`, "A");
  await vfsWriteTextFile(`${root}/deep/b.txt`, "B");
  await vfsWriteTextFile(`${root}/deep/c.txt`, "C");
  const spy = spyTransactions(1);
  try {
    await expectReject(() => vfsRemove(root), "vfsRemove");
  } finally {
    spy.restore();
  }
  assert(spy.readwriteCount === 1, `vfsRemove 必须只开 1 个 readwrite 事务（实际 ${spy.readwriteCount} 个 = 逐键独立事务）`);
  // 关键：中断后目录内容必须完整保留（旧实现下会只剩后一半）
  for (const p of [`${root}/a.txt`, `${root}/deep/b.txt`, `${root}/deep/c.txt`]) {
    assert(await vfsExists(p), `vfsRemove 中途 abort 后不得留下半删状态：${p} 已丢失`);
  }
  // 恢复后仍能正常删除（事务中断不污染后续调用）
  await vfsRemove(root);
  assert(!(await vfsExists(`${root}/deep/c.txt`)), "vfsRemove 正常路径应递归删除");
}

async function testCopyDirAllIsAtomic(): Promise<void> {
  const src = "/app/atomic-copy-src";
  const dst = "/app/atomic-copy-dst";
  await vfsWriteTextFile(`${src}/a.txt`, "A");
  await vfsWriteTextFile(`${src}/deep/b.txt`, "B");
  const spy = spyTransactions(1);
  try {
    await expectReject(() => vfsCopyDirAll(src, dst), "vfsCopyDirAll");
  } finally {
    spy.restore();
  }
  assert(spy.readwriteCount === 1, `vfsCopyDirAll 必须只开 1 个写入事务（实际 ${spy.readwriteCount} 个 = 逐键 vfsWriteFile）`);
  // 关键：中断后目标目录里不得出现「只拷了一半」的文件
  assert(!(await vfsExists(`${dst}/a.txt`)), "vfsCopyDirAll 中途 abort 后目标不得有半拷文件 a.txt");
  assert(!(await vfsExists(`${dst}/deep/b.txt`)), "vfsCopyDirAll 中途 abort 后目标不得有半拷文件 deep/b.txt");
  // 正常路径：内容一致
  await vfsCopyDirAll(src, dst);
  assert((await vfsReadTextFile(`${dst}/a.txt`)) === "A", "vfsCopyDirAll 正常路径应拷贝文件内容");
  assert((await vfsReadTextFile(`${dst}/deep/b.txt`)) === "B", "vfsCopyDirAll 正常路径应保留子目录结构");
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
