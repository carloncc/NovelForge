/**
 * 并发控制 - 限制同时执行的异步操作数量
 */
/** #1544：把并发上限夹成一个可比较的正数。
 *  光有 Math.max(1, n) 不够——Math.max(1, NaN) 是 NaN，而 `running < NaN` 恒为 false，
 *  NaN 会让限流器走进和 0 一样的静默死锁。非有限值一律退回 1。 */
function clampConcurrency(n: number): number {
  return Number.isFinite(n) ? Math.max(1, n) : 1;
}

export class ConcurrencyLimiter {
  private queue: Array<() => void> = [];
  private running = 0;
  private maxConcurrent: number;

  // #1544：构造时与 setMaxConcurrent 同样夹到 >=1。
  // maxConcurrent 为 0（或负数）时，acquire 的 `running < maxConcurrent` 恒为 false、
  // drain 的 while 也恒为 false —— 于是**每一个任务都会永久排在 queue 里，谁都等不到**。
  // setter 早就用 Math.max(1, n) 夹过了，构造函数却漏了，是一处不对称：
  // 将来谁按「setter 夹过了」的直觉写 new ConcurrencyLimiter(n) 就会踩到静默死锁。
  // 现有三个调用点传的都是字面量 3/3/8，所以今天还触发不了——这属于补陷阱，不是修活 bug。
  constructor(maxConcurrent: number) {
    this.maxConcurrent = clampConcurrency(maxConcurrent);
  }

  /** 动态调整上限：增大立即生效（新任务直接进入），减小后运行数自然回落 */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = clampConcurrency(n);
    this.drain();
  }

  get max(): number {
    return this.maxConcurrent;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.running--;
      this.drain();
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private drain(): void {
    while (this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) return;
      this.running++;
      next();
    }
  }
}
