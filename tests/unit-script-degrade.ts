/**
 * 自适应降级（第 2 章 503/超时事件复盘）：
 * - isServerClassFailure：429/5xx/总超时判 true（触发拆分降级），鉴权/参数/审查/空结果判 false；
 * - splitNovelForAgent 对半拆：无损、可按段落切成两块。
 */
import { isServerClassFailure, splitForDegrade } from "../src/core/script";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) 服务端过载/超时类 ---------- */
assert(isServerClassFailure({ status: 503, message: "HTTP 503" }), "503 对象应判服务端类");
assert(isServerClassFailure({ status: 429, message: "HTTP 429" }), "429 对象应判服务端类");
assert(isServerClassFailure({ status: 504, message: "HTTP 504" }), "504 对象应判服务端类");
assert(
  isServerClassFailure("请求失败: error sending request for url (https://x/v1/chat/completions)"),
  "总超时（reqwest 文案）应判服务端类",
);
assert(isServerClassFailure(new Error("operation timed out")), "超时 Error 应判服务端类");
assert(isServerClassFailure("HTTP 500"), "500 文本应判服务端类");

/* ---------- 2) 非服务端类（不得触发拆分） ---------- */
assert(!isServerClassFailure({ status: 401, message: "unauthorized" }), "401 不得判服务端类");
assert(!isServerClassFailure(new Error("参数错误：模型不存在")), "参数错误不得判服务端类");
assert(!isServerClassFailure(new Error("内容审查：未通过")), "内容审查不得判服务端类");
assert(
  !isServerClassFailure(new Error("第 2 章剧本未产出任何场景：模型返回无 scenes")),
  "空结果错误不得判服务端类（脚本层已带提示重试过）",
);
assert(!isServerClassFailure("已中止"), "中止不得判服务端类");

/* ---------- 3) 降级拆分：对半、无损、无微型块 ---------- */
const para = "林澈拔剑，剑光如雪。\n\n夜风骤起，吹动衣袂。\n\n";
const big = para.repeat(2500); // 约 3 万字章节体量（第 2 章量级）
const halves = splitForDegrade(big);
assert(halves.length === 2, `3 万字应拆成 2 块，实际 ${halves.length}`);
assert(halves.join("") === big, "拆分必须无损（join 还原原文）");
assert(
  Math.abs(halves[0].length - halves[1].length) < big.length * 0.1,
  "两块大小应接近对半",
);
assert(halves.every((h) => h.trim().length >= 2000), "不得有微型块（避免无正文请求）");

console.log("自适应降级判定测试通过");
