/**
 * 失败项列表（用户实测：点重试成功后报错仍挂在页面上）：
 * - failed.json 是事实来源，内存本次运行结果只做补充；
 * - 去重必须按「身份」而不是 id——图像 bg/cg 共用 scene.id，只按 id 去重会互相抵消。
 */
import { failedTaskIdentity, visibleFailedTasks, mergeFailedTasks } from "../src/core/failedTasks";
import type { FailedTask } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const bg: FailedTask = { id: "s1", kind: "image", step: "图像", message: "背景-s1：HTTP 429", at: 1 };
const cg: FailedTask = { id: "s1", kind: "image", step: "图像", message: "CG-s1：HTTP 500", at: 2 };
const scriptCh6: FailedTask = { id: "chapter_6", kind: "script", step: "剧本", message: "第 6 章：scenes 为空", at: 3 };

// 1) 身份区分：同 id 不同用途不互相抵消
assert(failedTaskIdentity(bg) !== failedTaskIdentity(cg), "bg/cg 身份必须区分");
assert(failedTaskIdentity(scriptCh6) === "script:chapter_6", "剧本身份应为 kind:id");

// 2) 磁盘与内存合并：同身份去重（磁盘为准）
const merged = visibleFailedTasks([bg, scriptCh6], [{ ...bg, at: 9 }, cg]);
assert(merged.length === 3, `应按身份合并为 3 条，实际 ${merged.length}`);
assert(merged.find((f) => failedTaskIdentity(f) === "image:s1:bg")?.at === 1, "磁盘条目优先（内存重复不覆盖）");
assert(merged.some((f) => failedTaskIdentity(f) === "image:s1:cg"), "cg 失败不应被 bg 抵消");

// 3) 重试成功后（failed.json 已移除该条）：列表不再出现
const afterRetry = visibleFailedTasks([cg], []);
assert(afterRetry.length === 1 && failedTaskIdentity(afterRetry[0]) === "image:s1:cg", "已修复的失败项应从列表消失");

// 4) 运行中内存新增（管线刚记录、尚未落盘）：仍要显示
const withFresh = visibleFailedTasks([], [scriptCh6]);
assert(withFresh.length === 1, "本次运行的新失败应立即可见");

// 5) mergeFailedTasks：同身份保留最新
const latest = mergeFailedTasks([bg], [{ ...bg, message: "背景-s1：重试失败", at: 8 }]);
assert(latest.length === 1 && latest[0].at === 8, "merge 应保留最新一条");

console.log("=== failed tasks list tests passed ===");
