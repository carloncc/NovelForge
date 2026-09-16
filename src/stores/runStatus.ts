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

let stopHandler: (() => void) | null = null;
/** generate store 注册停止入口（模块初始化时调用一次） */
export function registerRunStop(fn: () => void): void {
  stopHandler = fn;
}
export function requestRunStop(): void {
  stopHandler?.();
}

export function runStatusSync(busy: boolean, assetLabel: string, queue: boolean, stopping: boolean): void {
  runIsBusy.value = busy;
  runAssetLabel.value = assetLabel;
  runIsQueue.value = queue;
  runIsStopping.value = stopping;
}

export function runStatusSetFailed(count: number): void {
  runFailedCount.value = count;
}
