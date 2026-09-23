/**
 * lint 结构化分类码（#1311）：中文子串匹配只收敛在 lintIssueCode 一个函数里；
 * 分类漂移时单测先报警，而不是线上静默错分。
 */
import { lintIssueCode, classifyLintErrors } from "../src/core/lint";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(lintIssueCode("素材(背景)", "x 引用缺失") === "missing-asset", "素材 scope 应判缺失");
assert(lintIssueCode("语法", "配音缺失：xxx") === "missing-asset", "配音缺失标记应判缺失");
assert(lintIssueCode("结构", "缺少 start.txt") === "fixable", "结构问题应判可修复");
assert(lintIssueCode("素材", "引用缺失") === "missing-asset", "双信号一致");

const coded = [
  { level: "error" as const, scope: "素材(背景)", message: "bg 引用缺失", code: "missing-asset" as const },
  { level: "error" as const, scope: "结构", message: "缺少 start.txt", code: "fixable" as const },
];
const r1 = classifyLintErrors(coded);
assert(r1.missingAsset.length === 1 && r1.fixable.length === 1, "有码数据应直接读码");

// 老数据（无 code）回退旧口径，不丢分类
const legacy = [
  { level: "error" as const, scope: "素材(立绘)", message: "figure 引用缺失" },
  { level: "error" as const, scope: "跳转", message: "changeScene 目标不存在" },
];
const r2 = classifyLintErrors(legacy);
assert(r2.missingAsset.length === 1 && r2.fixable.length === 1, "无码数据应回退旧口径");

console.log("lint 结构化分类测试通过");
