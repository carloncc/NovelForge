/**
 * #1544：ConcurrencyLimiter 的并发上限必须恒 >= 1。
 *
 * maxConcurrent 为 0 或负数时，acquire 里「running < maxConcurrent」恒为 false、
 * drain 的 while 也恒为 false，于是每个任务都永久卡在 queue 里——不是报错，是静默死锁。
 * setMaxConcurrent 早就用 Math.max(1, n) 夹过，构造函数原先漏夹，是一处不对称。
 */
import { ConcurrencyLimiter } from "../src/utils/performance";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 用竞态判定：resolve 就说明没有被永久卡住 */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<"ok" | "hang"> {
  return Promise.race([
    p.then(() => "ok" as const, () => "ok" as const),
    new Promise<"hang">((r) => setTimeout(() => r("hang"), ms)),
  ]).then((v) => {
    if (v === "hang") throw new Error(label + "：任务在 " + ms + "ms 内未完成（永久卡死）");
    return v;
  });
}

async function main(): Promise<void> {
  // ① 上限恒 >= 1
  for (const n of [0, -1, -99, Number.NaN]) {
    const l = new ConcurrencyLimiter(n);
    assert(l.max >= 1, "构造 " + n + " 后上限应 >=1，实为 " + l.max + "（#1544）");
  }
  for (const n of [1, 2, 8, 3]) {
    assert(new ConcurrencyLimiter(n).max === n, "合法值 " + n + " 不应被改写（#1544）");
  }

  // ② 上限为 0 的实例也必须能真正跑完任务，而不是永久排队
  {
    const l = new ConcurrencyLimiter(0);
    const out = await withDeadline(Promise.all([
      l.run(async () => 1),
      l.run(async () => 2),
      l.run(async () => 3),
    ]), 1500, "上限 0 的实例");
    assert(out === "ok", "上限 0 的实例应当能跑完（#1544）");
  }

  // ③ NaN：Math.max(1, NaN) === NaN，会让 running < NaN 恒 false —— 必须一并挡住。
  //    注：对 Infinity 的负控（退回 Infinity 而非 1）**没有失败**，这是如实记录的结果：
  //    Infinity 并不是死锁（running < Infinity 恒真，退化成不限并发，任务照样完成），
  //    所以现有断言区分不了「Infinity→1」和「Infinity→Infinity」。
  //    选 1 是保守策略而非被证明的必要行为；当前无调用方传 Infinity，行为不受影响。
  {
    const l = new ConcurrencyLimiter(Number.NaN);
    assert(l.max >= 1, "NaN 上限必须被夹成 >=1，实为 " + l.max + "（#1544）");
    await withDeadline(l.run(async () => 1), 1500, "NaN 上限");
  }

  // ④ 并发上限仍然真的生效（不能因为夹紧就放飞成无限并发）
  {
    const l = new ConcurrencyLimiter(2);
    let peak = 0, cur = 0;
    await Promise.all(Array.from({ length: 9 }, () => l.run(async () => {
      cur++; peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 15));
      cur--;
    })));
    assert(peak <= 2, "并发峰值 " + peak + " 超过上限 2（#1544）");
    assert(peak === 2, "9 个任务 / 上限 2，峰值应恰好达到 2，实为 " + peak + "（#1544）");
  }

  // ⑤ 任务抛错不能卡死队列（finally 里必须释放名额）
  {
    const l = new ConcurrencyLimiter(1);
    await l.run(async () => { throw new Error("boom"); }).catch(() => undefined);
    await withDeadline(l.run(async () => "still-alive"), 1500, "前一个任务抛错后");
  }

  console.log("=== ConcurrencyLimiter 上下限不变量测试通过（#1544：上限恒 >=1，0/NaN 不再死锁）===");
}

void main();
