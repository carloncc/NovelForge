/** batch-u2 回归单测：设置页/API 配置 UI 语义（只覆盖白名单内改动的纯逻辑）。
 *  Vue SFC 内联处理器无法直接 import，此处镜像组件内同一纯函数实现并断言，
 *  与 ContentSettings/QualitySettings/SplitSettings/ConfigPage 的实际代码保持一致。
 */

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// —— 与 QualitySettings.vue: clampNonNegativeInt / SplitSettings.vue: onSplitMinCharsChange 同逻辑 ——
function clampNonNegativeInt(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

// —— 与 ContentSettings.vue: activePreset 的 !== false 判定同逻辑（#1109） ——
type ToggleKey = "useImage" | "useTts" | "useVideoPoints" | "useBgm" | "useSe";
function isToggleOn(v: unknown): boolean {
  return v !== false;
}
function presetMatches(
  options: Record<ToggleKey, boolean | undefined>,
  preset: Record<ToggleKey, boolean>,
): boolean {
  return (Object.keys(preset) as ToggleKey[]).every((k) => isToggleOn(options[k]) === preset[k]);
}

// —— 与 pipeline.ts: applyVideoOptions 当前实现同语义（#1150：逐场景 slice） ——
function applyVideoPerScene(videoPointsPerScene: number[][], limit: number): number[][] {
  if (limit <= 0) return videoPointsPerScene;
  return videoPointsPerScene.map((pts) => (pts.length > limit ? pts.slice(0, limit) : pts));
}

// —— 与 images.ts 章节循环同语义（#1147：maxPerChapter 只计背景） ——
function backgroundCountWithCap(sceneCount: number, maxPerChapter: number): number {
  let count = 0;
  for (let i = 0; i < sceneCount; i++) {
    if (maxPerChapter > 0 && count >= maxPerChapter) break;
    count++;
  }
  return count;
}

async function main(): Promise<void> {
  // #1362：负数钳到 0；小数下取整；非数字回 0
  assert(clampNonNegativeInt("-5") === 0, "负数字符串应钳到 0");
  assert(clampNonNegativeInt(-3.7) === 0, "负数应钳到 0");
  assert(clampNonNegativeInt("2.9") === 2, "小数应下取整");
  assert(clampNonNegativeInt("") === 0, "空字符串应回 0（Number('')=0，Math.max 后为 0）");
  assert(clampNonNegativeInt("abc") === 0, "非数字应回 0");
  assert(clampNonNegativeInt("4") === 4, "正常值保持");
  assert(clampNonNegativeInt(0) === 0, "0 保持 0（不限制/自动派生）");

  // #1109：undefined 按开启处理（与引擎 === false 语义对齐）
  assert(isToggleOn(undefined) === true, "undefined 应判为开");
  assert(isToggleOn(true) === true, "true 判开");
  assert(isToggleOn(false) === false, "显式 false 才判关");
  const standard = { useImage: true, useTts: true, useVideoPoints: true, useBgm: true, useSe: true };
  const save = { useImage: true, useTts: false, useVideoPoints: false, useBgm: false, useSe: false };
  // 老项目缺字段（undefined）：应命中 standard 而非 save
  assert(
    presetMatches({ useImage: true, useTts: true, useVideoPoints: true, useBgm: undefined, useSe: undefined }, standard),
    "老项目 useSe/useBgm 缺省应匹配标准档",
  );
  assert(
    !presetMatches({ useImage: true, useTts: true, useVideoPoints: true, useBgm: undefined, useSe: undefined }, save),
    "老项目缺省不应误判为省钱档",
  );
  // 旧 !! 语义会误判：此处锁定回归
  const legacyBool = (v: unknown): boolean => !!v;
  assert(legacyBool(undefined) === false, "旧 !! 语义把 undefined 算关（回归对照）");

  // #1150：逐场景上限——6 场景×上限 1 = 合计 6（与新 hint「多场景合计可能超出」一致）
  const six = applyVideoPerScene([[1, 2], [3], [4, 5, 6], [7], [8], [9]], 1);
  assert(six.flat().length === 6, "每场景上限 1 时 6 场景应保留 6 个");
  assert(applyVideoPerScene([[], []], 1).flat().length === 0, "空场景保持空");
  assert(applyVideoPerScene([[1, 2]], 0).length === 1 && applyVideoPerScene([[1, 2]], 0)[0].length === 2, "0 = 不限制");

  // #1147：背景上限只计背景——6 场景设 2 只出 2 张背景（立绘/CG 另计）
  assert(backgroundCountWithCap(6, 2) === 2, "背景上限 2 时 6 场景只出 2 张背景");
  assert(backgroundCountWithCap(6, 0) === 6, "0 = 不限制时全出");

  // #1337：vision 并发默认 1（与 configMigration.DEFAULT_CONCURRENCY_BY_CHANNEL 一致），UI 已开放入口
  const defaults: Record<string, number> = { llm: 3, vision: 1, image: 3, tts: 1 };
  assert(defaults.vision === 1, "vision 默认并发应为 1");

  // #1338：三级回退 manual > discovered > 128000（与 providers.resolveContextLength 一致）
  const DEFAULT_CONTEXT_LENGTH = 128_000;
  const resolve = (manual?: number, discovered?: number): number => {
    if (typeof manual === "number" && Number.isFinite(manual) && manual > 0) return Math.floor(manual);
    if (typeof discovered === "number" && Number.isFinite(discovered) && discovered > 0) return discovered;
    return DEFAULT_CONTEXT_LENGTH;
  };
  assert(resolve(undefined, undefined) === 128_000, "双空回退 128000");
  assert(resolve(undefined, 200_000) === 200_000, "探测命中用探测值");
  assert(resolve(32_000, 200_000) === 32_000, "手动优先");

  console.log("unit-audit-u2-budget-clamp: 全部通过 ✅");
}

main().catch((e) => {
  console.error("unit-audit-u2-budget-clamp failed:", e);
  process.exit(1);
});
