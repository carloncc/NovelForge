import { ref } from "vue";

/**
 * 轻量全局运行状态：仅供 App.vue 等外层组件（侧栏运行指示/失败徽标）消费。
 * 刻意不引入 generate store：后者会连带管线/图像/视觉守门等核心进入主包（实测 +200 kB）。
 * generate store 负责写入（watch），这里只读。
 */
export const runIsBusy = ref(false);
export const runAssetLabel = ref("");
export const runIsQueue = ref(false);
export const runIsStopping = ref(false);
export const runFailedCount = ref(0);

const stopHandlers = new Map<RunSource, () => void>();

/** #1319：两套付费管线（主管线 main / 图片小说 image）各写各的运行态，忙=或——
 *  一方结束写 idle 不再误清另一方的 busy（此前单槽 last-write-wins，侧栏指示与导入守卫失真）。 */
export type RunSource = "main" | "image";
interface SourceState {
  busy: boolean;
  assetLabel: string;
  queue: boolean;
  stopping: boolean;
}
const sourceStates = new Map<RunSource, SourceState>();

function recompute(): void {
  const states = [...sourceStates.values()];
  runIsBusy.value = states.some((s) => s.busy);
  runAssetLabel.value = states.find((s) => s.busy)?.assetLabel ?? "";
  runIsQueue.value = states.some((s) => s.queue);
  runIsStopping.value = states.some((s) => s.stopping);
}

/** 按来源同步运行态（新口径；generate/image 两侧各调各的） */
export function runStatusSyncSource(
  source: RunSource,
  busy: boolean,
  assetLabel: string,
  queue: boolean,
  stopping: boolean,
): void {
  sourceStates.set(source, { busy, assetLabel, queue, stopping });
  recompute();
}

/** 兼容旧单源调用（主管线）：默认 main */
export function runStatusSync(busy: boolean, assetLabel: string, queue: boolean, stopping: boolean): void {
  runStatusSyncSource("main", busy, assetLabel, queue, stopping);
}

/** 某来源是否正忙（execute 守卫精确判断"别人忙"，避免 busy 刚清、watch 未刷新的竞态误拒） */
export function isRunSourceBusy(source: RunSource): boolean {
  return sourceStates.get(source)?.busy ?? false;
}

/** 按来源注册停止入口（#1319：两套管线各注册各的；模块初始化时调用一次） */
export function registerRunStopSource(source: RunSource, fn: () => void): void {
  stopHandlers.set(source, fn);
}

/** 兼容旧调用（主管线）：默认 main */
export function registerRunStop(fn: () => void): void {
  registerRunStopSource("main", fn);
}

/** 侧栏全局停止：逐个停所有已注册来源（主管线 + 图片小说各停各的，在途付费请求分别中断） */
export function requestRunStop(): void {
  for (const fn of stopHandlers.values()) {
    try {
      fn();
    } catch {
      /* 单个停止失败不影响另一个 */
    }
  }
}

export function runStatusSetFailed(count: number): void {
  runFailedCount.value = count;
}
