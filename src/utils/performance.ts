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
