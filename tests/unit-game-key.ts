/**
 * #1105：Game_key 派生必须让不同标题得到不同 key（纯中文标题曾全部塌缩成同一个 key，跨作品串档），
 * 同一标题多次生成必须稳定，且始终满足导出页的 6-10 位字母数字校验。
 */
import { gameKeyFor } from "../src/core/project";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const titles = [
  "星陨之城",
  "星际迷航",
  "NovelForge-A",
  "NovelForge-B",
  "novelforge-a",
  "我的青春恋爱物语果然有问题",
  "第一章 测试",
  "《星陨之城》",
  "a",
  "ab",
  "abc",
  "abcd",
  "abcde",
  "αβγ",
  "",
];

const keys = titles.map((title) => gameKeyFor(title));

// 1) 稳定：同一标题重复生成完全一致
for (const title of titles) {
  assert(gameKeyFor(title) === gameKeyFor(title), `「${title}」的 key 不稳定`);
}

// 2) 格式：8 位字母数字（符合导出页 /^[a-zA-Z0-9]{6,10}$/）
for (const [i, key] of keys.entries()) {
  assert(/^[a-zA-Z0-9]{6,10}$/.test(key), `「${titles[i]}」产出非法 key：${key}`);
}

// 3) 不碰撞：不同标题必须得到不同 key（旧实现对纯中文恒为 nov2vna1，前 8 位同前缀的标题也碰撞）
const seen = new Map<string, string>();
for (const [i, key] of keys.entries()) {
  const prev = seen.get(key);
  assert(prev === undefined, `「${titles[i]}」与「${prev}」得到同一个 key：${key}`);
  seen.set(key, titles[i]);
}

// 4) 中文标题与纯符号标题也不得落到同一个 key
assert(gameKeyFor("星陨之城") !== gameKeyFor("星际迷航"), "中文标题碰撞");
assert(gameKeyFor("!@#$%^") !== gameKeyFor("……——"), "纯符号标题碰撞");

// 5) 保留可读前缀（ASCII 标题取前 4 位小写；纯中文走 nov2 前缀）
assert(gameKeyFor("NovelForge-A").startsWith("nove"), "ASCII 标题应保留可读前缀");
assert(gameKeyFor("星陨之城").startsWith("nov2"), "非 ASCII 标题应使用 nov2 前缀");

console.log("=== gameKeyFor（#1105）测试通过 ===");
