---
title: Refactor and optimize image generation for GPT-Image2
---

## Initial User Prompt

单独分一下图片生成相关代码，专门优化关于gpt-image2 的代码，对于gpt-image搜索网络，进行专门的优化，还有什么代码的缺陷和等等等问题

## Description

图片生成是 NovelForge 唯一「无限额、按次真实付费」的产出阶段：生成页/素材页发起，经管线与单素材重生成调用 `src/core/images.ts`（1925 行：任务构建、参考图解析、执行、抠图、修复）与 `src/core/visualBible.ts`（2464 行：画风分析 + 角色三视图/服装图生成），再经 `src/api/openaiCompatible.ts`（`generateImage` / 连接测试）、`src/api/universal.ts`（模板适配器）、`src/api/providers.ts`（能力表与探测）、`src/api/templates.ts`（线路模板）落到外部图像 API。当前问题分三类：

1. **职责混装、无单一入口**：传输适配、能力探测、提示词与背景策略、抠图、内容审查重试分散在 6+ 个文件，且内容审查改写阶梯在生成管线与视觉守门各有一份实现（`images.ts` 的阶段阶梯 vs `visualBible.ts` 的 `generateImageWithModerationRetry`），改一处要同时核对多处。
2. **GPT-Image 系列未按真实 API 契约处理**：`openai-image` 模板对所有模型都发 `response_format`（GPT-Image 系列不支持，严格端点直接 400 `Unknown parameter`，部分中转返回 200 但 `data` 为空）；参考图走文生图端点的 JSON `image/image2/image3` 字段（该系列官方参考/编辑路由是带多张图片的表单请求，支持最多 16 张），而能力校验又把参考图硬性封顶为 3 张；App 实际请求的尺寸（锚点 1024x576 等）不在该系列支持集合内时，会与「缓存图尺寸校验」互相打转，导致每次运行都重画重扣费。CHANGELOG 已记录一次真实事故：`gpt-image-2.5` 线路带参考图请求稳定失败（8 个任务每轮必失败）。
3. **可花钱的缺陷**：能力探测存在假阳性（未知型号探测时参考图会被能力路由提前丢弃，于是「探测成功」被写成「支持 3 张参考图」）；付费请求存在两层重试（传输层最多 7 次 × 业务层 3 次），单任务最坏可放大到数十次真实扣费。

本次改造按「先分离、再优化、后修缺陷」推进：把图片生成相关代码按职责切成单一入口模块（任务构建 / 执行与重试 / 参考图解析 / 服务商能力 / 提示词与背景策略 / 抠图 / 内容审查 / 视觉守门出图），调用方只经模块边界；再基于对 GPT-Image 系列当前官方文档事实（端点、参数、尺寸约束、原生透明背景、参考图上限、prompt 上限 32000、单图延迟可达约 2 分钟）建立专用路径——严格端点兼容、参考图走编辑路由、尺寸安全映射并让缓存以「实际尺寸」为准、支持时直接出原生透明 PNG 而不再依赖绿幕抠图，不支持或失败时自动回退；同时修掉探测假阳性、双层重试放大付费、尺寸/缓存死循环与重复实现。对非 GPT 系列线路（硅基流动 / MiniMax / 百炼 / Gemini / 自定义模板）保持请求逐字段等价、文件名与缓存命中不变。

受益者：使用 GPT-Image 线路（尤其官方/严格兼容端点）的创作者能稳定出图、不再为同一张图反复付费、立绘/物品边缘质量更好；维护者可以在清晰的模块边界内改一个职责而不牵动其它链路。

**Scope**:
- Included:
  - 图片生成相关代码按职责分离为单一入口模块，调用方只依赖模块边界（行为不变）。
  - GPT-Image 系列的专用路径：严格端点安全的请求形态、参考图/编辑路由选择、按模型文档能力记录参考图上限、尺寸安全映射与缓存闭环、原生透明背景（含自动回退）、可选参数（quality / output_format / moderation）按配置透传。
  - 缺陷修复：能力探测假阳性、单任务多层重试叠加、尺寸不符导致的缓存失效死循环、内容审查阶梯重复实现。
  - 研究留痕：把 GPT-Image 当前文档事实（含来源链接）与「事实 → 行为」映射写入 docs；模块地图与迁移说明。
  - 不产生真实扣费的回归测试（本地假服务端）。
- Excluded:
  - API 配置页重做（独立任务 `.specs/tasks/draft/redesign-api-configuration.feature.md`）。
  - 配音/TTS、游戏运行时渲染、视觉守门审批语义与指纹规则。
  - 新增服务商、流式部分图、一次多图（n>1）、出图质量自动评分。
  - 提示词内容策略改动（绿幕/情绪/动作守卫等），唯一例外是在请求原生透明背景时不再追加绿幕后缀。

**User Scenarios**:
1. **Primary Flow**：创作者配置 GPT-Image 线路 → 「测试连接」如实记录参考图/尺寸/透明能力 → 逐章生成时文生图与带参考图任务都走该系列正确的路由、参数与尺寸 → 需要透明底的素材直接拿到带 alpha 的 PNG → 素材齐全后重跑图像阶段为 0 次付费请求。
2. **Alternative Flow**：仅支持 JSON `image` 字段的中转线路、以及非 GPT 系列线路，按各自能力自动选择兼容请求形态，行为与改造前一致。
3. **Error Handling**：透明背景被拒 → 自动回退绿幕 + 色度键抠图并在日志说明；线路完全不接受带参考图请求 → 沿用既有类型化拒绝（不重试、不丢参考图、给可执行提示）；探测被拒 → 如实记录不支持；中止 → 不再发起新的付费请求。

**目标模块边界（由后续计划细化命名，此处仅作范围证据）**：图片任务构建 / 任务执行与重试 / 参考图解析与落盘 / 服务商图像能力（含探测）/ 提示词与背景策略 / 抠图 / 内容审查重试 / 视觉守门角色图生成，各自单一入口；`images.ts` 与 `visualBible.ts` 中的图片生成相关职责下沉，非图片职责（审批、清单、画风分析）留在原处。

## Architecture Overview

> 规划输入：GPT-Image 文档事实与线路差异见 `.claude/skills/gpt-image-generation/SKILL.md`（2026-09-15 核验）；代码现状、缺陷清单（D1-D15）与风险见 `.specs/analysis/analysis-image-generation-gpt-image2.md`。本节只记录架构决策与变更清单，验收标准见下节。

### Solution Strategy（分离 → 优化 → 修缺陷，五阶段各自可回滚）

总顺序沿用原始诉求「先分离、再优化、后修缺陷」。每个阶段收尾都必须 `vue-tsc --noEmit`、`node scripts/run-tests.mjs`、`npm run build` 全绿，并包含对应回归套件（unit-image-abort / unit-image-references / unit-image-reference-route / unit-image-prompt / unit-chapter-image-scope / unit-regen-safety / unit-visual-bible* / unit-error-classifier）。

- **P0 基线护栏（前置）**：单章生成流程的改动仍未提交（HEAD `784e8e2`；`src/core/images.ts` 已改，`src/stores/generate.ts`、`src/components/generate/**` 未跟踪）。先提交/记录该基线，避免图像重构与它混成一个 diff；同时新增 `buildImageTasks` 金样快照（task id / fileName / prompt 尾串 / seed / 参考图 role）与非 GPT 模板的请求体金样，冻结任务图与线路契约。
- **P1 纯分离（零行为变更）**：`core/images.ts` 按职责拆入 `src/core/image/*`；`core/regenerate.ts` 移为 `core/image/regen.ts`；两份内容审查阶梯合并为 `core/image/rewrite.ts` 的唯一实现（`allowLlmRewrite` 区分管线 LLM 四阶 / 视觉守门无 LLM 三阶，逐阶行为等价）。旧文件保留为 barrel 再导出，7 处调用方与既有测试的 import 全部不动。
- **P2 GPT-Image 专用路径（优化）**：新增 `api/image/policy.ts`（按生效模型解析请求策略）与 `api/image/openai.ts`（GPT 家族形态与可执行错误）。`openai-image` 增加严格端点安全变体（GPT 家族不携带 `response_format`/`seed`）；参考图按策略走 edits multipart（≤16 张、<50MB）或回退既有 generations JSON 形态；补齐当前模型 ID、容量上限放开到 16、按模型尺寸矩阵与安全映射；`universal.ts` 支持二进制文件 part 与图像调用的 `pathPrefix`。
- **P3 缺陷修复与成本闭环**：探测重做（必发必需参考图 + 响应校验 + 仅成功后按模型写回）；付费重试归一到业务层单预算 ≤ `retryCount + 1`（传输层对图像请求单发，chat/TTS 维持现状）；错误分类补齐 `unknown_parameter`、输出阶段审查、账单/配额永久类与组织验证提示；缓存以「记录的实际产出尺寸」为准（`cache/images/.image-meta.json`，旧文件无记录视为有效）；删除死代码 `src-tauri/src/config.rs`。
- **P4 能力门控增强**：原生透明背景仅对当前走色度键的素材（立绘/情绪/服装/动作/物品）启用，三视图/背景/CG/锚点保持现状；`selfcheck.ts` 同时接受绿幕与透明两种模式；quality / output_format / moderation 仅在配置显式设置且生效模型支持时透传。
- **P5 文档与收尾**：`docs/IMAGE_GENERATION_REFACTOR.md` 记录 GPT-Image 文档事实与来源链接、事实→行为映射、模块地图与迁移说明；barrel 与旧实现的物理删除作为收尾项（若环境删除动作受限，则标记为跟进项，保持 barrel 无行为副作用）。

### Key Architectural Decisions

| # | 决策 | 理由 | 代价/取舍 |
|---|------|------|-----------|
| K1 | strangler 分离：先纯搬移，旧路径以 barrel 再导出 | 任务图输出即缓存键（`task.fileName`）且被章节灯/级联计数共享，任何命名漂移都会造成整书重画；小步 diff 可审可回滚 | 过渡期双模块面（barrel + 新目录），删除遗留到 P5/跟进 |
| K2 | 请求策略集中在 `api/image/policy.ts`，`core/*` 不做 provider 分支 | 管线、重生成、视觉守门必须共享同一 shaping；同时满足「所有线路正确 + GPT 路径专门优化」 | 多一层间接；非 GPT 行为靠金样请求测试钉住 |
| K3 | 用模板/policy 数据驱动扩展，不写 `model.startsWith("gpt-image")` 分支 | 复用现有 `AdapterTemplate` + `requestMap` 机制；用户自定义模板 JSON 无需感知内部变化 | GPT 专属逻辑（edits multipart、错误映射）仍需少量代码，收敛在 `api/image/openai.ts` |
| K4 | 能力与图像元数据一律按「生效模型」（`cfg.model`）记录并版本化；探测写回非破坏 | 修 D11：槽位级记录在换模型后成为脏数据；修 D4：失败探测覆盖已知能力是永久配置损坏 | 需要配置迁移（v1 槽位记录仅在 model 匹配时才可信）与 UI 调整 |
| K5 | 参考图路由显式化为 `refRoute: "generations-json" \| "edits-multipart"`，不允许静默丢弃必需参考图 | 官方 OpenAI 只有 edits/multipart 能用参考图，中转只认 JSON generations；保留 `REFERENCE_UNSUPPORTED` / `REFERENCE_MISSING` 类型化语义 | 新增 multipart 二进制传输（Tauri + web runtime 两套），需要新测试锁定 |
| K6 | 付费重试单预算：业务层是唯一 owner，传输层图像请求单发 | 修 D7：现行最多 (7+1)×3 ≈ 24 次真实扣费；Retry-After 与永久账单类一并纳入分类 | 传输层行为按调用类型分化，需要文档与测试说明 |
| K7 | 内容审查阶梯参数化为一个实现（`allowLlmRewrite`），不做「一刀切严格版」 | 视觉守门调用点没有 LLM 配置且要求低延迟；A3 要求单一实现但两条路径阶梯顺序/限次与现状一致 | 一个开关两种预设，两个变体都要单测覆盖 |
| K8 | 尺寸由「生效模型」的能力矩阵计算：约束内任意尺寸直出（gpt-image-2/2.5），否则确定性映射到最近支持尺寸或 `auto` | 修 D5 与 B4/B5；1024x576 锚点、512x512 测试图在 1/1.5 上非法，在 2/2.5 上低于最小像素面积 | 「最近尺寸」需要显式规则与日志，避免无声变形 |
| K9 | 缓存有效性 = 记录的实际产出尺寸（`cache/images/.image-meta.json`），不再拿最新映射反复比对；无记录旧文件视为有效 | 修 D12/B4/C4：否则每次运行都因尺寸不符重画；同时不触碰被 store 实时轮询、且 `parseAssetMap` 会丢未知键的 `assets.json` | 多一个元数据文件；ledger 需串行写并随孤儿文件清理条目 |
| K10 | 原生透明是能力门控路径 + 单次回退，且沿用同一 fileName | 修 B6：真实 alpha 边缘优于绿幕抠图；失败自动回退色度键，避免循环与重复扣费 | execute 内两条产物路径；selfcheck 需同时接受两种模式 |
| K11 | 冻结任务身份与命名：`ImageTask.id` / `fileName` / 既有 prompt 常量除「原生透明时去掉绿幕后缀」外不动 | 硬约束 (a)：缓存命中与章节灯都绑定命名；绿幕提示词只影响新生成的透明素材 | 旧命名遗留（如 id/种子顺序）本次不清理 |
| K12 | 视觉守门出图收敛为单一入口 `core/image/gate.ts`，审批/指纹/清单等图片无关职责留在 `visualBible.ts` | AC A1 要求「视觉守门角色图生成」唯一实现；同时避免把审批语义拖进批次执行器 | visualBible 仍持有产物生命周期；两条调用链共享 policy + ladder + probe，而非共用执行器 |
| K13 | 探测「模板/策略先行」：线路模板根本无法表达参考图时不得判 `supportsImageEdit`，无论 HTTP 是否 200；探测必须发「必需参考图」并校验响应 | 修 D4/D13：假阳性会写成永久配置，未知型号会因非必需 role 被路由提前丢弃 | 探测最多消耗 2 张额度；未知中转可能被判保守不支持（保留手动覆盖入口） |
| K14 | Rust 传输层本次只做「够用」：不引入流式；64 MiB 请求/响应上限与 300s 超时在文档说明，除非实测 2K/4K 或 edits 载荷触碰上限才升级 | 控制风险面，避免把 Tauri 传输重写纳入本次范围 | 高分辨率/大批量 edits 有硬上限，作为已知限制写入 B8 文档 |

### Target Module Layout

```
src/core/image/                 # 由 core/images.ts 拆出（图片生成域）
  types.ts        任务/结果/选项类型单一来源（引用 core/types 的 ImageTask 等）
  tasks.ts        buildImageTasks / taskSeedForId / chapterCharacterIds / chapterItemIds（输出字节稳定）
  prompts.ts      风格/情绪/背景后缀、emotionPrompt、stripBackground、fitImagePrompt 与提示词上限解析
  references.ts   resolveImageTaskReferences、fileReference、视觉守门产物路径解析
  rewrite.ts      内容审查改写阶梯唯一实现（LLM 四阶 / 无 LLM 三阶，参数化）
  execute.ts      runImageTask（缓存→参考图→生成→抠图→自检）+ ensureCutout/reCutoutAsset 入口
  batch.ts        generateImages（范围收窄、缓存分区、依赖分层、进度、persist-before-emit、中止）
  ledger.ts       assets.json 合并 / 旧 CG 迁移 / repairImageAssets / 产出尺寸元数据
  gate.ts         视觉守门图片生成的单一付费入口（画风样张/三视图/服装/动作）
  regen.ts        原 core/regenerate.ts 的搬移（单素材/批量重生成，复用 execute）
src/api/image/                  # 请求策略与 OpenAI 家族
  policy.ts       按生效模型解析 ImageRequestPolicy（尺寸矩阵、路由、参数门控、参考图上限/编码）
  openai.ts       GPT-Image 家族形态 + 可执行错误映射（组织验证/审查阶段/未知参数）
  probe.ts        testImage / probeImageEditSupport / 非破坏能力写回
# 迁移期兼容（P5 或跟进删除）
src/core/images.ts      barrel → core/image/*
src/core/regenerate.ts  barrel → core/image/regen.ts
```

四条约束：任务图输出字节稳定；一切付费请求经 execute/gate 单一入口；provider 差异只由 policy/template 决定、core 不分支；能力与元数据按模型记录、版本化、非破坏写回。

### Expected Changes

**Create**

| # | 路径 | 用途 | 阶段 |
|---|------|------|------|
| C1 | `src/core/image/types.ts` | 图片域类型单一来源（`BuildImageTaskOptions`、`ImageRunOptions`、`ImageResultMap` 等） | P1 |
| C2 | `src/core/image/tasks.ts` | 任务图与种子派生（纯函数，输出冻结） | P1 |
| C3 | `src/core/image/prompts.ts` | 提示词常量与压缩/剥离辅助 | P1 |
| C4 | `src/core/image/references.ts` | 参考图解析与素材→引用映射 | P1 |
| C15 | `src/core/image/rewrite.ts` | 参数化内容审查阶梯唯一实现（A3/D9/K7） | P1 |
| C5 | `src/core/image/execute.ts` | 单任务执行（缓存→参考图→生成→抠图→自检）与抠图入口 | P1/P3/P4 |
| C6 | `src/core/image/batch.ts` | 批次执行（范围、缓存分区、依赖、进度、中止、ledger 落盘） | P1 |
| C7 | `src/core/image/ledger.ts` | assets.json 合并/迁移/修复 + `.image-meta.json` 产出尺寸记录（K9） | P1/P3 |
| C16 | `src/core/image/gate.ts` | 视觉守门出图单一入口（A1/K12） | P1/P4 |
| C8 | `src/core/image/regen.ts` | 原 `core/regenerate.ts` 的搬移 | P1 |
| C9 | `src/api/image/policy.ts` | 按生效模型的请求策略（K2/K8） | P2 |
| C10 | `src/api/image/openai.ts` | GPT 家族形态与错误映射（K3/K5） | P2 |
| C11 | `src/api/image/probe.ts` | 探测设计与非破坏写回（K13） | P3 |
| C12 | `tests/unit-image-request-shape.ts` | 各线路/模型请求体金样（C2/C3 回归） | P2 |
| C13 | `tests/unit-image-provider-matrix.ts` | 模型能力/尺寸/参数矩阵（含 2.5 flare/sunburst、退役 dall-e） | P2 |
| C14 | `tests/unit-openai-edits.ts` | multipart `image[]` 构造、role 顺序、尺寸/格式守卫（edits 路由落地后必做） | P2/P3 |
| C17 | `tests/unit-image-task-golden.ts` | `buildImageTasks` 金样快照（硬约束 (a)/(b)） | P0/P1 |
| C18 | `tests/unit-image-cache-closure.ts` | 尺寸映射 + 二次运行 0 请求 + 旧缓存复用（B4/C4） | P3 |
| C19 | `tests/unit-image-probe.ts` | 探测真实性（必需参考/丢弃/拒绝三态）与写回规则（C1） | P3 |
| C20 | `docs/IMAGE_GENERATION_REFACTOR.md` | GPT-Image 事实+来源、事实→行为映射、模块地图、迁移说明（B8） | P5 |

**Modify**

| 文件 | 变更 | 阶段 |
|------|------|------|
| `src/core/images.ts` | 拆出后改为 barrel；内部旧探测/阶梯/尺寸副本删除 | P1/P3 |
| `src/core/regenerate.ts` | 移为 `core/image/regen.ts`，保留 barrel | P1 |
| `src/core/visualBible.ts` | 出图改走 `gate.ts`；阶梯/尺寸/错误统一；审批与指纹逻辑不动 | P1/P4 |
| `src/core/pipeline.ts` | `generateImages` 改 options 对象；新策略参数透传 | P1/P2 |
| `src/core/chapterAssets.ts` | 覆盖计数改经 tasks 模块（任务 id 冻结） | P1 |
| `src/core/stageCascade.ts` | 同上（缺图计数与级联一致） | P1 |
| `src/core/selfcheck.ts` | 透明/绿幕双模式判定（B6 生效后判定规则需跟随） | P4 |
| `src/api/templates.ts` | `openai-image` 严格变体 + `openai-image-edits`；Gemini/Stability 参考图缺口记录 | P2 |
| `src/api/universal.ts` | multipart 二进制 part；图像 `pathPrefix`；图像调用单发传输 | P2/P3 |
| `src/api/providers.ts` | 新模型 ID、上限 ≤16、移除 dall-e 默认、策略辅助 | P2 |
| `src/api/openaiCompatible.ts` | policy 驱动的 `generateImage`；probe 委派；非破坏写回 | P2/P3 |
| `src/utils/errorClassifier.ts` | `unknown_parameter`/输出审查/账单配额/组织验证分类 | P2/P3 |
| `src/pages/ConfigPage.vue` | 能力编辑器上限 16、按模型展示/重置探测结果、测试成本提示 | P2/P3 |
| `src/components/generate/OptionsPanel.vue` | 仅在需要用户可见 quality/背景旋钮时增加（B7 默认可走配置） | P4（可选） |
| `src/components/generate/result/AssetPanel.vue` | 透传透明/重编码来源展示 | P4 |
| `src/components/VisualBiblePanel.vue` | 跟随共享错误与策略（无行为变化） | P3/P4 |
| `src/stores/generate.ts` | regen 上下文/参数透传；队列、锁与中止语义保持不变 | P2/P4 |
| `src/stores/project.ts` | 新 GenerationOptions 默认值与快照持久化（若用户可见） | P4（可选） |
| `src/stores/configMigration.ts` | 能力 v2 / 策略版本迁移 | P3 |
| `src/stores/config.ts` | 换模板/换模型时清理过期能力与探测记录 | P3 |
| `src/i18n/en.ts`、`ja.ts`、`ko.ts`、`zh-TW.ts` + `scripts/i18n-keys.txt` | 新配置/错误文案与键表 | P2-P4 |
| `src-tauri/src/commands.rs` | 仅当实测触碰 64 MiB/600s 上限才调整；否则只文档化 | P2/P5 |
| `tests/unit-image-prompt.ts`、`unit-image-references.ts`、`unit-providers.ts`、`unit-image-reference-route.ts` | 契约更新（上限 3→16、新模型、探测规则） | P1-P3 |
| `tests/unit-visual-bible.ts`、`unit-visual-bible-scope.ts` | gate 单一入口后的等价断言 | P1/P4 |

**Delete / Move**

- 删除 `src-tauri/src/config.rs`（未被 `lib.rs` 声明，D10 死代码）；若环境删除动作受限，标记为跟进项。
- 搬移 `src/core/images.ts` → `src/core/image/*`、`src/core/regenerate.ts` → `src/core/image/regen.ts`；两个旧路径在 P1-P4 作为 barrel 保留，P5 或跟进删除。
- 被替换的内部实现删除干净：旧探测写回、`visualBible.ts` 私有阶梯、旧尺寸常量与 `imageSizeMatches` 死循环判定（C5）。

### Hard-Constraint Compliance

- **(a) 缓存/字节稳定**：K1 + K9 + K11 与 C17/C18；文件名、任务 id 与既有 prompt 常量冻结；新增尺寸/透明元数据只进 sidecar，`assets.json` schema 不动；无记录旧文件一律视为有效，杜绝「升级后首跑整书重画」。
- **(b) 单章生成流程不回退**：P0 先提交/记录当前工作区基线；P1 只做纯搬移且不改公开签名；execute/batch 保留协作式中止检查点、persist-before-emit 顺序、依赖分层与队列锁；stores/generate.ts 只做加法透传；跑 unit-image-abort / unit-partial-rerun / unit-chapter-image-scope。
- **(c) 全线路请求形态正确**：K2/K3/K5；非 GPT 模板以 C12 金样请求断言逐字段等价；GPT 家族按模型名禁用不支持参数、参考图路由按能力显式选择并可回退 generations JSON；中转不因优化被误伤；顺带修图像调用忽略 `pathPrefix`（D6）。
- **(d) 审查阶梯可参数化**：K7；`rewrite.ts` 单一实现，`allowLlmRewrite` 参数区分管线（LLM 四阶）与视觉守门（无 LLM 三阶）；两变体分别单测，逐阶顺序与限次与现状一致。
- **(e) 能力/元数据按模型而非槽位**：K4 + K8 + K13；记录形如 `{ version, model, caps, probedAt }`，仅当 `model === cfg.model` 才可信；生效尺寸与参数门控全部由生效模型解析；探测只增量合并、不覆盖已知项；ConfigPage 可按模型查看/重置。

### References

- Skill（研究，2026-09-15 核验）：`.claude/skills/gpt-image-generation/SKILL.md`
- 分析（Phase 2b，含 D1-D15 证据与风险 R1-R10）：`.specs/analysis/analysis-image-generation-gpt-image2.md`
- 前期研究留痕：`.specs/scratchpad/103f26a5.md`
- 格式与落地先例（单章生成流程稳定性基线）：`.specs/tasks/done/generate-flow-refactor.feature.md`

## Acceptance Criteria

### Functional Requirements

**A. 分离与边界**

- [ ] **A1 单一职责模块**：图片生成的任务构建、执行与重试、参考图解析、服务商能力（含探测）、提示词与背景策略、抠图、内容审查重试、视觉守门角色图生成，各自只有一处实现、一个导出入口；调用方（管线、store、页面、素材重生成、视觉守门）只经这些入口调用；模块间无循环依赖，`vue-tsc --noEmit` 全绿。
  - Given：这些职责目前分散在 `core/images.ts`、`core/visualBible.ts`、`api/openaiCompatible.ts`、`api/universal.ts`、`api/providers.ts`、`core/regenerate.ts`
  - When：重构完成
  - Then：每个职责可且仅可从一个模块入口调用；旧位置不再保留同职责副本；类型检查通过
- [ ] **A2 非 GPT 线路行为等价**：对硅基流动 / MiniMax / 百炼 / Gemini / 自定义模板线路，同一任务改造前后发出的请求字段、落盘文件名、缓存命中行为一致（以请求快照回归测试断言）。
- [ ] **A3 内容审查单一实现**：生成管线与视觉守门角色图生成共用同一个内容审查改写阶梯；阶梯顺序与限次与现状一致（规则改写 → LLM 改写 → 全年龄后缀，每阶最多一次），两条调用路径的单元测试都命中该共享实现。

**B. GPT-Image 专用优化**

- [ ] **B1 严格端点兼容**：线路为 GPT-Image 系列（gpt-image-1 / 1-mini / 1.5 / 2 / gpt-image-2-2026-04-21 等，按模型名识别）时，文生图请求不携带该系列不支持的参数（当前已知：`response_format`）。
  - Given：一个会拒绝未知参数的假服务端（严格 OpenAI 兼容）
  - When：对 GPT-Image 系列发起文生图任务
  - Then：请求体中不含该系列不支持的参数，生成成功（HTTP 200 且产出图片）；对非 GPT-Image 线路仍保持原有参数
- [ ] **B2 参考图路由与容量**：需要参考图的 GPT-Image 任务走该系列文档定义的参考/编辑路由（多张图片的表单字段，模型能力最多 16 张、每张 ≤50MB、png/webp/jpg）；线路只有 JSON 文生图端点时自动改用与线路兼容的形态且任务仍成功。
  - Given：假服务端 A 只开放编辑/参考路由；假服务端 B 只接受 JSON 文生图 + `image` 字段
  - When：同一条带参考图的任务分别对 A、B 运行
  - Then：A 走到编辑路由并携带参考图；B 不携带编辑路由仍成功；两者都不会静默丢参考图
- [ ] **B3 参考图容量不再被硬编码封顶**：能力记录允许按模型文档容量（≤16）保存；但每个任务实际使用的参考图 role 集合与张数与现状一致，不新增参考图。
  - Given：能力配置/探测结果
  - When：保存或读取图像能力
  - Then：`maxReferenceImages` 可记录 ≥4 的值且不被校验拒绝；任务侧 `identity / style / structure` 的角色集合与张数不变
- [ ] **B4 尺寸安全映射与缓存闭环**：请求尺寸不在模型支持集合内时，确定性地映射到最近支持尺寸或 `auto`；缓存校验以「该素材实际产出的尺寸」（记录值；旧文件没有记录时视为有效）为准，而不是每次拿最新映射去比对；同一任务连续运行两次，第二次 0 次付费请求，不出现「每次运行都因尺寸不符而重画」。
  - Given：某 GPT-Image 型号只支持 1024x1024 / 1536x1024 / 1024x1536 / auto，任务请求 1024x576（锚点尺寸）；假服务端按支持集合返回 1024x1024
  - When：该任务运行两次
  - Then：第一次请求被映射为支持尺寸并在日志中记录「请求尺寸 → 生效尺寸」，产出文件按生效尺寸记录；第二次命中缓存、无请求发出
- [ ] **B5 gpt-image-2 任意尺寸直出**：型号支持任意分辨率（宽高均为 16 的倍数、宽高比 1:3–3:1、上限 3840x2160）时，按任务尺寸直出而不是映射到 1024/1536 标准档；超出约束的尺寸按 B4 映射。
- [ ] **B6 原生透明背景与回退**：当线路/型号支持原生透明背景时，需要透明底的素材（立绘 / 情绪差分 / 服装 / 动作 / 物品——即当前会走色度键抠图的素材）请求原生透明 PNG：请求不追加绿幕后缀、返回图不做色度键抠图，产物为带 alpha 通道的 PNG。
  - Given：支持 `background=transparent` 的假服务端
  - When：生成立绘类素材
  - Then：请求参数含原生透明背景且不含绿幕后缀；落盘 PNG 带 alpha 且没有绿边抠图痕迹
  - 失败分支：假服务端拒绝透明请求时，同一任务自动回退现有「绿幕 prompt + 色度键抠图」链路并成功产出，日志说明回退原因（单次回退，不循环）。三视图 / 背景 / CG / 锚点不参与透明切换，保持现状（三视图继续以其参考图用途原样保留背景）
- [ ] **B7 可选参数按配置透传**：该系列支持的 quality / output_format / moderation 等参数仅在线路配置显式设置时发送；未配置时不发送，且不注入模型不支持的默认值；日志可见实际生效值。
- [ ] **B8 研究留痕**：docs 中新增 GPT-Image 事实说明（含来源链接：端点、参数、尺寸约束、透明背景状态与预览限制、参考图上限、prompt 上限、单图延迟）与「事实 → 行为」映射表，并附本次的模块地图与迁移说明；每条专用行为都能追溯到一个已记录事实或已标注的线路经验。

**C. 缺陷修复**

- [ ] **C1 能力探测不再假阳性**：未知型号执行「测试连接」时，探测必须真的发送探测参考图；当参考图未被接受/被忽略（而非仅看 HTTP 200）时，写入 `supportsImageEdit=false`、`maxReferenceImages=0`；探测结果不得覆盖已知型号的准确配置（如编码方式、种子支持）。
  - Given：未知型号 + 假服务端分别表现（a）接受并携带参考图（b）接受但丢弃参考图（c）拒绝参考图
  - When：运行「测试连接」
  - Then：（a）记录支持参考图；（b）与（c）记录不支持参考图；已知型号原有 `supportsSeed` / `referenceEncoding` 不被改动
- [ ] **C2 付费请求次数有上限且逐次可见**：单个图像任务的总付费尝试次数 ≤ 配置的 retryCount + 1（不得出现传输层与业务层各自重试的叠加放大）；每次尝试在日志中可见（序号、原因、结果分类）；中止后不再发起新的付费请求（沿用现有终止语义）。
  - Given：retryCount=2，假服务端对前两次返回 500、第三次返回成功
  - When：运行该任务
  - Then：服务端观察到的请求数 ≤3；日志记录每次尝试；任务最终成功；中止测试中观察到 0 个新增请求
- [ ] **C3 参考图拒绝语义不回退**：GPT-Image 专用路径沿用既有 `REFERENCE_UNSUPPORTED` / `REFERENCE_MISSING` 语义：线路不接受带参考图请求时不重试、不静默丢参考图、给出可执行修复提示。
- [ ] **C4 旧缓存不因本次改造被整库作废**：改造前已落盘的图片缓存仍可复用；不出现「升级后第一次运行把整个项目重画一遍」（以既有缓存 + 假服务端断言运行时的请求数为 0）。
- [ ] **C5 无死代码/重复实现**：被替换的旧探测实现、旧审查重试实现、旧尺寸逻辑删除；全仓 typecheck、现有测试与构建全绿。

### Non-Functional Requirements

- [ ] **成本/性能**：素材齐全时重复运行图像阶段付费请求数 = 0；单任务最坏付费尝试 ≤ retryCount + 1；「测试连接」最多消耗 2 张额度。
- [ ] **兼容性**：7 个预置图像模板与用户自定义模板 JSON 格式向后兼容（旧配置不改即可运行）；旧项目缓存可复用；非 GPT 线路既有测试断言不变。
- [ ] **可观测性**：GPT-Image 每个请求的日志包含：线路、模型、路由（文生图/参考编辑）、请求尺寸与生效尺寸、是否原生透明、每次付费尝试与结果分类。
- [ ] **安全/隐私**：API Key 继续脱敏；参考图二进制不进入日志正文；无新增外发通道。
- [ ] **验证工具**：新增回归测试使用本地假服务端，不产生真实扣费；`vue-tsc --noEmit`、`npm test`、`npm run build` 全绿。

### Definition of Done

- [ ] 全部功能/非功能验收标准通过
- [ ] 新增回归测试覆盖：GPT-Image 请求契约、路由选择、尺寸映射与二次运行 0 请求、原生透明与回退、能力探测真实性、重试上限与中止、参考图拒绝语义、非 GPT 线路请求快照
- [ ] `docs/` 更新：GPT-Image 事实与来源 + 事实→行为映射 + 模块地图/迁移说明
- [ ] 死代码与重复实现删除干净（无同职责双实现、无注释掉的旧实现）
- [ ] 代码评审通过；非 GPT 线路行为等价有测试与日志证据

## Implementation Process

以下步骤分四组推进：**0 基线 → 1 分离与抽象 → 2 GPT-Image 优化 → 3 缺陷与成本闭环 → 4 收尾**。步骤编号即执行顺序；每一步收尾都必须 `node scripts/run-tests.mjs`、`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`、`npm run build` 全绿（以下称「三件套」）。**Phase Gate 回归墙**（每步都跑，防止单章流程回退）：`unit-image-task-golden`、`unit-image-request-shape`、`unit-image-prompt`、`unit-image-references`、`unit-image-reference-route`、`unit-image-abort`、`unit-partial-rerun`、`unit-regen-safety`、`unit-chapter-image-scope`、`unit-chapter-prune`、`unit-stage-cascade`、`unit-visual-bible*`、`unit-error-classifier`、`unit-providers`、`unit-template`、`unit-universal`。所有付费路径（`src/core/image/execute.ts`、`src/core/image/gate.ts`）在任何 `isAborted()` 为真之后不得发起新请求；每步的 Success Criteria 即该步的通过门槛。估算规模枚举：S / M / L（无 XL）。

### Implementation Summary

| # | 步骤 | 阶段 | 规模 | 依赖 | 关键路径 | 主要产物 / 门槛 |
|---|------|------|------|------|----------|------------------|
| 1 | 冻结工作区基线 | 0 基线 | S | — | 是 | 基线 commit + 三件套留痕；`git status` 无 `M src/` |
| 2 | 金样契约测试（任务图 + 非 GPT 请求体） | 0 基线 | M | 1 | 是 | `tests/unit-image-task-golden.ts`、`unit-image-request-shape.ts` |
| 3 | 纯搬移 A：`core/image/{types,tasks,prompts,references}.ts` | 1 分离 | L | 2 | 是 | 四模块 + `images.ts` barrel；金样全绿 |
| 4 | 内容审查阶梯参数化 `core/image/rewrite.ts` | 1 分离 | M | 3 | 是 | 单一阶梯（LLM 四阶 / 无 LLM 三阶）+ `unit-image-moderation.ts` |
| 5 | 纯搬移 B：`execute/batch/ledger/regen` | 1 分离 | L | 4 | 是 | 执行域拆分；中止/进度/持久化语义不变 |
| 6 | 视觉守门单一入口 `core/image/gate.ts` | 1 分离 | L | 5 | 否 | 9 处出图收敛；视觉守门套件全绿 |
| 7 | 请求策略 `api/image/policy.ts` + 能力 v2 + options 对象 | 1 分离 | L | 6 | 是 | 按生效模型解析；v2 模型键控；非 GPT 金样等价 |
| 8 | GPT-Image 严格端点形态 + 模型矩阵 | 2 优化 | L | 7 | 是 | `openai-image-strict`、GPT 家族门控、新模型能力表 |
| 9 | 参考图路由：edits multipart + relay 回退 | 2 优化 | L | 8 | 是 | `openai-image-edits`、`refRoute`、`unit-openai-edits.ts` |
| 10 | 尺寸安全映射 + 缓存闭环 | 2 优化 | L | 9 | 是 | 尺寸矩阵、`.image-meta.json`、二跑 0 请求 |
| 11 | 原生透明背景 + 可选参数透传 | 2 优化 | M | 10 | 否 | 透明 PNG + 单次回退；quality/format 门控 |
| 12 | 能力探测重做 + 非破坏写回 + ConfigPage | 3 缺陷 | M | 9 | 否 | `api/image/probe.ts`、三态测试、上限 16 UI |
| 13 | 重试预算 + Retry-After + 错误分类 | 3 缺陷 | M | 10 | 是 | 单预算 ≤ retryCount+1；新分类；请求计数断言 |
| 14 | UI 收尾、死代码与 barrel 清理 | 4 收尾 | M | 12、13 | 否 | A1/C5 审计清零（或明确跟进项） |
| 15 | 文档、CHANGELOG 与终验 | 4 收尾 | S | 14 | 是 | `docs/IMAGE_GENERATION_REFACTOR.md` + AC/DoD 全勾 |

### Step 1: 冻结工作区基线

**Phase:** 0 基线 · **Size:** S · **Depends on:** — · **Critical path:** 是

**Goal:** 把当前未提交的单章流程 / 视觉守门改动固化为可回退基线，使图像重构拥有干净 diff 与可复现的绿色起点（硬约束 (b) 前置）。

**Subtasks**
- 盘点 `git status --porcelain`（当前 111 项：`src/stores/generate.ts`、`src/components/generate/**`、`src/core/chapterAssets.ts`、`src/core/stageCascade.ts`、30+ 个 `tests/.tmp-*`、多张 `docs/screenshots/*.png`），决定入库 / 忽略；把 `tests/.tmp-*` 写入 `.gitignore`（沿用单章流程任务留下的建议）。
- 一次性提交应用源码与必要测试基线，提交信息注明「图像重构前置基线」；commit hash 记录到本任务文件或 `.specs/scratchpad/`。
- 提交前跑三件套并留痕：`node scripts/run-tests.mjs`（当前 57/57）、`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`、`npm run build`。
- 确认 `src/core/images.ts`、`src/core/visualBible.ts`、`src/api/{templates,providers,universal,openaiCompatible}.ts` 的工作区版本已入库（后续所有重构以该版本为对照）。

**Expected Outputs**
- 基线 commit（hash 记录在案）；`git status` 中应用源码无未提交修改（规划文件除外）。
- 三件套绿色输出留痕。

**Success Criteria**
- [ ] `git status --porcelain` 不再包含 `M src/…`；`tests/.tmp-*` 被忽略或清理后不再出现。
- [ ] `node scripts/run-tests.mjs` 退出码 0 且全量通过（基线 57/57；若此前已有追加测试则按当时数量全绿）。
- [ ] `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` 与 `npm run build` 退出码 0。

**Blockers**
- 环境策略可能拦截删除 / ignore 动作（`ChapterStatusBoard.vue` 删除曾被拦）→ 被拦时先完成提交，把清理动作并入 Step 14 跟进项。

**Risks & Mitigations**
- R9 测试树含 `.tmp-*` 造成「绿色基线」歧义 → 只以 `run-tests.mjs` 的 `unit-*.ts` 结果为准，`.tmp-*` 不属测试集。
- 把半成品一起提交 → 提交前三件套必须全绿；失败先修复并在提交信息说明修复内容。

**Verification**
- **Level:** Repo（工作区 / 构建）
- **Artifacts:** baseline commit hash、三件套输出。
- **Commands:** `git status --porcelain`；`node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`；`npm run build`。
- **Pass threshold:** 三件套退出码 0 且基线提交完成。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** 基线 commit（hash + diff 范围）、`git status --porcelain` 前后对照、三件套（`run-tests` 57/57、`vue-tsc`、`build`）输出留痕、`tests/.tmp-*` 处理记录。
- **Rubric (3 independent judges, each scored 1–5; per-judge weights sum to 1.00; panel score = 三视角均分):**
  - **J1 正确性 (correctness):** commit 范围只含应用源码与必要测试基线（0.40）；提交信息注明「图像重构前置基线」（0.25）；hash 与三件套输出对应同一提交且可复现（0.35）
  - **J2 回归安全 (regression-safety):** `git status --porcelain` 无 `M src/…`（0.50）；57/57 与 typecheck/build 证据真实、非历史粘贴（0.50）
  - **J3 证据充分 (evidence):** 任务文件 / scratchpad 记录 hash + 命令原文（0.60）；`.tmp-*` 忽略或清理动作有记录（0.40）
- **Pass threshold:** Panel 均分 ≥ 4.0/5.0，且 J1、J2 ≥ 4.0；任一视角 ≤ 3.0 不通过。
- **Failure action:** 有未提交 `src/` → 先补齐提交再进入 Step 2；三件套不绿 → 修复后重新提交并在提交信息说明修复内容；删除/ignore 被环境拦截 → 记录跟进项（并入 Step 14）并保留绿色基线，无效基线不得继续。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `node scripts/run-tests.mjs`（既有全套） | regression | 基线在 commit 上全绿（57/57），后续步骤有可比对起点 | 前置（硬约束 (b)） |
| `git status --porcelain` | repo | 工作区无 `M src/…`、`.tmp-*` 已忽略/清理 | 前置（硬约束 (b)） |
| `vue-tsc --noEmit` + `npm run build` | build | 基线类型/构建可复现 | NFR-验证工具 |

- **Test Cases to Cover**
  - [regression] 既有全部 `unit-*.ts` 在基线提交上通过（57/57）
  - [repo] `git status --porcelain` 无 `M src/`；`tests/.tmp-*` 不再出现在未跟踪列表
  - [repo] 基线 commit 可回退（hash 记录，`git show --stat` 与提交信息一致）
  - [build] 三件套退出码 0 的输出留痕与原命令一一对应

### Step 2: 金样契约测试（任务图 + 非 GPT 请求体）

**Phase:** 0 基线 · **Size:** M · **Depends on:** Step 1 · **Critical path:** 是

**Goal:** 用金样冻结 `buildImageTasks` 的任务身份与非 GPT 线路请求体，使后续搬移 / 策略改造一旦漂移立即红灯（R1/R2 护栏）。

**Subtasks**
- 新增 `tests/unit-image-task-golden.ts`：固定 fixture（2 章、2 角色含表情/服装/动作、1 物品、1 CG）调用 `buildImageTasks`，快照 `{kind,id,fileName,width,height,seed,refFromTask}` 与参考图 role 顺序；断言 `taskSeedForId` 同输入两次字节相等；断言各 prompt 关键尾串（`FIGURE_BG_SUFFIX`、`THREEVIEW_GREEN_SUFFIX`、`ITEM_BG_SUFFIX`、`BACKGROUND_EMPTY_SUFFIX`）。
- 新增 `tests/unit-image-request-shape.ts`：仿照 `tests/unit-image-reference-route.ts:62-73` 覆写 `tauri.http` 捕获请求，对 `siliconflow-image` / `minimax-image` / `dashscope-image` / `gemini-image` / `stability-image` 断言请求体逐字段金样（`response_format`、`seed`、`image_size`、`aspect_ratio`、`batch_size` 等）与 `unifiedImage` 变量映射（`refImage/refImage2/refImage3`、`sizeOpenAI/sizeRatio/sizeString`）。
- 金样只钉结构字段＋关键常量尾串，不做整串 prompt 快照；测试注释写明「金样失败 = 缓存/计费契约破坏」。
- 反向验证一次：临时改动任一 `fileName` 或模板字段确认测试失败，随后还原并记录。

**Expected Outputs**
- 两个可离线运行的 `tests/unit-*.ts`；测试数 57 → 59。

**Success Criteria**
- [ ] `node scripts/run-tests.mjs` 输出 `59/59 通过`。
- [ ] 反向验证记录：故意改动 `fileName` / `response_format` 时对应测试失败。
- [ ] 两个新测试不发起真实网络请求（全部经 fake `tauri.http`）。

**Blockers**
- 无。

**Risks & Mitigations**
- 金样过度脆弱（整串 prompt 快照）→ 只钉结构 + 关键尾串；数值/路径经 `normalizeForGolden` 归一。
- fake 响应与真实响应字段不符 → 复用真实回执样本（如 relay 413 回执）。

**Verification**
- **Level:** Unit
- **Artifacts:** 新测试文件、反向验证记录、`run-tests` 输出。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** 59/59 通过 + 反向验证成功。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `tests/unit-image-task-golden.ts`、`tests/unit-image-request-shape.ts`、反向验证记录、`run-tests` 59/59 输出。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 金样有效性 (correctness):** 快照只钉结构字段 + 关键尾串，非整串 prompt（0.30）；覆盖缓存/计费契约字段（id/fileName/seed/role 顺序）（0.40）；字节稳定断言（`taskSeedForId` 两次相等）（0.30）
  - **J2 回归安全 (regression-safety):** 反向验证真实执行（改 `fileName` / `response_format` 必红）（0.50）；测试零真实网络、全走 fake `tauri.http`（0.50）
  - **J3 覆盖充分 (coverage):** 5 个非 GPT 模板逐字段金样齐全（0.40）；`unifiedImage` 变量映射（`refImage/refImage2/refImage3`、`sizeOpenAI/sizeRatio/sizeString`）（0.35）；参考图 1/3 张 role 顺序（0.25）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（金样是后续 13 步的闸门），J1、J2 ≥ 4.0。
- **Failure action:** 金样过脆（整串 prompt/绝对路径）→ 用 `normalizeForGolden` 收窄到结构字段并重跑；反向验证没红 → 修正断言直到故意改动必失败，否则不得进入 Step 3。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-task-golden.ts`（新） | unit (golden) | `buildImageTasks` 任务身份/字节稳定，缓存键与章节灯命名不被重构漂移 | A2、C4 |
| `unit-image-request-shape.ts`（新） | unit (contract) | 非 GPT 模板与 `unifiedImage` 变量映射逐字段等价 | A2 |
| 反向验证（一次性） | negative | 金样真的会红（非空转断言） | A2、C4 |

- **Test Cases to Cover**
  - [golden] 2 章 / 2 角色（含表情/服装/动作）/ 1 物品 / 1 CG fixture：快照 `{kind,id,fileName,width,height,seed,refFromTask}` 与参考图 role 顺序
  - [golden] `taskSeedForId` 同输入两次字节相等；跨进程重跑稳定
  - [golden] 关键尾串：`FIGURE_BG_SUFFIX`、`THREEVIEW_GREEN_SUFFIX`、`ITEM_BG_SUFFIX`、`BACKGROUND_EMPTY_SUFFIX`
  - [contract] `siliconflow-image` / `minimax-image` / `dashscope-image` / `gemini-image` / `stability-image` 请求体逐字段金样（`response_format`、`seed`、`image_size`、`aspect_ratio`、`batch_size`）
  - [contract] `unifiedImage` 映射：`refImage/refImage2/refImage3` 与 `sizeOpenAI/sizeRatio/sizeString`
  - [boundary] 参考图 1 张与 3 张（role 上限点）的字段/顺序
  - [negative] 故意改 `fileName` → 任务金样红灯；故意改 `response_format` → 请求金样红灯（随后还原并留痕）
  - [boundary] 无参考图任务与仅 `structure` 引用任务的空字段形态

### Step 3: 纯搬移 A —— `core/image/{types,tasks,prompts,references}.ts`

**Phase:** 1 分离 · **Size:** L · **Depends on:** Step 2 · **Critical path:** 是

**Goal:** 零行为变更地把类型、任务图、提示词与参考图解析拆入 `src/core/image/`，旧路径改 barrel、调用方 import 不动（K1/A1）。

**Subtasks**
- 新建 `src/core/image/types.ts`：`ImageResultMap`、`BuildImageTaskOptions`、`ImageRunOptions`、`ImageReferenceResolutionContext`（引用 `core/types` 的 `ImageTask`/`ImageReference`/`ApiConfig`）。
- 新建 `src/core/image/tasks.ts`：`buildImageTasks`、`taskSeedForId`、`chapterCharacterIds`、`chapterItemIds`；输出逐字节不变。
- 新建 `src/core/image/prompts.ts`：`emotionPrompt`、`stripBackground`、`styleSuffix`、`threeViewFallback`、`imagePromptLimitFor`、`promptLimitFromError`、`fitImagePrompt` 与全部提示词常量（`FIGURE_BG_SUFFIX`、`ITEM_BG_SUFFIX`、`THREEVIEW_GREEN_SUFFIX`、`ANCHOR_PROMPT`、`REF_HINT` 等）。
- 新建 `src/core/image/references.ts`：`resolveImageTaskReferences`、`fileReference`、`visualBibleArtifactPath`、`imageMimeForPath`、`copyMaterial`、`findMaterial`。
- `src/core/images.ts` 改为 barrel：逐名再导出上述模块全部既有导出符号；被搬走的私有实现删除。
- 跑回归墙；`vue-tsc` 验证 barrel 类型完整。

**Expected Outputs**
- `src/core/image/{types,tasks,prompts,references}.ts`；`src/core/images.ts` 仅剩 re-export；无调用方改动。

**Success Criteria**
- [ ] `unit-image-task-golden.ts`、`unit-image-prompt.ts`、`unit-image-references.ts`、`unit-chapter-image-scope.ts`、`unit-stage-cascade.ts` 全绿。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。
- [ ] `rg "buildImageTasks\(" src/core/images.ts` 只剩 barrel 导出；`chapterAssets.ts` / `stageCascade.ts` / `useStageStatus.ts` / `stores/generate.ts` 的 import 路径未改。

**Blockers**
- Step 1 基线未完成（diff 无法审）。

**Risks & Mitigations**
- R1 搬移命名/字节漂移 → 金样先行；逐函数复制粘贴不改写。
- 循环依赖（references ↔ tasks）→ 依赖方向固定 `types ← tasks/prompts/references`，禁止反向 import。
- 导出面遗漏 → `vue-tsc` 全量兜底；barrel 优先逐名导出，避免 `export *` 冲突。

**Verification**
- **Level:** Module（金额敏感的任务图 / 参考图契约）
- **Artifacts:** 新模块、barrel diff、回归输出。
- **Commands:** `node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`；`npm run build`。
- **Pass threshold:** 三命令全绿 + 无调用方 import 变化。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/core/image/{types,tasks,prompts,references}.ts`、`src/core/images.ts` barrel diff、金样/回归墙输出、依赖方向检查。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 行为等价 (correctness):** 拆出函数为逐段搬移、无顺手改写（diff 可逐行对照）（0.40）；barrel 逐名再导出、无 `export *` 冲突（0.35）；依赖方向固定 `types ← tasks/prompts/references`、无循环（0.25）
  - **J2 回归安全 (regression-safety):** `unit-image-task-golden` / `unit-image-prompt` / `unit-image-references` / `unit-chapter-image-scope` / `unit-stage-cascade` 全绿（0.50）；调用方 import 未改（`chapterAssets.ts` / `stageCascade.ts` / `useStageStatus.ts` / `stores/generate.ts`）（0.50）
  - **J3 覆盖/类型面 (coverage):** `vue-tsc --noEmit` + `npm run build` 退出码 0（0.60）；`rg "buildImageTasks\(" src/core/images.ts` 只剩 barrel 导出（0.40）
- **Pass threshold:** Panel 均分 ≥ 4.0/5.0，J1、J2 ≥ 4.0。
- **Failure action:** 任何字节漂移 → 与搬迁前逐函数 diff 恢复原实现；导出面遗漏 → 补逐名导出直到 `vue-tsc` 绿；出现循环依赖 → 把共享类型下沉到 `types.ts` 再重跑。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-task-golden.ts` | unit (golden) | 搬移无字节漂移（任务身份/命名冻结） | A1、A2、C4 |
| `unit-image-prompt.ts` / `unit-image-references.ts` | unit | prompts/references 行为等价、参考图解析不变 | A1、A2 |
| `unit-chapter-image-scope.ts` / `unit-stage-cascade.ts` | unit | 任务 id 冻结后章节灯/级联计数不变 | A1、A2 |
| import/grep 审计 | static | 调用方未改、barrel 是唯一旧入口 | A1 |

- **Test Cases to Cover**
  - [golden] 搬移后任务金样逐字节不变（含 seed 与 role 顺序）
  - [unit] `fitImagePrompt` / `imagePromptLimitFor` / `promptLimitFromError` 边界
  - [unit] `resolveImageTaskReferences`：material 命中/缺失/多参考
  - [boundary] 空参考图任务；仅 `identity`；`identity+style+structure` 全量 role 顺序
  - [static] `rg`：`src/core/images.ts` 无私有实现残留，调用方 import 路径零变化
  - [build] `vue-tsc --noEmit`、`npm run build` 退出码 0

### Step 4: 内容审查阶梯参数化 —— `core/image/rewrite.ts`

**Phase:** 1 分离 · **Size:** M · **Depends on:** Step 3 · **Critical path:** 是

**Goal:** 把管线（LLM 四阶）与视觉守门（无 LLM 三阶）两份改写阶梯合并为唯一实现（A3/D9/K7），逐阶顺序与限次与现状一致。

**Subtasks**
- 新建 `src/core/image/rewrite.ts`：导出参数化阶梯（如 `runModerationLadder({ prompt, allowLlmRewrite, llmCfg, safeRewriteCfg, log, usage })`），封装 `sanitizePrompt`（规则阶）→ `chatCompletion` LLM 语义阶（仅 `allowLlmRewrite`）→ `appendSafeStyleSuffix`（全年龄后缀阶）。
- 管线变体：`images.ts` 内 `runImageTask` 的 `moderationStage` 循环改调共享实现，保留现行语义（第 1 阶规则改写未命中且配置 LLM 时并入第 2 阶、`moderationStage=2` 推进规则、最多 4 次业务尝试）。
- 视觉守门变体：`visualBible.ts` 的 `generateImageWithModerationRetry`（L532-555）改为共享实现的 `allowLlmRewrite: false` 预设（最多 3 次尝试）。
- 新增 `tests/unit-image-moderation.ts`：对两变体分别断言阶段顺序、最大尝试数、非审查错误原样抛出、规则改写未命中时的回退分支。

**Expected Outputs**
- `src/core/image/rewrite.ts` 单一实现；两处只剩调用点；新测试。

**Success Criteria**
- [ ] `rg "sanitizePrompt|appendSafeStyleSuffix" src/core` 只命中 `rewrite.ts`（`utils/promptRewriter.ts` 定义处除外）。
- [ ] `tests/unit-image-moderation.ts` 覆盖两变体且通过；`unit-visual-bible.ts`、`unit-image-abort.ts`、`unit-prompt-rewriter.ts` 全绿。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- Step 3（阶梯依赖 prompts 工具）。

**Risks & Mitigations**
- A3 要求顺序/限次与现状一致，合并时语义漂移 → 先写测试钉住两变体现行行为再替换。
- LLM 改写是额外付费调用 → 保留 `isAborted()` 检查；测试 mock `chatCompletion`。

**Verification**
- **Level:** Module（审查路径，影响过审率与费用）
- **Artifacts:** `rewrite.ts`、两调用点 diff、新测试输出。
- **Commands:** `node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`。
- **Pass threshold:** 全绿 + 两变体测试均命中共享实现。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/core/image/rewrite.ts`、`images.ts` / `visualBible.ts` 两调用点 diff、`tests/unit-image-moderation.ts`、grep 审计输出。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 语义等价 (correctness):** 管线变体阶梯顺序与限次（规则 → LLM → 全年龄，≤4 次业务尝试）与现状一致（0.40）；视觉守门变体（≤3 次、不调用 LLM）与现状一致（0.35）；非审查错误原样抛出、不消耗阶梯（0.25）
  - **J2 单一实现 (regression-safety):** `rg "sanitizePrompt|appendSafeStyleSuffix" src/core` 仅命中 `rewrite.ts`（0.50）；两调用点为薄封装、无行为分叉（0.50）
  - **J3 覆盖充分 (coverage):** 两变体分别单测命中共享实现（0.60）；`isAborted()` 检查在 LLM 阶前保留（0.40）
- **Pass threshold:** Panel 均分 ≥ 4.0/5.0，J1、J2 ≥ 4.0。
- **Failure action:** 顺序/限次漂移 → 先用现状写特征测试再逐阶比对移植；LLM 阶重复计费 → 恢复 abort 检查并补 mock `chatCompletion` 断言；删除旧实现不彻底 → 补 grep 清白后再合并。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-moderation.ts`（新） | unit | 两变体阶梯顺序/限次/错误传播等价，共用同一实现 | A3 |
| `unit-visual-bible.ts` | unit | 视觉守门调用经共享实现后行为不变 | A3、A1 |
| `unit-image-abort.ts` / `unit-prompt-rewriter.ts` | unit (regression) | 中止语义与底层重写器不被合并破坏 | A3、C2 |
| grep 审计 | static | 阶梯无第二份实现残留 | A3、C5 |

- **Test Cases to Cover**
  - [unit] 管线变体：规则改写命中 → 立即返回；未命中且配置 LLM → 进 LLM 语义阶；LLM 未命中 → 全年龄后缀
  - [unit] 视觉守门变体：`allowLlmRewrite=false` → 不调用 `chatCompletion`，最多 3 次尝试
  - [boundary] 每阶最多一次：第 4 次业务尝试仍失败 → 抛出原错误（不再追加尝试）
  - [unit] 非审查错误（网络/限流）原样抛出，不进入阶梯
  - [boundary] `isAborted()` 为真时 LLM 改写调用数为 0
  - [static] `rg`：`images.ts` / `visualBible.ts` 无阶梯副本，仅调用点

### Step 5: 纯搬移 B —— `execute.ts` / `batch.ts` / `ledger.ts` / `regen.ts`

**Phase:** 1 分离 · **Size:** L · **Depends on:** Step 4 · **Critical path:** 是

**Goal:** 把单任务执行、批次执行、资产账本与单素材重生成搬入 `core/image/`，保留协作式中止、persist-before-emit、依赖分层与队列锁语义（硬约束 (b)）。

**Subtasks**
- 新建 `src/core/image/execute.ts`：`runImageTask`（缓存 → 参考图 → 生成 → 抠图 → 自检递归）、`ensureCutout`、`tryAiCutout`；保留 L817-819 / 977 / 1100 / 1525 全部 `isAborted()` 检查点与「自检失败重生成一次」语义。
- 新建 `src/core/image/batch.ts`：`generateImages`（范围收窄、缓存预分区、五 pass 依赖分层、`emitProgress`、persist-before-emit 顺序、用户素材免费路径、CG 旧命名迁移）——本步保持定位参数签名不变。
- 新建 `src/core/image/ledger.ts`：`record` 覆盖计数、`updateAssetMap` 合并写、`repairImageAssets` / 孤儿清理助手（产出尺寸元数据留给 Step 10）。
- 搬移 `src/core/regenerate.ts` → `src/core/image/regen.ts`（`RegenContext`、`regenerateImages`、`imageTaskMatchesSelectionKey`、单素材包装函数），旧路径改 barrel。
- `src/core/images.ts` 与 `src/core/regenerate.ts` 只保留 barrel；内部私有实现删除干净。
- 跑回归墙 + `unit-regen-safety.ts`（额外：`unit-material.ts`）。

**Expected Outputs**
- `src/core/image/{execute,batch,ledger,regen}.ts`；两个旧路径 barrel；全部调用方（`pipeline.ts`、`stores/generate.ts`、`stores/project.ts`、`AssetPanel.vue`、`useStageStatus.ts`）不改 import。

**Success Criteria**
- [ ] `unit-image-abort.ts`（中止后 0 新请求、在途结果保留）、`unit-partial-rerun.ts`、`unit-regen-safety.ts`、`unit-chapter-image-scope.ts`、`unit-chapter-prune.ts` 全绿。
- [ ] `unit-image-task-golden.ts`、`unit-image-request-shape.ts` 仍绿（无字节漂移）。
- [ ] `rg "await generateImage\(" src/core` 仅命中 `execute.ts`（gate 在 Step 6 收敛）。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- Step 4 未完成。

**Risks & Mitigations**
- R4 中止/进度/持久化顺序回退 → 逐段复制不改逻辑；依赖既有测试墙，不顺手重构。
- `batch.ts` 与 store 实时轮询 / 队列锁耦合 → 不改 `assets.json` schema、不改进度事件形状。

**Verification**
- **Level:** Module（付费执行路径）
- **Artifacts:** 新模块、barrel diff、回归墙输出。
- **Commands:** `node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`；`npm run build`。
- **Pass threshold:** 回归墙全绿 + 无调用方 import 变化。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/core/image/{execute,batch,ledger,regen}.ts`、两个旧路径 barrel、回归墙输出、abort/持久化语义 diff。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 行为等价 (correctness):** `isAborted()` 检查点（原 L817-819/977/1100/1525 对应位）全部保留（0.35）；五 pass 依赖分层 + persist-before-emit 顺序不变（0.35）；`generateImages` 定位参数签名与进度事件形状不变（0.30）
  - **J2 回归安全 (regression-safety):** `unit-image-abort` / `unit-partial-rerun` / `unit-regen-safety` / `unit-chapter-image-scope` / `unit-chapter-prune` / 金样全绿（0.50）；`assets.json` schema 与 store 实时轮询未被触碰（0.25）；调用方 import 未改（0.25）
  - **J3 覆盖充分 (coverage):** `rg "await generateImage\(" src/core` 仅命中 `execute.ts`（0.50）；三件套全绿（0.50）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（付费执行路径 + 硬约束 (b)），J1、J2 ≥ 4.0。
- **Failure action:** 中止/顺序语义漂移 → 以搬移前文件逐段对照恢复，禁止顺手重构；新增付费入口 → 收敛回 execute 后重跑回归墙；store 兼容问题 → 保持事件/字段形状并重跑单章流程套件。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-abort.ts` | unit | 中止后 0 新付费请求、在途结果保留 | C2、硬约束 (b) |
| `unit-partial-rerun.ts` / `unit-regen-safety.ts` | unit | 部分重跑/单素材重生成语义不变 | A1、C4、硬约束 (b) |
| `unit-chapter-image-scope.ts` / `unit-chapter-prune.ts` / `unit-stage-cascade.ts` | unit | 章节灯/级联/缺图计数与缓存分区一致 | A1、硬约束 (b) |
| 金样 + grep 审计 | unit (golden) + static | 无字节漂移、付费入口收敛到 execute | A2、C4、C5 |

- **Test Cases to Cover**
  - [unit] 中止：发出中止信号后观察到的请求数 = 0，已完成任务结果保留
  - [unit] persist-before-emit：先写 `assets.json` 再发进度事件（顺序断言）
  - [unit] 用户素材免费路径与新生成路径分区不串（缓存命中计数）
  - [boundary] 空范围 / 全部命中缓存 / 单任务失败继续其余任务（部分失败）
  - [golden] 任务金样、请求金样在搬移后仍绿
  - [static] `rg "await generateImage\(" src/core` 仅 `execute.ts`；调用方 import 零变化

### Step 6: 视觉守门出图单一入口 —— `core/image/gate.ts`

**Phase:** 1 分离 · **Size:** L · **Depends on:** Step 5 · **Critical path:** 否（阻塞 A1 与 Step 11）

**Goal:** 把 `visualBible.ts` 出图调用收敛为 `core/image/gate.ts` 单一入口（A1/K12），审批/指纹/清单等图片无关职责留在原处。

**Subtasks**
- 新建 `src/core/image/gate.ts`：`generateVisualGateImage(deps, cfg, prompt, options)` 封装「策略解析（Step 7 前走现状）→ 改写阶梯（Step 4）→ `generateImage` 调用 → 产物写入」；保持 `VisualBibleServiceDependencies.generateImage` 注入面不变。
- 迁移 `visualBible.ts` 出图调用点：`generateCostumeSheets` L497、`createDraftStyle` L663、三视图 L715、regen 入口 L841/875/939/1086/1282 —— 全部经 `gate.ts`。
- 删除 `visualBible.ts` 私有 `generateImageWithModerationRetry`（Step 4 已委派，此处彻底移除）。
- 跑 `unit-visual-bible.ts`、`unit-visual-bible-scope.ts`、`unit-visual-invalidation-scope.ts`、`unit-visual-approval-resume.ts`、`unit-visual-bible-workflow.ts`。

**Expected Outputs**
- `src/core/image/gate.ts`；`visualBible.ts` 出图 0 处直连；审批/指纹逻辑 diff 为 0。

**Success Criteria**
- [ ] `rg "generateImage\(" src/core/visualBible.ts` 只剩依赖注入声明（L88 接口）与 `DEFAULT_DEPENDENCIES` 委派，无业务调用点。
- [ ] 5 个视觉守门测试套件全绿；审批/指纹/失效范围断言不变。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- Step 5（execute/ledger 已就位）。

**Risks & Mitigations**
- R5 视觉守门与管线产出不一致 → gate 与 execute 共享 rewrite/policy（K12），但不共用缓存/进度执行器，避免把审批语义拖进批次。
- 依赖注入被测试 mock → 保持 interface 形状，仅内部实现换 gate。

**Verification**
- **Level:** Panel（角色一致性关键路径）
- **Artifacts:** gate.ts、visualBible diff、5 套件输出。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** 视觉守门套件全绿 + 出图调用点归零。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/core/image/gate.ts`、`visualBible.ts` 9 处调用点 diff、审批/指纹逻辑 diff（应为 0）、5 套视觉守门测试输出。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 行为等价 (correctness):** 9 处出图（服装 L497、画风样张 L663、三视图 L715、regen L841/875/939/1086/1282 等）全部经 gate，无直连（0.40）；gate 复用 Step 4 阶梯与现有策略、不新造分叉（0.35）；`VisualBibleServiceDependencies.generateImage` 注入面形状不变（0.25）
  - **J2 回归安全 (regression-safety):** 5 个视觉守门套件全绿（0.55）；审批/指纹/失效范围逻辑 diff = 0（0.45）
  - **J3 覆盖充分 (coverage):** `rg "generateImage\(" src/core/visualBible.ts` 只剩 DI 声明与 `DEFAULT_DEPENDENCIES` 委派（0.60）；三件套全绿（0.40）
- **Pass threshold:** Panel 均分 ≥ 4.0/5.0，J1、J2 ≥ 4.0。
- **Failure action:** 有直连 → 补迁移到 gate 后逐一复测；审批/指纹被牵动 → 回退该 diff（gate 只收出图）；mock 形状破坏 → 保持 interface 并重跑 5 套件。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-visual-bible.ts` / `unit-visual-bible-scope.ts` | unit | 三视图/服装/画风样张经 gate 后产物与范围不变 | A1、A3 |
| `unit-visual-invalidation-scope.ts` / `unit-visual-approval-resume.ts` / `unit-visual-bible-workflow.ts` | unit (regression) | 审批/指纹/失效范围不受出图收敛影响 | A1 |
| grep 审计 | static | `visualBible.ts` 无直接付费出图调用点 | A1、C5 |

- **Test Cases to Cover**
  - [unit] 画风样张 / 三视图 / 服装三路径均经 gate（mock 计数 = 1 个入口）
  - [unit] gate 内部走共享阶梯（审查拒绝 → 阶梯 → 重试一致）
  - [boundary] 审批暂停 → 恢复后仍从 gate 出图；失效范围不扩大
  - [unit] 三视图请求仍保留其参考图用途与背景（现状等价）
  - [static] `rg "generateImage\(" src/core/visualBible.ts` 仅 DI/委派

### Step 7: 请求策略抽象 —— `api/image/policy.ts` + 能力记录 v2 + options 对象

**Phase:** 1 分离 · **Size:** L · **Depends on:** Step 6 · **Critical path:** 是

**Goal:** 建立按「生效模型」解析的 `ImageRequestPolicy`，把能力记录升级为模型键控且非破坏写回（K4/K8），并把 `generateImages` 定位参数改为 options 对象，为 Steps 8–11 提供单一策略入口。

**Subtasks**
- 新建 `src/api/image/policy.ts`：`resolveImageRequestPolicy(cfg)` 输出 `{ sizeRule, allowedParams（response_format/seed/quality/background/output_format/moderation）, refRoute, refLimit, refEncoding, promptLimit }`；非 GPT 模型策略等价于现状（GPT 分支由 Steps 8–10 填充）。
- `src/api/providers.ts`：`resolveImageModelCapabilities` 先读 v2 记录 `{ version: 2, model, caps, probedAt }`（`model === cfg.model` 才可信），v1 槽位记录仅在 model 匹配时兼容读取；`customImageCapabilities` 上限 3 → 16（B3/D15）；新增非破坏合并助手（供 Step 12 探测写回）。
- `src/stores/configMigration.ts` + `src/stores/config.ts`：能力 v2 迁移与 `applyTemplate` 清理过期能力/探测记录；必要时同步 `src/utils/persist.ts` 快照兼容。
- `generateImages` 改 options 对象（`io: { cacheRoot, log, materials, onProgress }` + `opts: ImageBatchOptions`），同步改 `src/core/pipeline.ts:1840` 调用点、`stores/generate.ts` 的 `regenImageCtx` 与 `core/image/regen.ts` 传参；字段一一对应、行为等价。
- 新增 `tests/unit-image-capabilities-v2.ts`：v1 记录换模型后忽略、同模型时兼容、未知模型 0 参考图、上限 16 可通过校验、换模板清理记录。

**Expected Outputs**
- `policy.ts`、能力 v2 读写与迁移、options 对象签名；非 GPT 金样测试仍绿。

**Success Criteria**
- [ ] `tests/unit-image-capabilities-v2.ts`、`unit-providers.ts`、`unit-image-request-shape.ts` 全绿。
- [ ] `rg "maxReferenceImages > 3" src` 无残留校验；v2 记录含 `version` 与 `model` 字段。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0；`pipeline.ts` 调用点与 store 传参无遗漏。

**Blockers**
- Step 6（gate 需同批接入 policy，避免二次改同一批文件）。

**Risks & Mitigations**
- R3 迁移把旧配置读坏 → 迁移只做「读时兼容 + 首次写回升级」，不删原始字段；跑 `unit-persist.ts`、`unit-vfs.ts`。
- options 对象改造引入行为漂移 → 机械替换 + 全量图像测试 + 金样请求测试把关。

**Verification**
- **Level:** Panel（配置持久化 + 全线路请求入口）
- **Artifacts:** policy.ts、providers/config 迁移 diff、新测试。
- **Commands:** `node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`。
- **Pass threshold:** 全绿 + 非 GPT 请求金样逐字段等价。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/api/image/policy.ts`、`providers.ts` 能力 v2 读写与迁移 diff、`configMigration.ts` / `config.ts` 改动、options 对象签名 diff、`unit-image-capabilities-v2.ts`。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 正确性 (correctness):** policy 按「生效模型」（`cfg.model`）解析，槽位记录不参与判定（0.35）；options 对象字段与旧定位参数一一对应、调用点（`pipeline.ts:1840`、store、`regen.ts`）无遗漏（0.35）；v2 记录含 `version:2` / `model` / `caps` / `probedAt`（0.30）
  - **J2 回归安全 (regression-safety):** 非 GPT 请求金样逐字段等价（0.50）；迁移只做「读时兼容 + 首次写回升级」，不删原始字段、不破坏持久化（0.50）
  - **J3 覆盖充分 (coverage):** `unit-image-capabilities-v2` / `unit-providers` / `unit-persist` / `unit-vfs` 全绿（0.50）；`rg "maxReferenceImages > 3" src` 无残留校验（0.50）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（配置持久化 + 全线路请求入口），J1、J2 ≥ 4.0。
- **Failure action:** 迁移读坏旧配置 → 恢复兼容读取并以 `unit-persist` 复测；options 漏字段 → 用金样请求逐个比对补齐；非 GPT 请求漂移 → 回退 policy 中非 GPT 分支至现状等价实现。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-capabilities-v2.ts`（新） | unit | v2 模型键控、v1 换模型忽略、上限 16、换模板清理 | B3、C1、A1 |
| `unit-providers.ts` | unit | 能力表读写与探测辅助不回归 | B3、C1 |
| `unit-image-request-shape.ts` | unit (golden) | options 化后非 GPT 请求逐字段不变 | A2 |
| `unit-persist.ts` / `unit-vfs.ts` | unit (regression) | 迁移/写回不破坏快照与 web runtime | NFR-兼容性 |

- **Test Cases to Cover**
  - [unit] v1 槽位记录：`model !== cfg.model` → 忽略；同模型 → 兼容读取
  - [boundary] `maxReferenceImages = 16` 通过校验；`17` 被拒；能力编辑器 0–16
  - [unit] 未知模型 → 0 参考图、保守默认
  - [unit] 换模板 → 清理过期能力/探测记录；再换回不产生脏数据
  - [unit] `generateImages` options 对象：新旧签名同 fixture 产出相同结果
  - [unit] `resolveImageRequestPolicy` 对 5 个非 GPT 线路返回与现状等价参数集
  - [static] `rg "maxReferenceImages > 3" src` 无残留

### Step 8: GPT-Image 严格端点形态 + 模型矩阵

**Phase:** 2 优化 · **Size:** L · **Depends on:** Step 7 · **Critical path:** 是

**Goal:** 让 GPT-Image 系列在官方/严格端点可用：不发不支持参数、模型矩阵补齐、参考图容量记录放开（B1/B3）。

**Subtasks**
- 新建 `src/api/image/openai.ts`：`isGptImageFamily(model)`（1 / 1-mini / 1.5 / 2 / 2.5-flare / 2.5-sunburst / 带日期快照）、GPT 家族参数门控（禁 `response_format`、禁 `seed`、2/2.5 禁 `input_fidelity`）、可执行错误映射（组织验证 400、`unknown_parameter`、输出阶段审查）。
- `src/api/templates.ts`：新增 `openai-image-strict`（无 `response_format`/`seed`，其余与 `openai-image` 等价）；OpenAI 协议 + GPT 家族按 policy 选择 strict 变体；中转线路默认继续 `openai-image`（不按模型名强制切换，K3/K13）。
- `src/api/providers.ts`：`KNOWN_IMAGE_CAPABILITIES` 补 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` / `gpt-image-2`（16 参考图）/ `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini`；`PROVIDERS.openai.defaults.image` 升级为 `gpt-image-2.5-flare`；移除 dall-e 默认引导（保留分类正则兼容）。
- `src/api/openaiCompatible.ts`：`generateImage` 改由 `resolveImageRequestPolicy` 决定模板/参数；图像调用接入 `pathPrefix`（顺带修 D6）。
- 新增 `tests/unit-image-provider-matrix.ts`，并更新 `unit-providers.ts`、`unit-image-prompt.ts`（GPT prompt 上限 32000 若加入）、`unit-image-request-shape.ts`（strict 端点拒绝 `response_format` 用例）。

**Expected Outputs**
- strict 模板 + GPT 家族形态模块 + 新模型能力表；非 GPT 行为不变。

**Success Criteria**
- [ ] 假「严格端点」（收到 `response_format`/`seed` 即 400）对 GPT 家族文生图返回成功；中转线路请求体与金样一致。
- [ ] `knownImageModelCapabilities("gpt-image-2.5-flare")` 返回 16 参考图、`supportsSeed: false`；`unit-providers.ts` 更新后全绿。
- [ ] `unit-image-request-shape.ts` 新用例通过；`vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- 未知中转可能拒绝 strict 形态或反过来依赖 `response_format` → 由 capabilities/refRoute 选择，不按模型名一刀切。

**Risks & Mitigations**
- R2 改共享 `openai-image` 模板误伤中转 → 新增模板而非改旧模板；金样钉住旧模板逐字段。
- 模型矩阵过期 → 记录核验日期与来源（Step 15 文档）。

**Verification**
- **Level:** Provider contract
- **Artifacts:** strict 模板、openai.ts、能力表、测试输出。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** strict 用例 + 非 GPT 金样同时通过。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/api/image/openai.ts`、`templates.ts` 的 `openai-image-strict`、`providers.ts` 模型矩阵、`openaiCompatible.ts` policy 接入 diff、`unit-image-provider-matrix.ts`。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 正确性 (correctness):** strict 变体不携带 `response_format`/`seed` 且其余与 `openai-image` 等价（0.35）；GPT 家族识别覆盖 1 / 1-mini / 1.5 / 2 / 2.5-flare / 2.5-sunburst / 日期快照（0.35）；新模型能力表（16 参考图、`supportsSeed:false`）与默认模型升级（0.30）
  - **J2 回归安全 (regression-safety):** 旧 `openai-image` 模板金样逐字段不变（0.50）；中转线路不按模型名强制切换 strict（0.50）
  - **J3 覆盖充分 (coverage):** 假严格端点用例（含 `seed` 拒绝分支）（0.40）；`pathPrefix` 生效（D6）（0.30）；provider matrix 用例（0.30）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（GPT 请求塑形），J1、J2 ≥ 4.0。
- **Failure action:** 误伤中转 → 改为新增模板而非修改旧模板；模型矩阵缺行 → 按 SKILL.md 核验日期补行并更新测试；`unknown_parameter` 未分类 → 在 `openai.ts` 补映射后重跑。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-provider-matrix.ts`（新） | unit (matrix) | 新模型行/尺寸/参数/参考图上限矩阵正确 | B1、B3 |
| `unit-image-request-shape.ts`（扩充） | unit (contract) | strict 端点无 `response_format`/`seed`；非 GPT 金样不变 | B1、A2 |
| `unit-providers.ts`（更新） | unit | `knownImageModelCapabilities` 与默认模型升级 | B3 |
| `unit-image-prompt.ts`（如含上限） | unit | GPT prompt 上限 32000 按模型解析 | B1 |

- **Test Cases to Cover**
  - [provider] 假严格端点：请求含 `response_format` 或 `seed` → 400；GPT 家族文生图 → 200
  - [unit] `isGptImageFamily`：`gpt-image-2-2026-04-21` / `2.5-flare` / `2.5-sunburst` / `1-mini` 全命中；非 GPT 名称不误判
  - [unit] `knownImageModelCapabilities("gpt-image-2.5-flare")` → 16 参考图、`supportsSeed:false`；`gpt-image-1` / `1.5` / `2` / `1-mini` 逐行
  - [boundary] 参数门控：2/2.5 禁 `input_fidelity`；同参数在非 GPT 模板照发
  - [unit] 图像调用 `pathPrefix` 拼接正确（D6）
  - [golden] 非 GPT 请求体逐字段金样在 strict 接入后不变

### Step 9: 参考图路由 —— edits multipart + relay 回退

**Phase:** 2 优化 · **Size:** L · **Depends on:** Step 8 · **Critical path:** 是

**Goal:** 需要参考图的 GPT-Image 任务走官方编辑路由（multipart `image[]`，≤16 张、每张 <50MB），仅有 JSON 文生图端点的线路自动回退且不静默丢图（B2/C3/K5）。

**Subtasks**
- `src/api/universal.ts`：`AdapterTemplate` 增加二进制文件 part 支持（如 `fileParts`），`buildMultipartBody` 输出重复字段 `image[]` 与正确 `Content-Disposition`/mime；图像调用接入 `pathPrefix`（`joinUrl(normalizeBaseUrl(...))`，D6）。
- `src/api/templates.ts`：新增 `openai-image-edits`（`POST /v1/images/edits`、multipart、`image[]` 多张、`prompt`/`size`/`model`，可选 `background`/`quality`/`output_format` 由 policy 填入）；`openai-image` 保持 relay JSON 形态。
- `src/api/image/policy.ts`：`refRoute` 决定 `generations-json` / `edits-multipart`；`generateImage` 有参考图且 policy=edits 时走 edits，否则走 generations；继续抛既有 `REFERENCE_UNSUPPORTED` / `REFERENCE_MISSING`，绝不静默丢弃必需参考图。
- 新增 `tests/unit-openai-edits.ts`：fake `tauri.http` 断言 multipart 边界、多个 `image[]` part 顺序与 content-type、≤16 上限、无 `response_format`/`seed`；覆盖「仅 edits」与「仅 JSON」两个假服务端场景（B2）。
- 扩充 `tests/unit-image-reference-route.ts`：413/拒绝语义回归不变。

**Expected Outputs**
- multipart 二进制传输能力、edits 模板、`refRoute` 选择逻辑、新测试。

**Success Criteria**
- [ ] `unit-openai-edits.ts` 通过；假服务端 A（只开 edits）与 B（只认 JSON generations）都成功且都不丢参考图。
- [ ] `unit-image-reference-route.ts`、`unit-image-references.ts`、`unit-material.ts` 全绿。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0；请求体大小有守卫（超 64 MiB Tauri 上限前拒绝并给出可读错误）。

**Blockers**
- Rust 传输 64 MiB 上限（K14）；edits 多图 b64 膨胀可能触顶 → 守卫 + 文档说明，必要时按需调整上限（本步不做流式）。

**Risks & Mitigations**
- R8 大载荷 / 多图触发上限 → 请求前估算并记录；触顶时回退单图或明确报错。
- 中转不支持 edits → `refRoute` 由能力/探测决定，默认保守走 generations（可靠优先）。

**Verification**
- **Level:** Provider contract（付费路径）
- **Artifacts:** universal/templates/policy diff、新测试。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** 两个假服务端场景 + 现有参考图套件全绿。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `universal.ts` multipart 二进制 part、`templates.ts` `openai-image-edits`、`policy.ts` `refRoute`、`unit-openai-edits.ts`、`unit-image-reference-route.ts` 扩充。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 正确性 (correctness):** multipart 边界/`image[]` 重复字段/`Content-Disposition`/mime 正确且顺序稳定（0.35）；`refRoute` 按能力显式选择，仅 JSON 线路回退 generations 仍成功（0.35）；≤16 张、单张 <50MB、总载荷在 64 MiB 前可读拒绝（0.30）
  - **J2 语义安全 (regression-safety):** 不静默丢参考图；`REFERENCE_UNSUPPORTED` / `REFERENCE_MISSING` 语义保留（0.50）；413/拒绝回归不变（0.25）；既有参考图套件全绿（0.25）
  - **J3 覆盖充分 (coverage):** 假服务端 A（仅 edits）/ B（仅 JSON）双场景（0.50）；非 GPT 金样不回退（0.50）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（付费路径），J1、J2 ≥ 4.0。
- **Failure action:** multipart 构造错 → 对照官方 `image[]` 形态修正并更新单测；回退时丢图 → 改为类型化拒绝或保持参考图；载荷超限 → 补估算/守卫与可读错误后再合并。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-openai-edits.ts`（新） | unit (contract) | multipart 构造、顺序、上限、参数门控 | B2、B1 |
| `unit-image-reference-route.ts`（扩充） | unit (regression) | 413/类型化拒绝语义不变 | C3 |
| `unit-image-references.ts` / `unit-material.ts` | unit | 参考图解析/素材复制不回归 | B2、A1 |
| 假服务端 A/B 场景 | provider | 仅 edits / 仅 JSON 两条线路都成功且不丢图 | B2、C3 |

- **Test Cases to Cover**
  - [unit] multipart：边界串、多个 `image[]` part 顺序与各自 content-type、`prompt`/`size`/`model` 字段
  - [boundary] 参考图 16 张通过；17 张拒绝；单张 >50MB 拒绝；总载荷触 64 MiB 前报可读错误
  - [provider] A（仅 edits）：任务携带全部参考图成功；B（仅 JSON generations）：回退成功且参考图未被静默丢弃
  - [unit] `refRoute=generations-json` 时不发 multipart；`edits-multipart` 时不发 JSON `image`
  - [unit] 413 回执 → 类型化错误、不重试、不丢参考图（现状回归）
  - [unit] GPT 家族 edits 请求无 `response_format`/`seed`

### Step 10: 尺寸安全映射 + 缓存闭环（无重画重扣费）

**Phase:** 2 优化 · **Size:** L · **Depends on:** Step 9 · **Critical path:** 是

**Goal:** 请求尺寸不在模型支持集合内时确定性映射并记录生效尺寸；缓存以「实际产出尺寸」判定，二次运行 0 付费请求（B4/B5/C4/K8/K9）。

**Subtasks**
- `src/api/image/policy.ts`：按模型实现尺寸矩阵——`gpt-image-2/2.5` 任意分辨率（宽高为 16 倍数、比例 ≤3:1、总像素 655,360–8,294,400、边 ≤3840）直出，越界映射最近支持尺寸或 `auto`；`gpt-image-1/1.5` 仅 `1024x1024 / 1536x1024 / 1024x1536 / auto`；`512x512` 测试图与 `1024x576` 锚点/画风样张全部走该映射（D5）。
- `src/core/image/ledger.ts`：新增 `cache/images/.image-meta.json` 读写（串行写、条目随孤儿清理），记录 `{ size: "WxH", model, at }`。
- `core/image/execute.ts` + `batch.ts`：缓存校验改为「有记录 → 比对记录尺寸；无记录 → 视为有效（旧文件）」；生成成功后写入实际产出尺寸；删除 `imageSizeMatches` 作为缓存有效性判定（保留为诊断/元数据写入工具）。
- 日志：每次映射输出「请求尺寸 → 生效尺寸（原因）」。
- 新增 `tests/unit-image-cache-closure.ts`：连续两次运行第二次 0 请求；旧缓存（无 meta）视为有效；尺寸映射确定性；`.image-meta.json` 并发写不丢条目。

**Expected Outputs**
- 尺寸策略 + 产出尺寸元数据 + 缓存闭环；旧缓存零作废。

**Success Criteria**
- [ ] B4 场景：请求 1024x576 的锚点在 1/1.5 上映射到支持尺寸并记录，二跑无请求；B5 场景：2/2.5 上非标准尺寸（如 1536x864）直出不映射。
- [ ] C4 场景：改造前落盘的缓存（无 meta）运行时请求数为 0。
- [ ] `unit-image-cache-closure.ts`、`unit-image-task-golden.ts`、`unit-regen-safety.ts` 全绿；`vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- Step 9（尺寸与路由共用 policy）。

**Risks & Mitigations**
- R1 元数据/映射改动导致整书重画 → 无记录旧文件一律有效；升级首跑以请求计数断言 0。
- meta 与真实文件不一致 → 写入时用 `tauri.imageSizeMatches` 校验；读取以记录为准，文件缺失即失效。

**Verification**
- **Level:** Panel（缓存/计费核心）
- **Artifacts:** policy 尺寸段、`.image-meta.json` 助手、execute/batch diff、新测试。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** B4/B5/C4 三个场景用例全部通过。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `policy.ts` 尺寸矩阵、`ledger.ts` `.image-meta.json` 助手、`execute.ts`/`batch.ts` 缓存判定 diff、`unit-image-cache-closure.ts`。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 正确性 (correctness):** 2/2.5 任意尺寸约束（宽高 16 倍数、比例 1:3–3:1、655,360–8,294,400 像素、边 ≤3840）直出；1/1.5 仅 4 档（0.35）；越界映射确定性 + 日志「请求 → 生效（原因）」（0.35）；meta 记录实际产出尺寸且 `imageSizeMatches` 不再作缓存判定（0.30）
  - **J2 计费安全 (regression-safety):** 同任务二跑 0 付费请求（0.40）；无 meta 旧文件视为有效（0.35）；不存在「拿最新映射反复比对」路径（0.25）
  - **J3 覆盖充分 (coverage):** `unit-image-cache-closure` / `unit-image-task-golden` / `unit-regen-safety` 全绿（0.50）；meta 并发写不丢条目、随孤儿清理（0.50）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（缓存/计费核心），J1、J2 ≥ 4.0。
- **Failure action:** 二跑仍发请求 → 定位 meta 写入/读取或比对逻辑并修复后复跑；旧缓存被作废 → 恢复「无记录即有效」并按 C4 用例断言 0 请求；映射不确定 → 固化规则与测试（同输入同输出）。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-cache-closure.ts`（新） | unit | 尺寸映射确定性 + 二次运行 0 请求 + 旧缓存复用 | B4、B5、C4 |
| `unit-image-task-golden.ts` | unit (golden) | 尺寸映射不改变任务身份/命名 | C4、A2 |
| `unit-regen-safety.ts` | unit (regression) | 缓存判定改动不引发重生成风暴 | C4、C2 |
| `unit-visual-bible.ts` | unit (regression) | 画风样张等小尺寸走 policy 映射 | B4 |

- **Test Cases to Cover**
  - [unit] B4：请求 1024x576 在 1/1.5 映射到支持档并记录；二跑请求数 = 0
  - [unit] B5：2/2.5 下 1536x864 直出（不映射）；越界尺寸（如 4096x2160 / 8x8 / 3840x1280 边界）按规则映射
  - [boundary] 像素面积下界 655,360 与上界 8,294,400；宽高 16 倍数边界（15/16/17）
  - [unit] C4：改造前落盘缓存（无 meta）→ 运行时请求数 0
  - [unit] meta 并发写（串行队列）不丢条目；删除孤儿图片时条目被清理
  - [unit] `.image-meta.json` 缺失/损坏 → 视为无记录（有效），不触发重画
  - [observability] 映射日志包含请求尺寸、生效尺寸与原因，可按任务号检索

### Step 11: 原生透明背景 + 可选参数透传

**Phase:** 2 优化 · **Size:** M · **Depends on:** Step 10 · **Critical path:** 否

**Goal:** 支持原生透明 PNG（立绘/情绪/服装/动作/物品），失败单次回退绿幕抠图；quality/output_format/moderation 仅在配置显式设置且模型支持时透传（B6/B7/K10）。

**Subtasks**
- `api/image/policy.ts` + `openai.ts`：`supportsTransparentBackground(model)`（2.5 默认开、2 标记 preview 按配置开、1/1.5 按文档能力）；`quality/output_format/moderation` 门控与默认值（未配置不发送）。
- `core/image/tasks.ts` + `prompts.ts`：透明模式的任务不追加 `FIGURE_BG_SUFFIX`/`ITEM_BG_SUFFIX`（三视图/背景/CG/锚点保持现状）；`fileName`/id 不变（K11）。
- `core/image/execute.ts`：请求带 `background=transparent` + `output_format=png`，返回带 alpha 时跳过色度键；失败自动回退原绿幕链路（单次，不循环）并在日志说明原因；`src/core/selfcheck.ts` 系统提示同时接受「纯色绿幕」与「透明背景」。
- `src/pages/ConfigPage.vue`（或配置入口）：透明/质量/格式旋钮按需暴露（B7 默认可走配置不暴露 UI）；`src/i18n/*` + `scripts/i18n-keys.txt` 同步。
- 新增 `tests/unit-image-transparency.ts`：支持透明假服务端断言无绿幕后缀、落盘 alpha、无抠图；拒绝透明假服务端断言一次回退 + 成功产出；三视图请求断言仍含绿幕后缀。

**Expected Outputs**
- 透明路径与回退、可选参数门控、selfcheck 双模式、新测试。

**Success Criteria**
- [ ] B6 两分支测试通过；`unit-image-prompt.ts`、selfcheck 相关断言、`unit-visual-bible.ts`（三视图仍绿幕）全绿。
- [ ] 未配置 quality/format 时请求体不含对应字段（金样断言）；配置后日志可见实际生效值。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- 2/2.5 透明能力差异（preview 标注）→ 能力表按模型写入并允许配置覆盖。

**Risks & Mitigations**
- 透明失败导致循环重试 / 重复扣费 → 回退仅一次且复用同一 `fileName`；保留 `isAborted()` 检查点。
- selfcheck 把透明当好图 / 坏图误判 → 双模式提示词 + 现有严格判定不变。

**Verification**
- **Level:** Module（产物质量 + 成本）
- **Artifacts:** policy/execute/tasks diff、selfcheck diff、新测试。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** 透明成功 / 回退 / 三视图不受影响三条路径全绿。

**LLM Verification (Judge)**
- **Judge level:** Single
- **Artifacts to judge:** `policy.ts`/`openai.ts` 透明与参数门控、`tasks.ts`/`prompts.ts` 后缀差异、`execute.ts` 透明分支与单次回退、`selfcheck.ts` 双模式、`unit-image-transparency.ts`。
- **Rubric（单一裁判，每项 1–5，权重合计 1.00）:**
  - 透明成功路径：请求 `background=transparent` + `output_format=png`、无绿幕后缀、落盘带 alpha 且跳过色度键（0.35）
  - 回退正确：拒绝时仅一次回退、复用同一 `fileName`、日志说明原因、不循环不重复扣费（0.30）
  - 参数门控：quality / output_format / moderation 仅在显式配置且模型支持时发送，未配置不发送、不注入默认（0.20）
  - 范围收敛：三视图/背景/CG/锚点保持现状（三视图仍含绿幕后缀）（0.15）
- **Pass threshold:** 加权分 ≥ 4.0/5.0；「透明成功」「单次回退」两项均须 ≥ 4.0。
- **Failure action:** 透明模式误套到三视图 → 收窄 `supportsTransparentBackground` 门控的素材集合并复测；回退循环 → 改为显式单次标记并补计数断言；参数默认注入 → 删除推断默认值，仅按配置透传。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-transparency.ts`（新） | unit | 透明成功 / 单次回退 / 三视图不受影响 | B6、B7 |
| `unit-image-prompt.ts` | unit (regression) | 绿幕后缀常量在非透明路径不变 | B6、A2 |
| `unit-visual-bible.ts` | unit (regression) | 三视图仍走绿幕链路 | B6 |
| selfcheck 相关断言 | unit | 绿幕与透明双模式均可通过判定 | B6 |

- **Test Cases to Cover**
  - [unit] 支持透明假服务端：立绘任务请求含 `background=transparent`/`output_format=png`、prompt 无 `FIGURE_BG_SUFFIX`、产物 alpha、抠图调用 0 次
  - [unit] 拒绝透明假服务端：恰好 1 次回退、绿幕链路成功、日志含回退原因
  - [unit] 三视图/背景/CG/锚点：请求形态与改造前一致（三视图仍含 `THREEVIEW_GREEN_SUFFIX`）
  - [boundary] 2.5 默认开 / 2 按配置开 / 1、1.5 按能力；同一素材 `fileName` 在两条路径一致（K11）
  - [boundary] 未配置 quality/output_format/moderation → 请求体不含字段；配置且支持 → 含值；配置但不支持 → 不发送
  - [unit] selfcheck 对带 alpha 与纯绿幕产物均判定通过

### Step 12: 能力探测重做（真发必需参考图 + 非破坏写回）

**Phase:** 3 缺陷 · **Size:** M · **Depends on:** Step 9 · **Critical path:** 否（阻塞 C1 与 Step 14）

**Goal:** 消除探测假阳性与失败覆盖已知能力：探测必须真的发送「必需」参考图并校验响应，只在成功时增量写回 v2 记录（C1/D4/D13/K13）。

**Subtasks**
- 新建 `src/api/image/probe.ts`：`probeImageEditSupport(cfg)` 用 `required: true` 的 identity 小图、按 policy 的路由/尺寸发探测请求；校验「参考图确实被送出」（路由/模板能表达参考图，否则直接判不支持）与响应 b64 有效性；最多消耗 2 张额度。
- `src/api/openaiCompatible.ts`：`testImage` 调用新探测，写回改为 v2 非破坏合并（`probedAt`、失败不覆盖已知/已有能力）；`testImage` 文生图测试尺寸走 policy（D5）。
- `src/pages/ConfigPage.vue`：按模型展示探测结果与「重置探测记录」入口；能力编辑器上限 0–3 → 0–16；测试连接成本提示与错误可执行文案；`src/i18n/*` + `scripts/i18n-keys.txt` 同步。
- 新增 `tests/unit-image-probe.ts`：三态假服务端（接受并携带参考图 / 接受但丢弃 / 拒绝）分别断言 `支持 / 不支持 / 不支持`；已知模型（`gpt-image-2`）探测失败后能力记录不变；`model` 字段与 v1 记录隔离。
- 扩充 `tests/unit-image-reference-route.ts`：探测必须先送必需参考图才能判支持（D4a 回归）。

**Expected Outputs**
- `api/image/probe.ts`、非破坏写回、ConfigPage 展示/重置/上限、新测试。

**Success Criteria**
- [ ] C1 三态用例通过；已知型号 `supportsSeed`/`referenceEncoding` 不被改动。
- [ ] `unit-image-reference-route.ts` 新增回归通过；`unit-vision-config.ts`、`unit-persist.ts` 全绿；`node scripts/check-i18n.mjs` 通过。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- 中转行为不可知 → 保守判不支持并保留手动覆盖（K13 代价项）。

**Risks & Mitigations**
- R3 探测写坏配置 → 非破坏合并 + v2 版本化 + 重置入口 + 测试断言。
- 探测费用 → 上限 2 张、UI 明确提示。

**Verification**
- **Level:** Panel（持久化配置 + 真实探测）
- **Artifacts:** probe.ts、write-back diff、ConfigPage/i18n diff、新测试。
- **Commands:** `node scripts/run-tests.mjs`；`node scripts/check-i18n.mjs`。
- **Pass threshold:** 三态 + 写回保护全通过。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `src/api/image/probe.ts`、`openaiCompatible.ts` 写回 diff、`ConfigPage.vue` + i18n diff、`unit-image-probe.ts`、`unit-image-reference-route.ts` 扩充。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 正确性 (correctness):** 探测真的发送 `required:true` 参考图；模板/策略无法表达参考图时直接判不支持、不看 HTTP 200（0.40）；响应 b64 有效性校验，丢弃 ≠ 支持（0.35）；探测额度 ≤2 张（0.25）
  - **J2 回归安全 (regression-safety):** 已知型号（如 `gpt-image-2`）失败探测不覆盖 `supportsSeed`/`referenceEncoding`（0.50）；v1/v2 记录按 `model` 隔离（0.50）
  - **J3 覆盖充分 (coverage):** 三态用例（携带/丢弃/拒绝）齐全（0.50）；ConfigPage 上限 0–16 与重置入口 + i18n 四语言（0.50）
- **Pass threshold:** Panel 均分 ≥ 4.0/5.0，J1、J2 ≥ 4.0。
- **Failure action:** 仍有假阳性 → 让探测走真实参考图路由并校验回执/丢弃证据；已知能力被覆盖 → 恢复非破坏合并（仅增量）后重跑三态；UI 拒绝保存 >3 → 修 ConfigPage 校验到 0–16 并补 i18n。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-probe.ts`（新） | unit | 三态探测真实性 + 非破坏写回 | C1 |
| `unit-image-reference-route.ts`（扩充） | unit (regression) | 「必须发必需参考图才可判支持」（D4a） | C1、C3 |
| `unit-vision-config.ts` / `unit-persist.ts` | unit (regression) | 配置展示/重置/持久化不回归 | C1、NFR-兼容性 |
| `node scripts/check-i18n.mjs` | static | 新文案四语言键齐全 | NFR-兼容性 |

- **Test Cases to Cover**
  - [unit] 三态：接受并携带参考图 → `supportsImageEdit=true`、`maxReferenceImages>0`；接受但丢弃 → false/0；拒绝 → false/0
  - [unit] 模板无法表达参考图（仅 JSON 字段但探测图像未送出）→ 直接判不支持（不发或显式失败计数）
  - [unit] `gpt-image-2` 探测失败 → `supportsSeed`/`referenceEncoding` 原值不变
  - [boundary] 探测消耗 ≤2 张额度（请求计数断言）；重复探测不叠加
  - [unit] v1 槽位记录与 v2 模型记录互不串写；重置探测记录只清探测项
  - [boundary] ConfigPage 能力上限可存 16；输入 17 被拒；测试连接成本提示存在

### Step 13: 重试预算 + Retry-After + 错误分类

**Phase:** 3 缺陷 · **Size:** M · **Depends on:** Step 10 · **Critical path:** 是

**Goal:** 单任务付费尝试 ≤ retryCount + 1（传输层对图像请求单发），读取 Retry-After；补齐永久账单/配额、`unknown_parameter`、输出阶段审查与组织验证提示（C2/D7/D8/K6）。

**Subtasks**
- `src/api/universal.ts`：`postJson` 对图像调用（按 `CallContext` 标志）单发不重试；解析响应头 `Retry-After` 并暴露给上层；chat/TTS 维持现状。
- `src/utils/errorClassifier.ts`：新增/细化分类——`unknown_parameter`、输出阶段审查（`Generated image was filtered` 等签名）、永久账单/配额（`credit_balance_exhausted`、`*_spend_limit_exceeded`、`organization_usage_limit_exceeded`）、组织验证 400 可执行提示；保持 `classifyError(e, status)` 双信号契约。
- `core/image/execute.ts`：业务层成为唯一重试 owner，attempt 预算 = `retryCount + 1`；每次尝试日志含序号/原因/结果分类；退避优先采用 Retry-After，否则沿用现有递增序列；每个付费调用前检查 `isAborted()`。
- 更新 `tests/unit-retry.ts`、`tests/unit-error-classifier.ts`（新分类断言）；新增 `tests/unit-image-retry-budget.ts`：`retryCount=2` + 500×2→成功 时请求数 ≤3；永久 429 → 1 次；Retry-After 被采用；中止 → 0 新请求。
- 文档化「按调用类型分化」的重试策略（Step 15 docs 引用）。

**Expected Outputs**
- 单预算重试、Retry-After、完整错误分类、新测试。

**Success Criteria**
- [ ] C2 场景通过：服务端观察请求数 ≤ retryCount + 1；日志逐次可见；中止后 0 新请求。
- [ ] `unit-error-classifier.ts` 覆盖新分类；`unit-retry.ts`、`unit-image-abort.ts` 全绿。
- [ ] `vue-tsc --noEmit`、`npm run build` 退出码 0。

**Blockers**
- Step 9/12 未完成（路由与探测决定分类入口）。

**Risks & Mitigations**
- R6 单发后中转瞬时失败缺乏韧性 → 业务层保留退避重试；仅消除叠加。
- 分类误伤（永久当临时 / 反之）→ 每类新签名配单测 + 真实回执样本。

**Verification**
- **Level:** Panel（费用上限）
- **Artifacts:** universal/classifier/execute diff、新测试。
- **Commands:** `node scripts/run-tests.mjs`。
- **Pass threshold:** 请求计数断言 + 新分类断言全通过。

**LLM Verification (Judge)**
- **Judge level:** Panel
- **Artifacts to judge:** `universal.ts` 单发与 `Retry-After` 解析、`errorClassifier.ts` 新分类、`execute.ts` 单预算重试、`unit-image-retry-budget.ts`、`unit-error-classifier.ts`/`unit-retry.ts` 更新。
- **Rubric (3 judge perspectives, each scored 1–5; per-perspective weights sum to 1.00; panel score = 三视角均分):**
  - **J1 计费正确 (correctness):** 单任务付费尝试 ≤ `retryCount + 1`、业务层唯一 owner（0.40）；传输层对图像调用单发，chat/TTS 维持现状（0.35）；永久账单/配额类仅 1 次（0.25）
  - **J2 可观测/语义 (regression-safety):** 每次尝试日志含序号/原因/结果分类（0.40）；`Retry-After` 被解析且优先于递增退避（0.30）；每个付费调用前 `isAborted()` 检查（0.30）
  - **J3 覆盖充分 (coverage):** 请求计数断言（≤3、永久 1 次、中止 0）（0.50）；新分类单测 + 真实回执样本（0.50）
- **Pass threshold:** Panel 均分 ≥ 4.5/5.0（费用上限），J1、J2 ≥ 4.0。
- **Failure action:** 计数超限 → 找出叠加的第二层重试（传输层或 SDK）并移除，重跑计数断言；`Retry-After` 未生效 → 修正头解析/退避优先级；分类误伤 → 用真实回执样本回放修正签名后再合并。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| `unit-image-retry-budget.ts`（新） | unit | 单预算 ≤ retryCount+1、Retry-After、永久类、中止 | C2、NFR-成本/性能 |
| `unit-error-classifier.ts`（更新） | unit | `unknown_parameter`/输出审查/账单配额/组织验证分类 | C2、NFR-可观测性 |
| `unit-retry.ts`（更新） | unit (regression) | 新旧重试语义边界（chat/TTS 不回归） | C2、A2 |
| `unit-image-abort.ts` | unit (regression) | 中止后 0 新请求 | C2 |

- **Test Cases to Cover**
  - [unit] `retryCount=2` + 500×2 → 成功：服务端观察请求数 ≤3，任务成功
  - [boundary] `retryCount=0` → 恰好 1 次；`retryCount` 默认值 × 图像请求 → 不倍增
  - [unit] 永久账单/配额（`credit_balance_exhausted`、`*_spend_limit_exceeded`、`organization_usage_limit_exceeded`）→ 1 次即终止
  - [unit] `Retry-After: 2` 被读取并作为退避（短于递增序列时优先）
  - [unit] 中止信号后：0 个新付费请求；已发出请求的结果不触发重试
  - [unit] `unknown_parameter`、输出阶段审查（`Generated image was filtered`）、组织验证 400 → 分类正确且不重试/给出提示
  - [unit] chat/TTS 调用仍保留现有重试次数（分化不误伤）
  - [unit] 每次尝试日志含序号/原因/结果分类（NFR-可观测性）
  - [static] 日志样例审计：不含 API Key 与参考图二进制正文（NFR-安全/隐私）

### Step 14: UI 收尾、死代码与 barrel 清理

**Phase:** 4 收尾 · **Size:** M · **Depends on:** Step 12、Step 13 · **Critical path:** 否

**Goal:** 完成 A1/C5 收尾：旧实现与死代码清理、barrel 物理删除（或标记跟进）、UI 文案与展示收口。

**Subtasks**
- 删除 `src-tauri/src/config.rs`（未被 `lib.rs` 声明，D10）；被环境策略拦截时标记为跟进项并留记录。
- 若全部调用方已直接引用 `core/image/*`，物理删除 `src/core/images.ts` / `src/core/regenerate.ts` barrel；否则保留无副作用 barrel 并标记跟进（K1/P5）。
- 核对被替换实现已删净：旧探测写回、`visualBible.ts` 私有阶梯（Step 4/6 已删则只核对）、旧尺寸常量与 `imageSizeMatches` 缓存判定（Step 10 已改则只核对）。
- 清理 `tests/.tmp-*`（Step 1 若未清理）；`AssetPanel.vue` 透传透明/重编码来源展示（可选，若日志已足够则不新增 UI）；核对 `OptionsPanel.vue` 是否需要用户可见旋钮（B7 默认不需要才跳过）。

**Expected Outputs**
- 死代码与重复实现清零（或明确跟进项）；barrel 删除或标记；UI 收口。

**Success Criteria**
- [ ] C5：`rg "generateImageWithModerationRetry|probeImageEditSupport" src` 只剩单一实现；`rg "config.rs" src-tauri` 0 引用。
- [ ] `node scripts/run-tests.mjs`、`vue-tsc --noEmit`、`npm run build` 全绿。
- [ ] 删除被拦时，任务文件记录跟进项与原因，且 barrel 无行为副作用（测试仍绿）。

**Blockers**
- 环境删除策略（已知先例）→ 明确 fallback 成功路径。

**Risks & Mitigations**
- 删 barrel 时仍有漏网 import → `vue-tsc` 全量类型检查兜底；删除与测试同一提交。
- 顺手清 UI 引入行为变化 → UI 变更仅文案/展示，行为断言不动。

**Verification**
- **Level:** Repo
- **Artifacts:** 删除 diff、grep 审计输出、三件套输出。
- **Commands:** `node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`；`npm run build`。
- **Pass threshold:** 审计 grep 达标 + 三件套全绿。

**LLM Verification (Judge)**
- **Judge level:** Single
- **Artifacts to judge:** 删除 diff（`config.rs`、barrel、旧实现）、审计 grep 输出、三件套输出、UI 收口 diff。
- **Rubric（单一裁判，每项 1–5，权重合计 1.00）:**
  - 审计清零：同职责双实现与死代码无残留，或被环境拦截时跟进项记录完整（0.40）
  - 删除安全：barrel/死代码删除后调用方零漏网、测试仍绿、无行为副作用（0.30）
  - UI 收口：仅文案/展示变化，行为断言与产物生命周期不变（0.30）
- **Pass threshold:** 加权分 ≥ 3.5/5.0（低风险清扫步骤）；审计项与删除安全项均须 ≥ 3.5，且三件套必须全绿。
- **Failure action:** 有漏网 import → 恢复 barrel 并标记跟进（不得为删而删）；删除被策略拦截 → 记录原因与跟进项、验证 barrel 无副作用后收口；UI 误动行为 → 回退到仅展示 diff。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| 审计 grep（`generateImageWithModerationRetry`、`probeImageEditSupport`、`imageSizeMatches` 判定、`config.rs`） | static | 死代码/重复实现清零或明确跟进 | C5、A1 |
| 三件套（`run-tests` / `vue-tsc` / `build`） | regression/build | 删除后全仓无回归 | C5、NFR-验证工具 |
| import 穿透检查 | static | barrel 删除无漏网调用方 | C5、A1 |

- **Test Cases to Cover**
  - [static] 审计 grep 全部达到目标（或逐项记录被拦截原因与跟进项）
  - [regression] 删除 barrel/死代码后三件套退出码 0；视觉守门与单章流程套件仍绿
  - [static] `rg "generateImage\(" src/core` 仅 `execute.ts`/`gate.ts` 两个付费入口
  - [manual] UI 收口项仅在日志已足够时新增；新增展示不改变审批/指纹/产物生命周期

### Step 15: 文档、CHANGELOG 与终验

**Phase:** 4 收尾 · **Size:** S · **Depends on:** Step 14 · **Critical path:** 是

**Goal:** 完成 B8 研究留痕与最终验收：GPT-Image 事实/来源 → 行为映射、模块地图与迁移说明，跑完整测试矩阵并逐条核对 AC/DoD。

**Subtasks**
- 新建 `docs/IMAGE_GENERATION_REFACTOR.md`：模型/端点/参数/尺寸/透明/参考图上限/prompt 上限/延迟/限流与重试事实表（附 `.claude/skills/gpt-image-generation/SKILL.md` 的来源链接）、「事实 → 行为」映射表（每条专用行为可追溯）、模块地图（`core/image/*`、`api/image/*`）、迁移说明（能力 v2、`.image-meta.json`、barrel 状态、64 MiB/600s 传输上限）。
- `CHANGELOG.md` 记录本次重构（用户可见变化：严格端点可用、参考图编辑路由、透明背景、不再重复扣费）。
- 跑完整测试矩阵与三件套；逐条勾选本任务 AC/DoD 并记录证据（测试名 / 日志样例）。
- 复核非 GPT 行为等价证据（金样请求测试 + 日志）与「素材齐全重复运行 0 付费请求」断言。

**Expected Outputs**
- `docs/IMAGE_GENERATION_REFACTOR.md`、CHANGELOG 条目、终验记录（AC/DoD 勾选）。

**Success Criteria**
- [ ] 文档含来源链接与事实→行为映射；每条 GPT 专用行为均能指回一条事实或标注的线路经验。
- [ ] `node scripts/run-tests.mjs`（数量 ≥ 基线 + 新增用例）、`vue-tsc --noEmit`、`npm run build`、`node scripts/check-i18n.mjs` 全绿。
- [ ] AC A1–A3、B1–B8、C1–C5 与「Definition Of Done — Implementation Process Addendum」全部勾选并有证据。

**Blockers**
- 前 14 步全部完成。

**Risks & Mitigations**
- 文档与实现漂移 → 文档只写已验证行为；测试名/命令作为证据链接。
- 终验发现回归 → 先修复再更新文档，禁止只改文档不改代码。

**Verification**
- **Level:** Final acceptance
- **Artifacts:** docs、CHANGELOG、AC/DoD 勾选表。
- **Commands:** `node scripts/run-tests.mjs`；`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`；`npm run build`；`node scripts/check-i18n.mjs`。
- **Pass threshold:** 四命令退出码 0 且 AC/DoD 全部勾选。

**LLM Verification (Judge)**
- **Judge level:** Per-Item
- **Artifacts to judge:** `docs/IMAGE_GENERATION_REFACTOR.md`（逐条事实行、逐条「事实 → 行为」映射行、模块地图、迁移说明）、`CHANGELOG.md` 条目、AC/DoD 勾选表与证据链接。
- **Rubric (per-item; 每个事实行/映射行/条目按 4 项打分 1–5，权重合计 1.00):**
  - 事实准确性：可追溯到来源链接/核验日期（2026-09-15）（0.35）
  - 映射可追溯：每条专用行为都能指回一条事实或标注的线路经验（0.30）
  - 证据链接：测试名/命令/日志样例可复现（0.20）
  - 一致性：文档只写已验证行为，与实现无漂移（0.15）
- **Pass threshold:** Per-Item 均分 ≥ 4.0/5.0；任一事实行或映射行 < 3.5 即整项不通过。
- **Failure action:** 与实现漂移的条目重写并以测试/日志为准；缺来源的条目补链接或降级为「线路经验」并显式标注；AC/DoD 缺证据 → 补跑对应命令后回填，不得只勾选。

**Test Strategy:**
- **Test Matrix:**

| Test | Type | Proves | AC IDs |
|------|------|--------|--------|
| 完整测试矩阵（全部 `unit-*.ts`） | regression | 无网络/假服务端下全矩阵绿，作为终验证据 | 全部 AC |
| 三件套 + `check-i18n` | build/static | 交付门槛四命令退出码 0 | NFR-验证工具、NFR-兼容性 |
| AC/DoD 逐条证据表 | manual + evidence | 每条 AC 有测试名/命令/日志证据 | 全部 AC |
| 文档事实核对 | manual | 来源链接/核验日期/事实→行为映射完整、与实现一致 | B8 |

- **Test Cases to Cover**
  - [regression] 完整测试矩阵（≥ 基线 + 新增用例）全部通过；素材齐全时终验付费请求数 = 0
  - [build] `run-tests` / `vue-tsc` / `build` / `check-i18n` 四命令退出码 0
  - [evidence] AC A1–A3、B1–B8、C1–C5 与 DoD 逐条勾选并附测试名/命令证据
  - [manual] 事实行含来源链接与 2026-09-15 核验日期；每条 GPT 专用行为可追溯
  - [manual] 迁移说明覆盖能力 v2、`.image-meta.json`、barrel 状态、64 MiB/600s 传输上限
  - [manual] CHANGELOG 条目与用户可见变化一致（严格端点、edits 路由、透明背景、不再重复扣费）

## Parallelization

本节只做**执行编排**：不修改、不删除、不重编号 `## Implementation Process` 中的 Step 1–15，仅按「真实前置 + 文件写冲突」划分执行波次（Wave）、标注每步的并行伙伴、代理类型与串行门。判定规则：两个步骤只要共享任一写文件（含同名 `tests/unit-*.ts`、`src/i18n/*`、`scripts/i18n-keys.txt`、`ConfigPage.vue`），即视为互斥，绝不同波。

### 编排约束（真实依赖，非表面编号）

1. **脏工作区前置**：当前 `git status` 有 111 项未提交改动。Step 1 必须先把工作区冻结成可回退基线（排他门，禁止与任何步骤并行）。
2. **金样先于搬移**：Step 2 的两个金样（`unit-image-task-golden` / `unit-image-request-shape`）是 Steps 3–15 的字节/计费契约闸门，必须先于 Step 3 完成（「baseline+goldens before module split」）。
3. **搬移 A 先于改写阶梯**：Step 3 建出的 prompts/tasks 是 Step 4 `rewrite.ts` 的输入（「split A before rewrite ladder」）；且 Step 3/4/5 都写 `src/core/images.ts`，只能串行。
4. **搬移 B 先于重试预算**：Step 5 建出 `execute.ts`，Step 13 在其上收敛重试预算（「split B before retry-budget」）；`execute.ts` 写者按 5 → 10 → 11 → 13 串行。
5. **gate 与 policy 同批**：Step 7 Blockers 明确要求 `gate.ts` 与 policy 同批接入以避免二次改同一批文件；Step 6、7 串行。
6. **最终文档最后**：Step 15 需要引用全部实现与测试证据，Step 14 是其前置（「final docs last」）。

### 文件重叠互斥组（Wave 边界依据）

| 组 | 共享写文件 | 必须串行的步骤 |
|----|-----------|----------------|
| G1 | `src/core/images.ts`（barrel 演进 → 删除） | 3 → 4 → 5 → 14 |
| G2 | `src/core/visualBible.ts` | 4 → 6 |
| G3 | `src/core/image/{execute,batch,ledger,regen}.ts` | 5 → 7 → 10 → 11 → 13 |
| G4 | `src/api/image/policy.ts` | 7 → 9 → 10 → 11 |
| G5 | `src/api/openaiCompatible.ts` | 8 → 9 → 12 |
| G6 | `src/api/templates.ts` | 8 → 9 |
| G7 | `src/api/universal.ts` | 9 → 13 |
| G8 | `src/api/providers.ts` | 7 → 8 |
| G9 | `src/pages/ConfigPage.vue` + `src/i18n/*` + `scripts/i18n-keys.txt` | 11 → 12 |
| G10 | `tests/unit-image-request-shape.ts` | 2 → 8 |
| G11 | `tests/unit-image-reference-route.ts` | 9 → 12 |

> 结论：15 步中唯一「依赖均已满足 + 写文件零交集」的组合是 **Step 10 ‖ Step 12**：二者都只需 Step 9，且 S10 写 `policy.ts`/`ledger.ts`/`execute.ts`/`batch.ts`，S12 写 `probe.ts`/`openaiCompatible.ts`/`ConfigPage.vue`/i18n，互不重叠。

### 执行波次

| Wave | 并行步骤 | 代理 | 波次收口（在各自 Success Criteria 之外） |
|------|----------|------|------------------------------------------|
| W1 | Step 1 冻结工作区基线 | general | 排他门：commit + 三件套绿；`git status` 无 `M src/` |
| W2 | Step 2 金样契约测试 | general | 排他门：59/59 + 反向验证记录 |
| W3 | Step 3 纯搬移 A | general | 排他门：金样/回归墙绿，无调用方 import 变化 |
| W4 | Step 4 审查阶梯参数化 | general | 回归墙 + `unit-image-moderation` |
| W5 | Step 5 纯搬移 B | general | 回归墙 + 无调用方 import 变化 |
| W6 | Step 6 视觉守门 `gate.ts` | general | 5 套视觉守门测试全绿 |
| W7 | Step 7 policy + 能力 v2 + options | general | 非 GPT 金样逐字段等价 |
| W8 | Step 8 严格端点 + 模型矩阵 | general | strict 用例 + 非 GPT 金样同时绿 |
| W9 | Step 9 edits 路由 + relay 回退 | general | 两个假服务端场景全绿 |
| W10 | **Step 10 ‖ Step 12** | general ‖ general | 唯一并行波；两代理写完各自文件后再统一跑完整回归墙 |
| W11 | Step 11 原生透明背景 | general | 透明成功/单次回退/三视图三路径绿 |
| W12 | Step 13 重试预算 + 错误分类 | general | 请求计数断言 + 新分类断言 |
| W13 | Step 14 UI 收尾与死代码清理 | general | A1/C5 审计清零（或明确跟进项） |
| W14 | Step 15 文档、CHANGELOG 与终验 | general | 排他门：四命令绿 + AC/DoD 全勾 |

### 逐步 `Parallel with` 标注

- **Step 1 冻结工作区基线** — `Parallel with: 无（排他门：全仓 commit，必须先于一切）`。Agent: `general`。
- **Step 2 金样契约测试** — `Parallel with: 无（串行门：Step 1 之后、Step 3 之前）`。Agent: `general`。
- **Step 3 纯搬移 A** — `Parallel with: 无（G1/G10 互斥；且 Step 2 金样必须在案）`。Agent: `general`。
- **Step 4 审查阶梯参数化** — `Parallel with: 无（G1/G2 冲突：与 Step 3/5/6 共享 `images.ts` / `visualBible.ts`）`。Agent: `general`。
- **Step 5 纯搬移 B** — `Parallel with: 无（G1/G3 冲突；Step 4 是其前置）`。Agent: `general`。
- **Step 6 视觉守门 `gate.ts`** — `Parallel with: 无（G2 冲突 + Step 7 要求同批接入 policy，6→7 不得拆波）`。Agent: `general`。
- **Step 7 policy + 能力 v2 + options** — `Parallel with: 无（G3/G4/G8 冲突；依赖 Step 6）`。Agent: `general`。
- **Step 8 严格端点 + 模型矩阵** — `Parallel with: 无（G5/G6/G8/G10 冲突；依赖 Step 7）`。Agent: `general`。
- **Step 9 edits 路由** — `Parallel with: 无（G4/G5/G6/G7/G11 冲突；依赖 Step 8）`。Agent: `general`。
- **Step 10 尺寸映射 + 缓存闭环** — `Parallel with: Step 12（唯一合法并行对；依赖均止于 Step 9，写文件零交集）`。Agent: `general`。
- **Step 11 原生透明背景** — `Parallel with: 无（G3/G4/G9 冲突：与 Step 10/12/13 共享 `execute.ts` / `policy.ts` / ConfigPage+i18n）`。Agent: `general`。
- **Step 12 探测重做 + 非破坏写回** — `Parallel with: Step 10（同上；与 Step 11 因 G9 冲突不得并行）`。Agent: `general`。
- **Step 13 重试预算 + 错误分类** — `Parallel with: 无（G3/G7 冲突；保守采纳其 Blockers 的 Step 12 前置，且与 Step 11 共享 `execute.ts`）`。Agent: `general`。
- **Step 14 UI 收尾与死代码** — `Parallel with: 无（依赖 Step 12、Step 13；删 barrel 需 G1 全部落定）`。Agent: `general`。
- **Step 15 文档与终验** — `Parallel with: 无（终局排他门；依赖 Step 14）`。Agent: `general`。

### 并行化示意图

```
W1    [S1]──基线 commit（排他）
W2    [S2]──金样（排他）      ← baseline+goldens before module split
W3    [S3]──搬移 A（排他）    ← split A before rewrite ladder
W4    [S4]──审查阶梯
W5    [S5]──搬移 B            ← split B before retry-budget
W6    [S6]──gate.ts           ┐ gate 与 policy 同批：6/7 禁止并行
W7    [S7]──policy/caps v2    ┘
W8    [S8]──strict 端点
W9    [S9]──edits 路由
        │
        ├───────────────────────────┐
        ▼                           ▼
W10  [S10] 缓存闭环      ‖      [S12] 探测重做   ← 唯一并行波（文件零交集）
        │                           │
        ▼                           │
W11  [S11] 透明背景                 │
        │                           │
        └─────────────┬─────────────┘
                      ▼
W12                [S13] 重试预算    ← execute.ts 单写者：S11 与 S13 串行
                      ▼
W13                [S14] 清理 barrel / 死代码
                      ▼
W14                [S15] 文档与终验（终局排他门）
```

依赖速览（箭头图，非波次）：

```
S1→S2→S3→S4→S5→S6→S7→S8→S9─┬→S10─→S11─┐
                              └→S12──────┴→S13→S14→S15
```

### 子代理执行指令（MUST / 严格串行门）

**必须并行（唯一组合）**
- **W10 = Step 10 ‖ Step 12**：同时启动两条 `general` 子代理，各自只写自己的文件集——S10：`api/image/policy.ts`、`core/image/{ledger,execute,batch}.ts`、`tests/unit-image-cache-closure.ts`；S12：`api/image/probe.ts`、`api/openaiCompatible.ts`、`pages/ConfigPage.vue`、`src/i18n/*`、`scripts/i18n-keys.txt`、`tests/unit-image-probe.ts`、`tests/unit-image-reference-route.ts`。两代理都收工后再统一跑完整回归墙与三件套；**禁止在二者完成前并发执行 `vue-tsc` / `npm run build`**（同一工作区构建产物会互相覆盖；若可用独立 worktree/branch，则先并行后合并，再跑门禁）。
- 其余任何跨步并行都被上述互斥组或前置阻塞，**不得自行放宽**。

**严格串行门（不得跳序、不得同波）**
1. **baseline+goldens before module split**：Step 1 → Step 2 → Step 3。
2. **split A before rewrite ladder**：Step 3 → Step 4（`rewrite.ts` 依赖搬移后的 prompts/tasks）。
3. **split B before gate/policy/retry-budget**：Step 5 → Step 6 → Step 7（gate 与 policy 同批）；Step 5 → … → Step 13（重试预算只能改搬移后的 `execute.ts`）。
4. **provider 阶梯**：Step 7 → Step 8 → Step 9（policy → strict 模板 → edits 路由，逐层共享 `templates`/`providers`/`openaiCompatible`）。
5. **W10 之后**：Step 10 → Step 11、Step 10 → Step 13、Step 12 → Step 13；Step 11 与 Step 13 因 `execute.ts` 互斥而串行。
6. **final docs last**：Step 13 → Step 14 → Step 15。

**Agent 分配**：Step 1–15 全部为 `general`（每步都产出文件并需运行命令），共 15 个；`explore` 0 个（可选只读预检——Step 1 的 git 盘点、Step 14 的 grep 审计——可先派 `explore`，但不改变上述波次与门禁）。

**追踪性**：本节 Wave 编号仅表示执行批次；Step 1–15 的编号、名称、Subtask、Success Criteria 与 Verification 一律以 `## Implementation Process` 原文为准；`## Test Matrix` 与 `## Definition Of Done` 的逐条要求在每个 Wave 收口时统一执行。

## Test Matrix

| Area | Required Scenarios | Files |
|------|--------------------|-------|
| 任务图/字节稳定 | id/fileName/prompt 尾串/seed/参考图 role 金样；同输入两次字节相等 | `unit-image-task-golden.ts` |
| 请求形态 | 非 GPT 模板逐字段金样；GPT strict 端点无 `response_format`/`seed`；`pathPrefix` 生效 | `unit-image-request-shape.ts` |
| 参考图路由 | edits multipart `image[]` 顺序/上限；relay JSON 回退；413 类型化拒绝；探测必需参考图 | `unit-openai-edits.ts`、`unit-image-reference-route.ts`、`unit-image-references.ts` |
| 尺寸/缓存 | 尺寸映射确定性；二次运行 0 请求；旧缓存复用；`.image-meta.json` 串行写 | `unit-image-cache-closure.ts` |
| 透明/可选参数 | 透明成功（alpha、无绿幕后缀）；拒绝后单次回退；三视图不受影响；参数未配置不发送 | `unit-image-transparency.ts` |
| 重试/分类 | 预算 ≤ retryCount+1；Retry-After；永久类不重试；中止 0 请求 | `unit-image-retry-budget.ts`、`unit-error-classifier.ts`、`unit-image-abort.ts`、`unit-retry.ts` |
| 能力/探测 | 三态探测；非破坏写回；v1→v2 迁移；上限 16 | `unit-image-probe.ts`、`unit-image-capabilities-v2.ts`、`unit-providers.ts` |
| 视觉守门 | gate 单一入口后三视图/服装/审批/指纹/失效范围等价 | `unit-visual-bible.ts`、`unit-visual-bible-scope.ts`、`unit-visual-invalidation-scope.ts`、`unit-visual-approval-resume.ts`、`unit-visual-bible-workflow.ts` |
| 单章流程不回退 | 中止、部分重跑、章节灯、级联、队列锁 | `unit-image-abort.ts`、`unit-partial-rerun.ts`、`unit-chapter-image-scope.ts`、`unit-chapter-prune.ts`、`unit-stage-cascade.ts`、`unit-regen-safety.ts` |
| 持久化/i18n | 能力记录往返、快照恢复、web runtime、四语言键齐全 | `unit-persist.ts`、`unit-vfs.ts`、`node scripts/check-i18n.mjs` |

所有 API 相关测试使用本地假服务端（fake `tauri.http`），不产生真实扣费、不依赖外部网络。

### 与逐步骤 Test Strategy 的对照（Reconciliation）

- 上表按「区域」组织，是本任务 P2/P3 研究期的原始矩阵；Steps 的 `Test Strategy` 是其**细化超集**（按执行顺序落到步骤、追加边界用例），两者**不冲突、无行被替代**：所有区域行仍成立。
- 步骤策略中新增/注册的测试文件已在对应步骤登记：`unit-image-moderation.ts`（Step 4）、`unit-image-capabilities-v2.ts`（Step 7）、`unit-image-provider-matrix.ts`（Step 8）、`unit-image-transparency.ts`（Step 11）、`unit-image-retry-budget.ts`（Step 13）。按区域对应：`unit-image-moderation.ts` 为「内容审查阶梯」新增区域行（原表无此行，属纯扩展）；`unit-image-capabilities-v2.ts` 归入「能力/探测」行；`unit-image-provider-matrix.ts` 归入「请求形态」行；`unit-image-transparency.ts` 归入「透明/可选参数」行；`unit-image-retry-budget.ts` 归入「重试/分类」行。
- 冲突裁决规则：若某步骤策略与区域矩阵描述不一致，以**更严格者**为准（新增用例不得删除、区域行不得被弱化）；任何 skip/放宽必须在该步骤 `LLM Verification` 的 Failure action 中记录理由。

## Verification Summary

> `Judge level`：**Panel** = 3 个独立评审视角（正确性 / 回归安全 / 覆盖充分），关键步骤门槛 4.5；**Single** = 单一评审；**Per-Item** = 逐条目评审；**None** = 无需 LLM 评审（本任务 0 个）。`Test Strategy = Yes` 表示该步有明确的测试矩阵 + 用例清单（仅运行既有套件的步骤已标注）。

| Step | Judge level | Threshold | Test Strategy | AC coverage IDs |
|------|-------------|-----------|---------------|-----------------|
| 1 冻结工作区基线 | Panel | 4.0/5.0 | Yes（仅既有套件） | 前置（硬约束 (b)） |
| 2 金样契约测试 | Panel | 4.5/5.0 | Yes（新建 2 文件） | A2、C4、B3 |
| 3 纯搬移 A | Panel | 4.0/5.0 | Yes（金样 + 既有） | A1、A2、C4、C5 |
| 4 审查阶梯参数化 | Panel | 4.0/5.0 | Yes（新建 moderation） | A3、C2、C5 |
| 5 纯搬移 B | Panel | 4.5/5.0 | Yes（回归墙） | A1、A2、C2、C4、C5 |
| 6 视觉守门 gate | Panel | 4.0/5.0 | Yes（5 视觉套件） | A1、A3、C5 |
| 7 policy + 能力 v2 + options | Panel | 4.5/5.0 | Yes（caps-v2 + 金样） | A1、A2、B3、C1、NFR-兼容性 |
| 8 严格端点 + 模型矩阵 | Panel | 4.5/5.0 | Yes（provider-matrix） | B1、B3、A2 |
| 9 edits 路由 + relay 回退 | Panel | 4.5/5.0 | Yes（openai-edits） | B2、C3、C5 |
| 10 尺寸映射 + 缓存闭环 | Panel | 4.5/5.0 | Yes（cache-closure） | B4、B5、C4、A2、NFR-可观测性 |
| 11 原生透明 + 参数透传 | Single | 4.0/5.0 | Yes（transparency） | B6、B7 |
| 12 探测重做 + 非破坏写回 | Panel | 4.0/5.0 | Yes（probe + 路由） | C1、B3、NFR-兼容性 |
| 13 重试预算 + 错误分类 | Panel | 4.5/5.0 | Yes（retry-budget） | C2、NFR-成本/性能、NFR-可观测性、NFR-安全/隐私 |
| 14 清理 barrel / 死代码 | Single | 3.5/5.0 | Yes（审计 + 既有套件） | A1、C5 |
| 15 文档与终验 | Per-Item | 4.0/5.0（逐条） | Yes（全矩阵 + 证据表） | B8 + 全部 AC 终验 |

统计：15/15 步含 LLM Verification；Panel 12 / Single 2 / Per-Item 1 / None 0；Test Strategy 15/15；测试用例 92 条；AC 未覆盖 0（B8 与 NFR-安全/隐私为手动/半自动核对，理由见 scratchpad）。

## Definition Of Done — Implementation Process Addendum

- [ ] 15 个步骤按序完成，每步 Success Criteria 勾选且该步收尾时三件套全绿（`node scripts/run-tests.mjs`、`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`、`npm run build`）。
- [ ] 基线提交存在且可回退；`.specs/` 规划文件与 `tests/.tmp-*` 不混入实现提交。
- [ ] 金样契约（`unit-image-task-golden.ts`、`unit-image-request-shape.ts`）自 Step 2 起全程绿；任何 skip/放宽必须有明确记录与理由。
- [ ] 付费请求单预算 ≤ `retryCount + 1`，并有请求计数断言；中止后 0 新请求有测试证据。
- [ ] 缓存闭环：改造后首跑若出现整书重画即为阻塞缺陷；旧缓存复用有 `unit-image-cache-closure.ts` 证据。
- [ ] 能力记录均为 v2 模型键控且非破坏写回；不存在「失败探测覆盖已知能力」的代码路径。
- [ ] 视觉守门出图与管线出图共享 rewrite/policy/probe；`visualBible.ts` 无直接付费出图调用点。
- [ ] 死代码/重复实现审计：无同职责双实现；`src-tauri/src/config.rs` 已删或列为跟进项并注明原因；barrel 删除或明确保留理由。
- [ ] `docs/IMAGE_GENERATION_REFACTOR.md` 与 `CHANGELOG.md` 已更新，事实→行为映射完整，含 64 MiB/600s 传输上限说明。
- [ ] Test Matrix 全部区块在无网络、无真实扣费的假服务端下通过。
