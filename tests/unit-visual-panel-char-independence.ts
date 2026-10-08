import { readFileSync } from "node:fs";

/**
 * 视觉守门面板：角色级操作互相独立 + 批准错误聚合 的源码契约回归。
 *
 * 为什么用源码断言而不是渲染测试：本仓库单测是纯 Node + tsx，没有 jsdom/vitest 渲染环境
 * （与 unit-a11y-contract.ts 同一理由）。而这两件事恰恰属于「模板里改一个 disabled 表达式就
 * 静默退化、没有任何运行时报错」的类型：
 *   - 点某个角色的「重新生成三视图」，其余 24 个角色的按钮全部变灰
 *     （用户原话：重新生成一个，其他就没法生成）；
 *   - 25 个角色各渲染一条「…尚未确认」，批准条变成一堵 25 行的墙。
 */

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const panel = readFileSync("src/components/VisualBiblePanel.vue", "utf-8");
const keyList = readFileSync("scripts/i18n-keys.txt", "utf-8");
const AGG_KEY = "{n} 个角色的三视图尚未确认：{names}";

function main(): void {
  // ---- 角色级并发：多槽集合，而不是所有角色共用单槽 ----
  assert(
    panel.includes("const charBusy = ref<Set<string>>(new Set())"),
    "角色级任务必须用集合存多个 key——单槽在并发时会被先完成的一方清空，spinner 与禁用态互相覆盖",
  );
  assert(
    panel.includes("function markCharBusy(") && panel.includes("function clearCharBusy("),
    "角色级 key 必须经 markCharBusy / clearCharBusy 管理",
  );
  for (const key of ["char-ref:", "char-sheet:", "char-desc:", "char-accept:", "char-sheet-ct:"]) {
    assert(
      !panel.includes("busyKey.value = `" + key),
      "角色级 key " + key + " 不得再占用全局 busyKey 单槽（否则一个角色在跑会锁住全部角色）",
    );
  }

  // ---- 角色行按钮只受全局任务影响，不受其他角色影响 ----
  const perCharGated = panel
    .split("\n")
    .filter((line) => line.includes("charRowLocked || isCharBusyFor(row.id)"));
  assert(
    perCharGated.length >= 4,
    "角色行的 4 个按钮（重新生成三视图/确认此角色/服装锚点/重新生成描述）都必须用 " +
      "charRowLocked || isCharBusyFor(row.id) 判定，实际 " + perCharGated.length + " 个",
  );
  assert(
    /const runLocked = computed\(\(\) => [^\n]*charBusy\.value\.size > 0/.test(panel),
    "全局按钮（批准/同步/全局重生成）仍必须等所有角色任务结束——独立性只给角色行按钮",
  );
  assert(
    panel.includes("&& charBusy.value.size === 0"),
    "批准必须等所有角色任务结束，否则会带着半套数据盖章",
  );

  // ---- 批准错误聚合 ----
  assert(panel.includes("ACCEPT_ERROR_KEY"), "批准错误必须按 key 归类，否则 25 条重复错误逐条刷屏");
  assert(
    panel.includes('"' + AGG_KEY + '"'),
    "重复的「尚未确认」必须收成一条带角色名的汇总",
  );
  assert(keyList.includes(AGG_KEY), "聚合文案必须在 scripts/i18n-keys.txt 里登记");
  for (const lang of ["zh-TW", "en", "ja", "ko"]) {
    const dict = readFileSync("src/i18n/" + lang + ".ts", "utf-8");
    assert(dict.includes(AGG_KEY), lang + " 词典缺聚合文案");
  }

  console.log("=== 视觉守门面板：角色独立重生成 + 批准错误聚合 契约通过 ===");
}

main();
