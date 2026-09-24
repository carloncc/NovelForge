/**
 * nb-nE 修复包纯函数回归（#1403/#1435-#1439）：
 * 只覆盖 src/core/imageStory.ts 新增纯函数，不碰 tauri/磁盘/Vue。
 */
import {
  isPaidTranslateAllowed,
  mergeImageStoryLogs,
  shouldBlockAssembleOnZeroShots,
  shouldRunPostScriptStages,
  shouldShowShotsTotalCapHint,
} from "../src/core/imageStory";
import type { PipelineEvent } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ev(at: number, step: string, message: string, level: PipelineEvent["level"] = "info"): PipelineEvent {
  return { step, message, level, at };
}

// #1403：封顶提示只在「设了上限 + 有缺失」时出现
{
  assert(shouldShowShotsTotalCapHint(10, 3) === true, "#1403 上限>0且有缺失应提示");
  assert(shouldShowShotsTotalCapHint(0, 3) === false, "#1403 不限上限时不应提示");
  assert(shouldShowShotsTotalCapHint(10, 0) === false, "#1403 无缺失时不应提示");
  assert(shouldShowShotsTotalCapHint(0, 0) === false, "#1403 全0时不应提示");
}

// #1435：载入期禁止付费翻译，只有 run 阶段允许
{
  assert(isPaidTranslateAllowed("load") === false, "#1435 load 路径必须禁止付费翻译");
  assert(isPaidTranslateAllowed("run") === true, "#1435 run 阶段允许付费翻译");
}

// #1436：零图阻断组装（新产出 0 且缓存 0 才拦；有缓存旧图可组装）
{
  assert(shouldBlockAssembleOnZeroShots(0, 0) === true, "#1436 0产出+0缓存应阻断");
  assert(shouldBlockAssembleOnZeroShots(0, 5) === false, "#1436 有缓存旧图时不应阻断");
  assert(shouldBlockAssembleOnZeroShots(3, 0) === false, "#1436 本轮有产出时不应阻断");
  assert(shouldBlockAssembleOnZeroShots(2, 4) === false, "#1436 都有时不应阻断");
}

// #1437：停止后不进图片/组装（与 runImageStory 同口径 !abortFlag && chapters>0）
{
  assert(shouldRunPostScriptStages(false, 3) === true, "#1437 未停止且有章应继续");
  assert(shouldRunPostScriptStages(true, 3) === false, "#1437 已停止不应继续（防假成功/假失败项）");
  assert(shouldRunPostScriptStages(false, 0) === false, "#1437 无章不应继续");
  assert(shouldRunPostScriptStages(true, 0) === false, "#1437 停止+无章不应继续");
}

// #1439：合并保历史（磁盘历史 + 内存新条目去重；pushLog-before-sync 不丢历史；flush 不再整文件覆写清历史）
{
  const disk = [ev(1, "运行", "历史A"), ev(2, "剧本", "历史B", "success")];
  const mem = [ev(3, "项目", "新条目C", "warn")];
  const merged = mergeImageStoryLogs(disk, mem, 2000);
  assert(merged.length === 3, `#1439 合并应保留历史+新条目，实际 ${merged.length}`);
  assert(merged[0].message === "历史A" && merged[2].message === "新条目C", "#1439 顺序应为历史在前、新条目在后");

  // 去重：内存里已有磁盘条目不再重复
  const dup = mergeImageStoryLogs(disk, [ev(1, "运行", "历史A"), ev(4, "运行", "新D")], 2000);
  assert(dup.length === 3, `#1439 重复条目应去重，实际 ${dup.length}`);

  // 空内存时原样返回磁盘历史（目录切换后 refresh 不丢历史）
  const onlyDisk = mergeImageStoryLogs(disk, [], 2000);
  assert(onlyDisk.length === 2, "#1439 空内存应保留磁盘历史");

  // 限长截断（只留尾部）
  const long = mergeImageStoryLogs(disk, mem, 2);
  assert(long.length === 2 && long[1].message === "新条目C", "#1439 超限应截断保留尾部");
}

console.log("=== nb-ne fixpack tests passed ===");
