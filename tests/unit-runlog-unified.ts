/**
 * 运行日志「两条流合一」回归守门。
 *
 * 背景：项目里原本有两套互不相通的日志出口——
 *   ① logger.*（utils/logger.ts）→ 内存 history + 磁盘 novelforge.log + 侧栏运行日志面板
 *   ② pushLog(...)（stores/project.ts）→ projectState.logs（生成页「运行日志」tab）
 * 侧栏面板订阅的是 ①，于是走 ② 的阶段消息在侧栏和磁盘日志里全部不可见：
 * generate.ts 158 处、imageStory.ts 73 处、VisualBiblePanel.vue 29 处。
 * 用户排查时「日志里什么都没有」「怎么生成了 n 张图查不到」正是这个原因。
 *
 * 本测试锁住：pushLog 必须转投 logger，级别原样保留（success 不得退化成 info），
 * 且 step 作为 scope，取消订阅后不再收到。
 */
import { addLogListener, type LogEntry } from "../src/utils/logger";
import { pushLog } from "../src/stores/project";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const seen: LogEntry[] = [];
const off = addLogListener((entry) => seen.push(entry));

const probes = [
  { step: "分章", message: "统一出口探针 info", level: "info" },
  { step: "剧本", message: "统一出口探针 success", level: "success" },
  { step: "图像", message: "统一出口探针 warn", level: "warn" },
  { step: "配音", message: "统一出口探针 error", level: "error" },
] as const;

try {
  for (const p of probes) pushLog({ step: p.step, message: p.message, level: p.level, at: Date.now() });
} finally {
  off();
}

const byMessage = new Map(seen.map((e) => [e.message, e]));

for (const p of probes) {
  const hit = byMessage.get(p.message);
  assert(hit, `pushLog 的消息必须进入 logger 流（侧栏/磁盘日志同源），缺少「${p.message}」`);
  assert(hit.level === p.level, `pushLog 的 level 必须原样保留：${p.message} 期望 ${p.level}，实际 ${hit.level}`);
  assert(hit.scope === p.step, `pushLog 的 step 应作为 logger 的 scope：期望 ${p.step}，实际 ${hit.scope}`);
}

// 取消订阅后不得再收到：否则测试之间会互相污染
const before = seen.length;
pushLog({ step: "分章", message: "取消订阅后不应收到", level: "info", at: Date.now() });
assert(seen.length === before, "取消订阅后不应再收到日志");

console.log("=== 运行日志统一出口守门通过：pushLog 4 个级别全部进入 logger 流 ===");
