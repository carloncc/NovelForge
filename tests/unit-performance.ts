import { ConcurrencyLimiter } from "../src/utils/performance";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const limiter = new ConcurrencyLimiter(1);
  const firstGate = deferred();
  const secondStarted = deferred();

  const first = limiter.run(async () => firstGate.promise);
  const second = limiter.run(async () => {
    secondStarted.resolve();
  });

  await Promise.resolve();
  limiter.setMaxConcurrent(2);

  const outcome = await Promise.race([
    secondStarted.promise.then(() => "started"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  assert(outcome === "started", "increasing the concurrency limit must release queued work without deadlocking");

  firstGate.resolve();
  await Promise.all([first, second]);
  console.log("=== concurrency limiter tests passed ===");
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
