/**
 * #1447 图片小说剧本阶段按章并行：runOrderedPool 纯调度回归
 * - 多章并发时结果顺序严格按输入顺序（预分配，不用 push）；
 * - 实际并发 = clamp(配置, 1, 章节数)，绝不超章节数；
 * - 中止后不再派发新任务（已派发的等待结束）；
 * - 单章/空输入边界不变；单任务异常隔离不打断其它任务。
 * 纯函数（core/imageStory.ts），不用 tauri/磁盘/Vue。
 */
import { runOrderedPool } from "../src/core/imageStory";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1) 顺序：结果按输入顺序返回，与完成先后无关（末章故意最快完成）
  {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = await runOrderedPool(
      items,
      4,
      async (n) => {
        await delay((items.length - n) * 2);
        return `ch${n}`;
      },
      { isAborted: () => false },
    );
    assert(out.length === items.length, "#1447 结果长度应与输入一致");
    assert(
      out.map((v) => v).join(",") === items.map((n) => `ch${n}`).join(","),
      `#1447 结果必须按输入顺序，实际 ${out.join(",")}`,
    );
  }

  // 2) 并发不超过配置：配置 3、10 章 → 峰值 ≤ 3
  {
    let active = 0;
    let maxActive = 0;
    await runOrderedPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active--;
      },
      { isAborted: () => false },
    );
    assert(maxActive <= 3, `#1447 峰值并发应 ≤ 配置 3，实际 ${maxActive}`);
    assert(maxActive === 3, `#1447 应真正并发到 3，实际 ${maxActive}`);
  }

  // 3) 并发不超过章节数：配置 30、4 章 → 峰值 ≤ 4（且能跑满 4）
  {
    let active = 0;
    let maxActive = 0;
    await runOrderedPool(
      Array.from({ length: 4 }, (_, i) => i),
      30,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active--;
      },
      { isAborted: () => false },
    );
    assert(maxActive <= 4, `#1447 峰值并发应 ≤ 章节数 4，实际 ${maxActive}`);
    assert(maxActive === 4, `#1447 4 章应并发到 4，实际 ${maxActive}`);
  }

  // 4) 中止后不再派发：并发 1，第 1 章完成后置中止，后续不再开始
  {
    let started = 0;
    let aborted = false;
    const out = await runOrderedPool(
      Array.from({ length: 5 }, (_, i) => i),
      1,
      async (n) => {
        started++;
        if (n === 0) aborted = true;
        return n;
      },
      { isAborted: () => aborted },
    );
    assert(started === 1, `#1447 中止后不得再派发，实际开始 ${started} 章`);
    assert(out[0] === 0 && out[1] === undefined && out[4] === undefined, "#1447 未派发章应为 undefined");
  }

  // 5) 开始即中止：一个都不派发，直接返回全 undefined（不悬挂）
  {
    let started = 0;
    const out = await runOrderedPool(
      [0, 1, 2],
      3,
      async (n) => {
        started++;
        return n;
      },
      { isAborted: () => true },
    );
    assert(started === 0, "#1447 已中止时不得派发任何任务");
    assert(out.length === 3 && out.every((v) => v === undefined), "#1447 全 undefined 且长度不变");
  }

  // 6) 单章行为不变：并发被钳到 1，结果正确
  {
    let maxActive = 0;
    let active = 0;
    const out = await runOrderedPool(
      ["only"],
      5,
      async (s) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(2);
        active--;
        return s.toUpperCase();
      },
      { isAborted: () => false },
    );
    assert(out.length === 1 && out[0] === "ONLY", "#1447 单章结果应正确");
    assert(maxActive === 1, "#1447 单章并发应为 1");
  }

  // 7) 空输入：不派发、不悬挂、返回空数组
  {
    let called = 0;
    const out = await runOrderedPool(
      [] as number[],
      3,
      async (n) => {
        called++;
        return n;
      },
      { isAborted: () => false },
    );
    assert(out.length === 0, "#1447 空输入应返回空数组");
    assert(called === 0, "#1447 空输入不得调用任务函数");
  }

  // 8) 异常隔离：单章抛错走 onError，其它章照常完成；失败槽位为 undefined
  {
    const errors: number[] = [];
    const out = await runOrderedPool(
      [0, 1, 2, 3],
      2,
      async (n) => {
        if (n === 1) throw new Error("boom");
        return n * 10;
      },
      {
        isAborted: () => false,
        onError: (_item, index) => errors.push(index),
      },
    );
    assert(errors.join(",") === "1", `#1447 异常应回调 onError(index=1)，实际 ${errors.join(",")}`);
    assert(out[0] === 0 && out[1] === undefined && out[2] === 20 && out[3] === 30, "#1447 单章异常不得打断其它章");
  }

  // 9) 非法并发（0/NaN）兜底为 1，不会死循环
  {
    let maxActive = 0;
    let active = 0;
    await runOrderedPool(
      [0, 1, 2],
      0,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(2);
        active--;
      },
      { isAborted: () => false },
    );
    assert(maxActive === 1, `#1447 非法并发应兜底为 1，实际 ${maxActive}`);
    let called = 0;
    await runOrderedPool(
      [0, 1],
      Number.NaN,
      async () => {
        called++;
      },
      { isAborted: () => false },
    );
    assert(called === 2, "#1447 NaN 并发也应跑完全部任务");
  }

  console.log("=== image story concurrency tests passed ===");
}

await main();
