/**
 * 全局在途请求中止信号（#784）：管线/素材重生成/图片小说在运行时设置一个 AbortController.signal，
 * API 层（含 Tauri invoke 与 Web fetch 两条传输）在发起请求时附带该信号；
 * 「停止」时 abort → 在途请求立即中断（Tauri 侧经 cancel_http_request 取消 reqwest 请求），
 * 不再出现「点了停止仍继续跑完并计费」。
 */
let active: AbortSignal | undefined;

export function setActiveAbortSignal(signal: AbortSignal | undefined): void {
  active = signal;
}

export function activeAbortSignal(): AbortSignal | undefined {
  return active;
}
