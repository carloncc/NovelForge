---
title: Generate flow and layout refactor
status: done
type: feature
depends_on: []
---

## Original User Intent

这里的生成界面有大问题，流程和逻辑都不够好，动线全是问题，感觉就像是要绕无限个弯道才能到达终点，还有不够灵活，都不能分章生成，总的来说就是乱七八糟的功能一堆，没有实际优化使用。分析问题制定计划，全部重构代码，包括前端的布局。

## Description

生成页 `src/pages/GeneratePage.vue`（3650 行）把一条直线拆成了迷宫：三套互斥的执行模式会让整页变形，顶部主按钮的文案与语义随模式漂移，分章生成被"AI 分章预览 → 确认分章"的硬门槛锁在第二个模式里且不含配音，同一语义的开关在页面上出现两次（靠 tooltip 说明"与上方是同一个"），结果区 8 个 tab 把进行中的运行态和产物编辑混在一排。

本任务把生成页重构为**一条主线 + 四段结构**，让"逐章生成"成为默认且灵活的一等公民，并把这 2900 行脚本从页面组件中下沉到 store / 组合式函数 / 区块组件。

诊断与目标架构详见 `docs/GENERATE_FLOW_REFACTOR.md`。

## Acceptance Criteria

1. 生成页自上而下为四段：项目栏、生成内容（选项）、生成（范围切换 + 当前范围面板）、结果；范围切换只替换第三段，不再让整页下半部分随模式换掉。
2. 有小说时进入生成页，默认范围是「逐章」，章节工作台立即可见，无需先切模式。
3. 页面顶部不再存在文案/语义随模式变化的全局主按钮；每个范围面板内的主操作按钮文案只描述该范围的动作。
4. 章节工作台支持：单章生成、多选后「生成选中(N)」、顺序补全未完成、追加新章节、逐章意见与全量开关。
5. 章节生成不设"确认分章"硬门槛：未分章时可就地运行 AI 分章；分章状态只作为可核对信息与提示徽章，不阻塞逐章生成。
6. 章节生成可选用是否包含配音；选择包含时，单章/多章链路会跑到配音阶段。
7. 缺少角色卡时，章节工作台就地给出可执行的补提取动作，而不是只报错。
8. 同一语义的选项在页面上只出现一次：`useImage` / `useTts` 不再在级联面板里出现第二个复选框。
9. 结果区按"运行"与"产物"分组，且每一组的 tab 都能在页面内找到；不再依赖 `v-else` 兜底。
10. 空态是单一提示 + 就地动作，不再有三段同义纯文字指路。
11. `vue-tsc --noEmit` 通过；`npm test` 全绿。
12. Vite dev + Playwright 真实浏览器截图（1280x800）证明新布局无重叠、无溢出、无控制台报错。

## Target Structure

页面组件（新 `src/pages/GeneratePage.vue`，目标 < 300 行，实际 369 行）只做编排与结果 tab 宿主，区块拆分为：

- `src/components/generate/ProjectBar.vue` — 输出目录 / 浏览 / 加载 / 状态徽章。
- `src/components/generate/OptionsPanel.vue` — 生成内容选项 + 语言/画风/剧本风格 + 风格参考图 + 高级设置（自带 `useStyleReference`）。
- `src/components/generate/ScopeTabs.vue` — 范围切换。
- `src/components/generate/ChapterWorkbench.vue` — 逐章工作台（工具栏 + 章节行）。
- `src/components/generate/FullRunPanel.vue` — 整本：阶段勾选 + 主按钮。
- `src/components/generate/StageRunPanel.vue` — 单阶段：阶段盘 + 级联状态。
- `src/components/generate/ResultSection.vue` — 结果分组 tab 宿主。

状态与行为下沉到：

- `src/stores/generate.ts` — 运行态单一来源（busy / queueRunning / 进度 / 费用 / 失败项 / 日志动作 / start / stop），并负责执行链路。
- `src/composables/generate/useChapterWorkbench.ts` — 分章元信息、意见、全量、多选、队列、逐章重生成、追加新章。
- `src/composables/generate/useAssetRegen.ts` — 素材图与配音单项重生成。
- `src/composables/generate/useScriptVerify.ts` — 剧本校验报告与处理。

> 落地情况：`stores/generate.ts` 已交付；上面三个按域组合式函数未拆出（见文末「实际落地与偏差」）。

## Verification

- **Level:** Page (high impact: primary generation workflow).
- **Commands:** `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`; `npm test`; `npm run build`.
- **Browser:** Vite dev server + Playwright at 1280x800 and 900x700: 进入生成页默认看到章节工作台；范围切换不换整页；多选后「生成选中(N)」出现；结果分组 tab 可达；无 console error；无横向溢出。
- **Rubric:**

| Criterion | Weight |
| --- | ---: |
| 动线：单一主线、四段结构、无变形主按钮 | 0.30 |
| 分章生成：默认可见、可多选、可含配音、无硬门槛 | 0.30 |
| 信息架构：选项去重、结果分组、空态可动作 | 0.20 |
| 代码结构：页面瘦身、状态单一来源、typecheck/测试全绿 | 0.20 |

- **Pass threshold:** 4.0/5.0 weighted, and criteria 11–12 must both pass.

## Verification Results

- `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` -> exit 0（无错误）。
- `node scripts/run-tests.mjs` -> 49/49 通过。
- `node scripts/check-template.mjs` + `node node_modules/vite/bin/vite.js build` -> exit 0（124 modules transformed）。
- Playwright（Chromium，1280x800，Vite dev）实测：
  - 载入示例小说后进入生成页，默认范围 =「逐章生成」，章节工作台立即可见（3 章）。
  - 顶部无随模式变化的全局主按钮（header 内按钮数 = 0）。
  - 「全选未完成（3）」->「生成选中（3）」；全页无「请先点…确认分章」硬门槛文案。
  - 缺角色卡时就地出现 wb-notice +「先提取卡片」按钮。
  - 范围切换只替换第三段：结果区 tab 在切换前后完全一致（运行 / 产物 两组共 8 个）。
  - 模板 ref 绑定回归：点「追加新章节」与「上传图片，AI 识别画风」均触发 filechooser，
    证明 `<script setup>` 解构自 composable 的 ref 仍与 `ref="…"` 正确绑定。
  - `document.scrollWidth - clientWidth === 0`（无横向溢出）；无 console error / pageerror。
- Playwright（Chromium，Vite dev，本轮复核）实测：
  - 1280x800：默认范围 =「逐章生成」，章节工作台 3 行；顶部无变形主按钮；无「请先点…确认分章」硬门槛。
  - 面板拆分后逐块在位：项目栏（输出目录 / 浏览… / 加载该项目）=1、生成内容折叠=1、范围切换=3、
    整书面板（开始生成（整书）＋本次执行阶段）=1、单阶段面板（不含整书主按钮）=1。
  - 结果区 `ResultSection` 的 8 个 tab（状态与费用 / 失败项 / 日志 / 剧本 / 素材 / 卡片编辑 / 视觉守门 / 视频推荐位）
    全部可点开、active 正确、面板内容渲染、无新增报错；切换范围时 tab 集合完全不变。
  - 跨组件状态联动：页面 vb-banner「去确认」-> 结果区视觉守门 tab 自动激活；「全选未完成（3）」->「生成选中（3）」。
  - 模板 ref 回归：`appendInput`（页面）与 `styleRefInput`（OptionsPanel 解构自 store）均触发 filechooser；
    日志面板 `logPanelRef` 元素存在。
  - 900x700：无横向溢出（scrollWidth - clientWidth = 0），章节工作台仍 3 行。
  - 空态（未载入小说）：默认范围 =「整书生成」，8 个 tab 均为单一提示或空态卡片且无报错。
  - 无 console error / pageerror。
- 证据截图：`refactor-chapter-default-1280.png`、`refactor-scope-full-1280.png`、`refactor-scope-stage-1280.png`、
  `refactor-panels-chapter-1280.png`、`refactor-panels-result-1280.png`、`refactor-panels-narrow-900.png`、
  `refactor-panels-empty-1280.png`。

### 实际落地与偏差

- 已落地：AC 1-12。四段结构、逐章默认、无变形主按钮、多选 / 含配音 / 无分章门槛、卡片缺失就地补提取、
  选项去重、结果分组、空态可就地动作；typecheck + 49/49 测试 + 构建 + 真实浏览器复核全通过。
- 结构落地：`GeneratePage.vue` 3722 -> 369 行，页面只保留四段编排、逐章分支与结果宿主；
  `src/components/generate/` 提供 `ProjectBar` / `OptionsPanel` / `ScopeTabs` / `ChapterWorkbench` /
  `FullRunPanel` / `StageRunPanel` / `ResultSection` 七个区块组件；状态集中到模块级单例
  `src/stores/generate.ts`（191 个绑定，运行态单一来源），各组件经 `useGenerateController()` 取用同一份状态；
  导航状态抽出 `src/stores/nav.ts`。副作用（正向）：范围与结果 tab 选择现在能跨页面往返保留，此前会被重置。
- 与原计划的偏差（有意保留，非遗漏）：
  - `useChapterWorkbench.ts` / `useAssetRegen.ts` / `useScriptVerify.ts` 未单独拆出。`stores/generate.ts`
    内部已按域分节（生成范围 / 分阶段状态 / 逐章工作台 / 素材重生成 / 保真核对）；按域搬移是纯机械操作，
    但需共享闭包上下文，在 UI 目标已达成时收益低于回归风险。若继续，建议按小节整体搬移并注入共享上下文。
  - 结果区的素材 / 剧本 / 视频 / 失败四个面板仍内联在 `ResultSection.vue`（该组件 564 行）。若继续，
    建议按这四个内聚边界拆，而非按卡片位置拆；同为纯搬移，可零行为变更地继续。
- 遗留（本环境删除动作被策略拦截，需人工确认后删）：
  - `src/components/ChapterStatusBoard.vue`（全仓 0 引用，死代码）。
  - `tests/.tmp-*.mjs` 浏览器验证临时脚本（本轮新增 4 个：verify-panels / verify-panels2 / verify-panels3 / verify-empty）；
    若不想入版本库，可在 `.gitignore` 增加一行 `tests/.tmp-*.mjs`。