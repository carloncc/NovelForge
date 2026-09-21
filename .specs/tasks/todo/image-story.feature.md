---
title: 图片小说（纯图片模式）v1 开发计划
reqflow: "#803（父）/#804–#813（子任务）/#814（已确认决策）"
---

## Initial User Prompt

追加一个「纯图片模式」——不用人物立绘 / 人物 UI，全屏图片随对话在合适位置切换，每个图片代表当前对话的场景；且必须是独立页面、独立入口（左侧菜单栏多一个生成位置），与现有「生成项目」页分开，防止混淆。

## Description

**目标**：新增与「立绘版」并列的第二种产出模式——「图片小说」。同一本小说（复用分章）经独立的分镜剧本、独立的图片通道、独立的组装目录，产出一个「全屏图片随对话淡入切换、无任何立绘/人物演出 UI、保留文本框与人名框」的可玩 WebGAL 游戏；随后可在新页面内直接预览与导出。

**为什么值得做**：立绘版依赖角色三视图/表情/动作/服装一致性，链路长、成本高；纯图片版用「每场景若干张全屏插画」承载画面，对人物差分要求低、对地图/行旅/任务推进类章节的还原度更好，且适合没有立绘素材的题材。

**Scope**

- Included：
  - 侧栏新入口「图片小说」（异步组件），独立页面、独立状态、独立输出目录 `<用户所选目录>/<书名>-图片版/`。
  - 原文与分章复用主项目（同一本小说只导入/分章一次）；提取 / 分镜剧本 / 图片 / 组装 / 导出全部独立。
  - `Shot` 数据类型与分镜版剧本通道（每场景 0–N 个 shot、`triggerLineIndex` 切换点、英文插画 prompt）。
  - 图片通道：角色三视图作为一致性参考（图生图）＋ 分镜图；跳过立绘/表情/动作/服装差分；不做抠图。
  - 渲染分支：跳过 `changeFigure` 全家族；按 `triggerLineIndex` 淡入切换全屏图；保留文本框/人名/BGM/SE/选项/intro。
  - 独立组装与导出：`game/scene/*.txt`、`game/background/shot_*.png`、flowchart/theme/HOW_TO_PLAY/build.json；预览与 zip 导出复用现有 Rust 预览服务与 `build_zip`。
  - 三个费用旋钮（每场景张数 / 每章上限 / 总张数或预算上限）＋ 实时预计张数与费用、运行中累计张数与费用。
  - i18n 五语言、单测与文档（README/CHANGELOG/架构文档）。
- Excluded：
  - 不改造现有预览页/导出页（新页面自带入口，指向图片版目录）。
  - 不做机械的「每 N 句切图」（#814 已否决）。
  - 不动立绘版的渲染/图像/组装行为（除共享模块的显式模式参数外）。
  - 不做视频生成、Live2D、多语言配音等既有排期项。

**User Scenarios**

1. **Primary Flow**：导入小说 →（主项目已分章则直接复用）→ 打开「图片小说」→ 设置三个张数旋钮与画风 → 页面显示「预计 N 张 ≈ X 元」→ 开始生成 → 可见进度（章节 + 分镜 x/y）与累计费用 → 生成完成后在结果区分镜网格翻阅/单张重生成 → 点「预览」试玩（全屏图随对话淡入、无立绘）→ 导出 zip。
2. **Alternative Flow**：只跑部分章节 / 中途到上限暂停 → 提高上限后「继续跑」（保留已完成产物，不重画）。
3. **Error Handling**：角色三视图缺失或失败 → 记失败项并可重试，不静默降级为纯文生图；图片 API 未配置 → 页面明确提示并禁用生成；分镜数据非法（prompt 空/triggerLineIndex 越界）→ 不写入剧本缓存、整章判失败可重跑。

## 已确认决策（#814 快照，实施依据）

| # | 决策 | 落地口径 |
|---|------|----------|
| 1 | 侧栏命名与位置 | 「图片小说」，放在「生成项目」下方 |
| 2 | 独立程度 | 原文与分章复用；提取/剧本/图片/组装全部独立 |
| 3 | 输出目录 | `<用户所选目录>/<书名>-图片版/`，自带 `.novel2vn/`，与立绘版互不覆盖 |
| 4 | 分镜粒度与张数 | 默认「不限」（由剧本模型按剧情决定）；提供三个旋钮：每场景张数 / 每章上限（0=不限）/ 总张数或预算上限（到上限暂停可续跑）；不做「每 N 句一张」 |
| 5 | 图片必须含角色 | 靠画面判断说话人 |
| 6 | 保留文本框与人名框 | 仅去掉立绘与人物演出 UI |
| 7 | 角色一致性 | 三视图方案：先生成角色三视图/设定图，所有 shot 以其为 identity 参考做图生图 |
| 8 | 预览/导出入口 | 新页面自带，指向图片版目录 |
| 9 | 切换过渡 | 只淡入 `changeBg:<shot> -duration=400 -ease=easeInOut`，不推近 |

**成本提醒**：因默认不设张数上限，实际费用由模型输出张数决定；页面必须实时显示预计/实际张数与费用（#812）。

## Architecture Overview

### Solution Strategy（分批、每批可独立验收）

> 前置说明：本计划依赖的三项基础已在 2026-09-20 的修复批次落地——`scriptFingerprint({ style, compressNarration, visualMode })` 统一实现（#802，已预留 visualMode 位）、跨章演出状态复位（#789）、旁白压缩开关（#801，图片版默认关闭＝忠实全文）。图片总账统计 `src/core/imageStats.ts`（生成前张数计算）可直接复用到新页面的费用预估。

- **P1 骨架与类型（子任务 1/2/3，纯新增，不动现有链路）**
  - `src/stores/nav.ts`：`PageId` 增加 `"imageStory"`；`src/App.vue` 注册异步页面与图标；侧栏入口名入词典。
  - 运行指示口径（子任务 1 的三选一，本计划内定）：**新页面自带局部运行指示与失败徽标；侧栏保持只反映现有 generate 链路**，避免两套控制器争用同一状态源。
  - `src/stores/imageStory.ts`：独立 store（novel/cards/outputDir/options/lastResult/logs/failedTasks/running/abort + run()/stop()），独立持久化到图片版目录 `.novel2vn/`；API 配置只读复用现有 presets。
  - `src/core/types.ts`：`Shot`、`SceneJSON.shots`、`ImageTask.kind: "shot"`、`RenderAssets.shot`、`ImageStoryOptions`（分镜旋钮/画风/种子/自检/语言/是否生成物品图/过渡开关）。
  - 验收：`vue-tsc` 零错；侧栏出现入口；空状态页可打开；现有页面行为与缓存不变。

- **P2 分镜剧本通道（子任务 4）**
  - `src/core/script.ts`：`scriptChapter` 增加 `mode: "sprite" | "imageOnly"`（或分镜版 SYSTEM_PROMPT 常量），imageOnly 下每个场景产出 `shots[]`（英文 prompt：角色外貌/服装/表情/动作 + 场景 + 构图 + 16:9、非绿幕、整幅插画；`triggerLineIndex` 指向切换句）；用户「每场景张数」旋钮注入提示词（0=不限按剧情）。
  - `src/core/dataValidation.ts`：shots 校验（prompt 非空、triggerLineIndex 为 `lines` 范围内整数、id 唯一、超上限告警）；坏数据不写入剧本缓存。
  - 缓存键：`scriptFingerprint({ style, compressNarration, visualMode: "imageOnly" })`（已就绪）；保真策略沿用「忠实全文」默认。
  - 裁剪口径：每章上限 / 总量上限由代码侧裁剪并**告警**，不允许静默丢弃（#807 补充）。
  - 验收：单测（校验）＋ 提示词断言（旋钮注入）；同一章节 spritet/imageOnly 指纹不同、缓存互不命中。

- **P3 图像通道（子任务 6，按 #814 决策 7 修正 #809 的表述）**
  - `src/core/images.ts` 的 `buildImageTasks` 增加 imageOnly 分支：任务集合 = 角色三视图（identity 参考，必需） ＋ 每场景 `shots`（`kind:"shot"`，1536×1024，非绿幕） ＋ 物品图（可选，默认关）；**不生成** 立绘/表情/动作/服装差分；**不做抠图**。
  - 一致性：`kind:"shot"` 一律以「出场角色三视图」为 identity 参考做图生图；三视图缺失/失败 → 失败项 + 重试，**不静默降级**（参照 #655 教训）。
  - 三个旋钮：`shotsPerScene`（0=不限）/ `shotsPerChapter`（0=不限）/ `shotsTotal`（0=不限；到上限停止派发新任务并提示，可提高上限续跑）。
  - 缓存/重试/自检/成本统计沿用现有 `cacheHit`/`runImageTask` 链路；产出记入 `assets.shot`。
  - 完成判定与看板只统计 shot 任务集合（与立绘版分开，避免互相判绿）。
  - 验收：`unit-image-story-tasks`（任务数、无 threeview 之外的人物差分、旋钮裁剪与告警）。

- **P4 渲染分支与组装（子任务 7/8）**
  - `src/core/render.ts` imageOnly 分支：跳过 `changeFigure`（含 none 清场）/入场退场动画/`setTempAnimation`/立绘 `setTransform`/舞台插槽/`miniAvatar`/登场资料卡立绘；按 `shot.triggerLineIndex` 输出 `changeBg:<shot> -duration=400 -ease=easeInOut -next;`（只淡入）；无 shot 的场景回退背景图；保留章节标题卡/文本框/人名/BGM/SE/`unlockCg`（分镜入鉴赏室）/`choose` 分支/intro；跨章复位沿用现有输出。
  - `src/core/project.ts`：`assembleProject` 支持 imageOnly（复制模板、渲染剧本、复制 shots 到 `game/background/`、写 config/flowchart/theme/HOW_TO_PLAY/build.json、生成 meta）；输出根目录为图片版独立目录；分镜命名 `shot_ch<章>_<场景id>_<序号>.png`（`sanitizeId` 消毒，与 `assets.shot` 键一致）。
  - `src/core/lint.ts`：校验 `changeBg` 引用的 shot 文件存在；imageOnly 下不误报立绘引用。
  - 鉴赏室：新增「分镜」分组（或并入 CG 画廊并按章节筛选），沿用 5 语 I18N。
  - 预览/导出：复用现有 Rust 预览服务与 `build_zip`/网页版 zip 链路，仅换 sourceDir。
  - 验收：`unit-image-story-render`（无立绘指令、按 trigger 切换）＋ 组装产物清单核对。

- **P5 页面 UI（子任务 9）**
  - `src/pages/ImageStoryPage.vue`（异步加载，沿用生成页的「任务在前、配置折叠」版式）：
    - 顶部项目栏：输出目录选择/加载、原文导入（复用 ImportPage 结果或内嵌入口）、分章状态（复用主项目分章）。
    - 选项面板：三个张数旋钮 ＋ 画风/固定种子/是否自检/目标语言/是否生成物品图/过渡开关。
    - 费用预估：按「章节数 × 场景数 × 每场景张数 × 单价」实时估算（单价取现有 `DEFAULT_PRICES.imageYuanEach` 或配置项），设置变更即时刷新；开始前给出总量提示。
    - 运行区：开始/停止、进度（当前章节 + 分镜 x/y）、实时日志（复用现有日志组件样式）。
    - 结果区：分镜网格（按章节分组、懒加载缩略图、单张重生成、放大预览）、失败项列表与逐条重试。
    - 预览/导出按钮：指向图片版目录。
  - 验收：UI 探针（空状态/未配置 API 提示/预计费用变化/生成中张数累计）。

- **P6 i18n、测试与文档（子任务 10）**
  - 五语言词条（zh-CN 基准 + en/ja/ko/zh-TW）＋「图片小说」入口名；`check:i18n` 门禁通过。
  - 测试：`unit-image-story-render` / `unit-image-story-tasks` / `unit-image-story-validate` / 指纹隔离（sprite ≠ imageOnly）＋ 现有全套不回归。
  - 文档：README/CHANGELOG 说明两套模式的产物目录、成本与缓存互不影响；`docs/ARCHITECTURE_FLOW.md` 补图片小说链路图。

### Key Architectural Decisions

| # | 决策 | 理由 | 代价/取舍 |
|---|------|------|-----------|
| K1 | 独立页面 + 独立 store + 独立输出目录，管线核心（Pipeline）复用 | 用户明确要求两套页面不可混淆；复制第二套 2000 行管线会立刻漂移 | 需要在 Pipeline/组装/渲染增加显式 `visualMode` 参数 |
| K2 | 视觉模式进入剧本缓存指纹（`visualMode`），并进入图像任务口径 | 不隔离会出现「两套页面互相命中、切换后产物错乱」 | 旧调用点已统一为 `scriptFingerprint`，新增参数一处生效 |
| K3 | 分章复用主项目，其余独立 | 同一本小说只导入/分章一次，省 LLM 费用、避免两套章节编号漂移 | 主项目重新分章会使图片版缓存按指纹失效（页面如实提示重跑范围） |
| K4 | shot 三视图一致性固定为 threeView（覆盖 #809 原文的「不生成 threeview」） | #814 决策 7 明确要图生图参考以保证跨分镜人物一致 | 多 N 张三视图成本；三视图失败必须走失败项而非静默降级 |
| K5 | 数量默认不限 + 三个旋钮 + 实时张数/费用 | #814 决策 4：效果优先，但用户要能控费；到上限暂停可续跑 | 必须有实时成本可见性与总量提示，否则存在无感超支风险 |
| K6 | 过渡只淡入，不推近 | #814 决策 9（避免与后续需求冲突/视觉疲劳） | 观感更平实；如需更强运镜另立需求 |
| K7 | 新页面自带预览/导出，不改造现有预览页/导出页 | 用户要求；两套产物目录不同，现有页面职责不扩 | 新页面需复用现有 Rust 预览服务与 zip 链路（仅换目录） |

### Target Module Layout（新增/改动概览）

```
src/pages/ImageStoryPage.vue        新增：图片小说页面（异步加载）
src/stores/imageStory.ts            新增：独立状态与运行控制器（独立持久化）
src/core/types.ts                   改动：Shot / SceneJSON.shots / ImageTask.kind "shot" / RenderAssets.shot / ImageStoryOptions
src/core/script.ts                  改动：imageOnly 分镜版提示词与 shots 产出
src/core/dataValidation.ts          改动：shots 校验
src/core/images.ts                  改动：buildImageTasks 的 imageOnly 分支（三视图参考 + shots + 物品图可选）
src/core/render.ts                  改动：imageOnly 渲染分支（跳过立绘全家族，按 trigger 淡入切图）
src/core/project.ts                 改动：imageOnly 组装（独立目录、shot 复制、flowchart/theme/HOW_TO_PLAY）
src/core/lint.ts                    改动：shot 引用校验
src/stores/nav.ts + src/App.vue     改动：侧栏入口与图标（异步组件）
src/gameExtra/appreciation.html     改动：分镜分组
tests/unit-image-story-*.ts         新增：渲染/任务/校验/指纹隔离
```

## Expected Changes

**Create**

| # | 路径 | 用途 | 阶段 |
|---|------|------|------|
| C1 | `src/stores/imageStory.ts` | 独立状态、运行控制、独立持久化 | P1 |
| C2 | `src/pages/ImageStoryPage.vue` | 页面骨架（选项/进度/结果/预览/导出） | P1/P5 |
| C3 | `tests/unit-image-story-render.ts` | imageOnly 渲染断言 | P4/P6 |
| C4 | `tests/unit-image-story-tasks.ts` | imageOnly 任务集合与旋钮裁剪断言 | P3/P6 |
| C5 | `tests/unit-image-story-validate.ts` | shots 校验断言 | P2/P6 |

**Modify**

| # | 路径 | 变更 | 阶段 |
|---|------|------|------|
| M1 | `src/stores/nav.ts` | `PageId` + `"imageStory"` | P1 |
| M2 | `src/App.vue` | 异步页面注册 + 侧栏图标 | P1 |
| M3 | `src/core/types.ts` | `Shot`/`shots`/`kind:"shot"`/`RenderAssets.shot`/`ImageStoryOptions` | P1 |
| M4 | `src/core/script.ts` | 分镜版 SYSTEM_PROMPT / `mode` 分支 | P2 |
| M5 | `src/core/dataValidation.ts` | shots 校验 | P2 |
| M6 | `src/core/images.ts` | imageOnly 任务集合 | P3 |
| M7 | `src/core/render.ts` | imageOnly 渲染分支 | P4 |
| M8 | `src/core/project.ts` | imageOnly 组装与产物命名 | P4 |
| M9 | `src/core/lint.ts` | shot 引用校验 | P4 |
| M10 | `src/gameExtra/appreciation.html` | 分镜分组 | P4 |
| M11 | `scripts/i18n-keys.txt` + `src/i18n/{en,ja,ko,zh-TW}.ts` | 新文案 | P6 |
| M12 | `CHANGELOG.md` / `docs/ARCHITECTURE_FLOW.md` | 模式说明与链路图 | P6 |

## Acceptance Criteria

1. 侧栏出现「图片小说」入口（位于「生成项目」下方），打开为独立页面，与现有生成页状态互不影响。
2. 可复用当前小说的分章，在独立目录 `<用户选择目录>/<书名>-图片版/` 生成一套产物；立绘版项目与其缓存完全不受影响（两套缓存互不命中）。
3. 预览可玩：**全屏图片随对话淡入切换**，全程不出现任何立绘/人物演出 UI；文本框与人名框保留；选项分支、BGM/SE、章节标题卡正常。
4. 预览/导出入口在新页面内可用（zip 可下载/可解压，目录结构完整、`shot_*.png` 全部存在）。
5. 费用可见：开始前显示「预计 N 张 ≈ X 元」；运行中显示已生成张数与累计费用；接近/达到用户设定上限时醒目提示，且**暂停后可提高上限续跑，不重画已完成图**。
6. 生成前显示图片总账（共多少张 / 已生成 / 待生成），口径与章节灯一致。
7. 校验与失败项：shots 非法数据不入缓存；三视图缺失/失败、图片失败均可定位并重试。
8. 质量门禁全绿：`vue-tsc --noEmit`、`node scripts/run-tests.mjs`、`npm run build`、`check:i18n`。

## Tests

- `unit-image-story-render.ts`：imageOnly 输出**不含** `changeFigure` / `miniAvatar` / `setTempAnimation`；按 `triggerLineIndex` 输出 `changeBg`；无 shot 场景回退背景。
- `unit-image-story-tasks.ts`：imageOnly 任务集合 = 三视图 + shots +（可选）物品图；**不产出**立绘/表情/动作/服装差分；三个旋钮的裁剪与告警；到总量上限停止派发。
- `unit-image-story-validate.ts`：缺 prompt、`triggerLineIndex` 越界、id 重复、超条数告警。
- 指纹隔离：`scriptFingerprint({ visualMode: "sprite" }) !== scriptFingerprint({ visualMode: "imageOnly" })`（现有 `unit-script-fingerprint` 已覆盖模式位，新增两模式实例断言）。
- 既有全套测试不回归（66/66 基线）。

## Risks / Open Questions

- **无感超支**：默认不限张数（#814），必须把预计/实际张数与费用、到达上限提示做扎实；缺一不可。
- **三视图依赖**：图生图链路依赖三视图；任何「静默降级为纯文生图」都会造成跨分镜人物不一致（明确禁止）。
- **分章复用漂移**：主项目重新分章后图片版需按新指纹重跑对应章节，页面要明确提示影响范围而不是静默复用旧产物。
- **长章输出上限**：分镜 prompt 增加输出量，沿用现有自适应单章预算（#800）与忠实全文约束；必要时按场景分块生成。
- **开放项（默认按建议，不阻塞开工）**：物品图默认关闭；分镜在鉴赏室独立分组（而非并入 CG）；每场景张数默认 0=不限。

## Rollback

各批均为新增为主（新页面/新 store/新模式参数）；P1–P6 任一批未通过验收可单独不发布（入口不注册即完全不可见），对现有立绘版无行为影响。
