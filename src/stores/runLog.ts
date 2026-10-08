import { ref } from "vue";
import { addLogListener, type LogEntry, type LogLevel } from "../utils/logger";
import type { PageId } from "./nav";

/**
 * 全局运行日志 + 长任务进度：供侧栏常驻面板消费。
 *
 * 为什么单独建一个 store：
 * - 进度此前只活在页面组件内部（VisualBiblePanel 的 creating/createProgress 都是局部 ref），
 *   而 App.vue 的 <component :is> 没有 KeepAlive —— 切页即销毁组件、进度随之消失，
 *   看起来像「切换就不运行了」，实际后台仍在跑（更糟的是回到页面还能再点一次，重复付费）。
 * - 把「当前长任务 + 进度」提到全局后，切页只销毁视图，不销毁事实。
 * - 日志用 logger 的观察者接口订阅，拿到的是与磁盘日志同源的统一流
 *   （pipeline / visualBible / api / tauri 全在内），不再是页面各自攒的碎片。
 */

/** 内存缓冲上限：只保留最近这么多条（磁盘日志另有全量） */
const RUN_LOG_LIMIT = 400;
interface RunLogLine {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  /** entry.data 的一行化摘要。
   *  失败路径、错误文本全在 data 里：只带 message 的话，「调用 readTextFile 失败」
   *  这种一行里看不出是哪个文件失败，等于白记（用户实测反馈过）。 */
  detail: string;
}

export const runLogLines = ref<RunLogLine[]>([]);

/** 详情上限：面板一行内够看，且不会因为 base64/大对象把 DOM 撑爆 */
const DETAIL_MAX = 300;

function summarizeData(data: unknown): string {
  if (data === undefined || data === null) return "";
  let text: string;
  try {
    // data 进 logger 时已过 redactSensitive + truncate，这里只做压缩
    text = typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return "";
  }
  if (!text || text === "{}" || text === "null") return "";
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

function appendRunLog(entry: LogEntry): void {
  // 与文件 sink 同口径：debug 不上屏，否则面板会被 API 细节刷屏
  if (entry.level === "debug") return;
  const lines = runLogLines.value;
  lines.push({
    at: entry.at,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    detail: summarizeData(entry.data),
  });
  if (lines.length > RUN_LOG_LIMIT) lines.splice(0, lines.length - RUN_LOG_LIMIT);
}

/** 模块级订阅一次：App.vue 启动即 import 本 store，页面切换不影响订阅存活 */
addLogListener(appendRunLog);

export function clearRunLog(): void {
  runLogLines.value = [];
}

interface RunActivity {
  /** 稳定标识：判断「同一任务是否已在运行」，也是旧回调防串台的依据 */
  key: string;
  /** 已本地化的任务名 */
  label: string;
  /** 细粒度阶段文案（如「换装三视图 3/9」） */
  detail: string;
  done: number;
  total: number;
  startedAt: number;
  /** 发起页面：用户切到别的页面时据此提示「仍在后台运行」 */
  page: PageId | "";
}

export const runActivity = ref<RunActivity | null>(null);

export function startRunActivity(init: { key: string; label: string; page?: PageId; total?: number }): void {
  runActivity.value = {
    key: init.key,
    label: init.label,
    detail: "",
    done: 0,
    total: init.total ?? 0,
    startedAt: Date.now(),
    page: init.page ?? "",
  };
}

/** 只更新进度/细节；key 不匹配说明是上一轮残留回调，直接忽略（防旧任务覆盖新任务） */
export function updateRunActivity(key: string, patch: { detail?: string; done?: number; total?: number }): void {
  const cur = runActivity.value;
  if (!cur || cur.key !== key) return;
  if (patch.detail !== undefined) cur.detail = patch.detail;
  if (patch.done !== undefined) cur.done = patch.done;
  if (patch.total !== undefined) cur.total = patch.total;
}

export function finishRunActivity(key: string): void {
  const cur = runActivity.value;
  if (!cur || cur.key !== key) return;
  runActivity.value = null;
}

export function isRunActivityActive(key: string): boolean {
  return runActivity.value?.key === key;
}
