/**
 * 性能优化工具
 */

/**
 * 防抖函数 - 延迟执行，多次调用只执行最后一次
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  waitMs: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, waitMs);
  };
}

/**
 * 节流函数 - 限制执行频率
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limitMs: number
): (...args: Parameters<T>) => void {
  let lastRun = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    
    if (now - lastRun >= limitMs) {
      func(...args);
      lastRun = now;
    } else {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        func(...args);
        lastRun = Date.now();
        timeoutId = null;
      }, limitMs - (now - lastRun));
    }
  };
}

/**
 * 批量处理 - 将多个操作合并成批次执行
 */
export function createBatcher<T, R>(
  processor: (items: T[]) => Promise<R[]>,
  options: {
    maxBatchSize?: number;
    maxWaitMs?: number;
  } = {}
): (item: T) => Promise<R> {
  const { maxBatchSize = 10, maxWaitMs = 100 } = options;
  
  let batch: { item: T; resolve: (result: R) => void; reject: (error: Error) => void }[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (batch.length === 0) return;
    
    const currentBatch = batch;
    batch = [];
    
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    try {
      const items = currentBatch.map(b => b.item);
      const results = await processor(items);
      
      currentBatch.forEach((b, i) => {
        b.resolve(results[i]);
      });
    } catch (error) {
      currentBatch.forEach(b => {
        b.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
  };

  return (item: T): Promise<R> => {
    return new Promise((resolve, reject) => {
      batch.push({ item, resolve, reject });
      
      if (batch.length >= maxBatchSize) {
        flush();
      } else if (timeoutId === null) {
        timeoutId = setTimeout(flush, maxWaitMs);
      }
    });
  };
}

/**
 * 缓存函数结果
 */
export function memoize<T extends (...args: any[]) => any>(
  func: T,
  options: {
    maxSize?: number;
    ttlMs?: number;
    keyGenerator?: (...args: Parameters<T>) => string;
  } = {}
): T {
  const { maxSize = 100, ttlMs, keyGenerator = (...args) => JSON.stringify(args) } = options;
  
  const cache = new Map<string, { value: ReturnType<T>; timestamp: number }>();

  return ((...args: Parameters<T>): ReturnType<T> => {
    const key = keyGenerator(...args);
    const cached = cache.get(key);
    
    if (cached) {
      if (!ttlMs || Date.now() - cached.timestamp < ttlMs) {
        return cached.value;
      }
      cache.delete(key);
    }

    const result = func(...args);
    
    cache.set(key, { value: result, timestamp: Date.now() });
    
    // 限制缓存大小
    if (cache.size > maxSize) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey!);
    }

    return result;
  }) as T;
}

/**
 * 并发控制 - 限制同时执行的异步操作数量
 */
export class ConcurrencyLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private maxConcurrent: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.queue.push(resolve));
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

/**
 * 性能计时器
 */
export class PerformanceTimer {
  private startTime: number;
  private marks: Map<string, number> = new Map();

  constructor(private label: string) {
    this.startTime = performance.now();
  }

  mark(name: string): void {
    this.marks.set(name, performance.now() - this.startTime);
  }

  getElapsed(mark?: string): number {
    if (mark) {
      return this.marks.get(mark) || 0;
    }
    return performance.now() - this.startTime;
  }

  log(mark?: string): void {
    const elapsed = this.getElapsed(mark);
    const label = mark ? `${this.label} - ${mark}` : this.label;
    console.log(`⏱️ ${label}: ${elapsed.toFixed(2)}ms`);
  }

  summary(): void {
    console.log(`\n⏱️ ${this.label} Performance Summary:`);
    console.log(`Total: ${this.getElapsed().toFixed(2)}ms`);
    
    if (this.marks.size > 0) {
      console.log("\nCheckpoints:");
      let lastTime = 0;
      for (const [name, time] of this.marks) {
        const delta = time - lastTime;
        console.log(`  ${name}: ${time.toFixed(2)}ms (+${delta.toFixed(2)}ms)`);
        lastTime = time;
      }
    }
    console.log();
  }
}

/**
 * 创建性能计时器
 */
export function createTimer(label: string): PerformanceTimer {
  return new PerformanceTimer(label);
}

/**
 * 简单的性能监控装饰器（用于调试）
 */
export function measurePerformance(label?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const timer = createTimer(label || `${target.constructor.name}.${propertyKey}`);
      try {
        const result = await originalMethod.apply(this, args);
        timer.log();
        return result;
      } catch (error) {
        timer.log();
        throw error;
      }
    };
    
    return descriptor;
  };
}
