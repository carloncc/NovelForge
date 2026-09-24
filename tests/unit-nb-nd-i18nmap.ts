/**
 * nb-nD 1409（英文直出 → 中文映射）回归单测：
 * core 原英文字符串保持不变（测试/日志口径依赖），新增映射表把批准链路报错转中文 t() key。
 * i18n 词典禁区未动——本文件断言的 key 即待补翻译清单（中文原文即 key），见最终上报。
 */
import { localizeVisualBibleApprovalError, localizeVisualBibleApprovalErrors } from "../src/core/visualBible";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testMappings(): void {
  const cases: [string, string][] = [
    ["Style description is empty", "风格描述为空，请先填写风格描述"],
    ["Character alice is missing from the visual bible", "角色「{id}」在视觉守门中缺失，请先同步卡片或重建草稿"],
    ["Character alice has not been accepted", "角色「{id}」的三视图尚未确认，请先点「确认此角色」"],
    [
      "Character alice three-view does not match the current source revision",
      "角色「{id}」的三视图与当前参考图版本不一致，请重新生成三视图",
    ],
    ["Visual bible fingerprint is empty or stale; refresh the draft before approval", "视觉守门指纹已过期，请点「刷新指纹」后重试"],
  ];
  for (const [input, key] of cases) {
    const out = localizeVisualBibleApprovalError(input);
    assert(out.key === key, `映射缺失：${input} → ${out.key}`);
    assert(out.fallback === input, "fallback 必须保留英文原文");
  }
  const id = localizeVisualBibleApprovalError("Character alice has not been accepted");
  assert(id.params?.id === "alice", "必须抽出角色 id 参数");
  const detail = localizeVisualBibleApprovalError("Visual bible cannot be approved: Character alice has not been accepted");
  assert(detail.key === "视觉守门暂不能批准：{detail}", "批准聚合错误应映射");
  assert(String(detail.params?.detail).includes("alice"), "聚合错误的 detail 应保留");
  const stale = localizeVisualBibleApprovalError("Approved visual bible is stale: Character bob three-view is missing: x.png");
  assert(stale.key === "已批准的视觉守门已失效：{detail}", "失效警告应映射");
  const unknown = localizeVisualBibleApprovalError("some future english error 123");
  assert(unknown.key === unknown.fallback, "未知错误应原样透出（不编造翻译）");
}

function testBatch(): void {
  const out = localizeVisualBibleApprovalErrors(["Style description is empty", "nope"]);
  assert(out.length === 2 && out[0].key.startsWith("风格描述为空"), "批量映射应保持顺序");
}

async function main(): Promise<void> {
  testMappings();
  testBatch();
  console.log("=== nb-nD i18nmap (1409) unit tests passed ===");
}

main().catch((error) => {
  console.error("nb-nD i18nmap unit tests failed:", error);
  process.exit(1);
});
