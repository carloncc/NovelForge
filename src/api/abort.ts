/**
 * 全局在途请求中止信号（#784）：管线/素材重生成/图片小说在运行时设置一个 AbortController.signal，
 * API 层（含 Tauri invoke 与 Web fetch 两条传输）在发起请求时附带该信号；
 * 「停止」时 abort → 在途请求立即中断（Tauri 侧经 cancel_http_request 取消 reqwest 请求），
 * 不再出现「点了停止仍继续跑完并计费」。
 *
 * 1301：此前全局 active 单例，pipeline 与图片小说互相覆盖/清除，一方结束清掉另一方在途请求的中止能力。
 * 新增按 runId 注册的 AbortRegistry：仅持有者可清；调用链应显式传 signal，active 仅作回退。
 * （任务白名单写 src/utils/abort.ts，实际文件为 src/api/abort.ts，此处按实际文件修复。）
 */
let active: AbortSignal | undefined;
/** active 的持有者：clear 时仅持有者（或信号同一）可清，避免误清另一方在途请求。 */
let activeOwner: string | undefined;

const registry = new Map<string, AbortSignal>();

/** 注册某次运行的中止信号（返回同一 signal，供调用链显式透传）。 */
export function registerRunAbort(runId: string, signal: AbortSignal): AbortSignal {
  registry.set(runId, signal);
  // 兼容旧全局读取：后注册者成为 active，但记录 owner，clear 时校验
  active = signal;
  activeOwner = runId;
  return signal;
}

/** 仅持有者可注销；非持有者调用直接忽略（不清除他人信号）。 */
export function unregisterRunAbort(runId: string, signal?: AbortSignal): void {
  const cur = registry.get(runId);
  if (cur && signal && cur !== signal) return;
  registry.delete(runId);
  if (activeOwner === runId && (!signal || active === signal)) {
    active = undefined;
    activeOwner = undefined;
  }
}

export function signalForRun(runId: string): AbortSignal | undefined {
  return registry.get(runId);
}

export function setActiveAbortSignal(signal: AbortSignal | undefined, owner?: string): void {
  // 兼容旧调用：无 owner 的 clear 仅在无 owner 记录或信号同一时生效，避免误清他人
  if (signal === undefined) {
    if (owner !== undefined && activeOwner !== undefined && owner !== activeOwner) return;
    if (owner === undefined && activeOwner !== undefined) {
      // 旧调用方（未传 owner）在有明确 owner 时不得清掉他人信号
      return;
    }
    active = undefined;
    activeOwner = undefined;
    return;
  }
  active = signal;
  if (owner !== undefined) activeOwner = owner;
}

export function activeAbortSignal(): AbortSignal | undefined {
  return active;
}
