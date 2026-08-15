/**
 * 并发控制 - 限制同时执行的异步操作数量
 */
export class ConcurrencyLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private maxConcurrent: number) {}

  /** 动态调整上限：增大立即生效（新任务直接进入），减小后运行数自然回落 */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    while (this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) break;
      this.running++;
      next();
    }
  }

  get max(): number {
    return this.maxConcurrent;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    this.running++;
    try {
      return await operation();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
