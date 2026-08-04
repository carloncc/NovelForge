# NovelForge 整改计划（T0 UI + P0 导出 + P1 体验）

> 状态：已定稿，待执行（一次性完成，不分阶段）
> 范围：UI 门面重点整改（T0）· 导出功能补齐（P0）· 工具体验补齐（P1）
> 明确不做：云部署 / 自动更新 / 密钥链存储（列入 Roadmap）

---

## 0. 基准对照（为什么要做这些）

### 0.1 UI 基准（对齐 Linear / Figma / Notion 级质感）

| 基准项 | 行业标准 | NovelForge 现状 | 差距 |
|---|---|---|---|
| 设计 token | 统一间距系统（4/8/12/16/24）、三级文字、三层阴影、统一圆角 | 间距随意、阴影单一、圆角 10-14 混用 | 高 |
| 布局层级 | 页面头（标题+说明+主操作）→ 内容区；卡片 Header/Body 分离 | 标题区无操作位；卡片无统一结构 | 高 |
| 组件状态 | 按钮 5 态（含加载/禁用）、表单 focus 环、表格 sticky 表头 | 按钮 3 态、无 focus 环、表头不固定 | 高 |
| 微交互 | hover 150-250ms、按压 scale、tab 滑动指示、卡片 stagger 入场 | 部分有 hover/按压，无入场动效 | 中 |
| 品牌 | logo 全场景、渐变克制、空态插画统一 | logo 有，其余零散 | 中 |
| 流程可视化 | 生成类工具均有步骤指示器（步骤/进度/失败定位） | 只有日志流，无步骤态 | 高 |

### 0.2 导出基准（对齐 WebGAL Terre / Ren'Py 发布流程）

| 基准项 | 行业标准 | NovelForge 现状 | 差距 |
|---|---|---|---|
| 网页版分享包 | 一键 zip（排除缓存/中间产物） | 只有文件夹，需手动压缩 | 缺 |
| 纯净发布 | 发布产物不含工程缓存 | `.novel2vn/` 随项目被部署 | 缺 |
| 发布前检查（Lint） | Ren'Py「Check Script」：素材引用/语法/空场景校验 | 无 | 缺 |
| 发布配置 | 标题 / Game_key / 界面语言（zh_CN/zh_TW/en/ja） | 语言固定 zh_CN | 缺 |
| PC exe / APK | Terre 一键导出 / 官方 APK 构建工具 | 仅说明引导 | 可接受（引导已具备） |

### 0.3 工具基准（AI 创作工具通用）

| 基准项 | 行业标准 | 现状 |
|---|---|---|
| 失败可定位可重试 | 失败清单 + 一键重试 | 仅日志 |
| 成本预算上限 | 生成前设预算，超限自动停 | 仅事后统计 |
| 日志可落盘 | 导出日志文件 | 仅界面复制 |
| 项目历史 | 最近项目列表一键切换 | 手填路径 |

---

## T0. UI 门面重点整改

### T0-1 设计 Token 系统升级（`src/styles.css` 全量重写 v3）

| # | 修改点 | 具体内容 | 验收 |
|---|---|---|---|
| T0-1.1 | 间距系统 | 定义 `--space-1..8`（4/8/12/16/24/32/48/64），所有 padding/margin 改用 token | 无散落魔法数值 |
| T0-1.2 | 色彩精调 | 背景 `#FAF5FF`→`#F7F5FB`（降饱和）；卡片 `#FFFFFF`；主色 `#6D28D9`（深一档，提升浅色下对比）；文字 `#111827`/`#4B5563`/`#9CA3AF`；边框 `#E5E0F0` | 对比度 ≥4.5:1 |
| T0-1.3 | 阴影系统 | `--shadow-rest`（0 1px 2px rgba(17,24,39,.05)）、`--shadow-hover`（0 4px 16px rgba(109,40,217,.10)）、`--shadow-active` | 三层可切换 |
| T0-1.4 | 圆角统一 | `--radius-sm:8px`（按钮/输入）/ `--radius-md:12px`（卡片）/ `--radius-lg:16px`（弹层） | 全站统一 |
| T0-1.5 | 过渡 token | `--ease:cubic-bezier(.4,0,.2,1)`、`--dur:180ms`；`prefers-reduced-motion` 全局降级 | 动效可关 |

### T0-2 布局重构（`src/App.vue` + 各页面）

| # | 修改点 | 具体内容 |
|---|---|---|
| T0-2.1 | 侧边栏 v3 | 宽度 224px；Logo 区（32px 图 + 渐变字）+ 导航分组（`导航`/`项目`）两段；导航项：图标 18px + 文字，激活=紫色胶囊+白字+左侧 3px 渐变条；底部：版本号 + 「关于」按钮（弹层：logo/版本/许可/致谢 WebGAL） |
| T0-2.2 | 页面头组件 | 统一结构：`<div class="page-head"><div><h1 class="page-title">…</h1><p class="page-sub">…</p></div><div class="page-actions">主操作按钮</div></div>`；五个页面全部套用；主操作：导入页=选择小说、配置页=测试当前、生成页=开始生成、预览页=启动预览、导出页=打包 zip |
| T0-2.3 | 卡片结构 | `.card` 增加 `.card-head`（标题+右侧操作区）与 `.card-body` 语义；现有页面卡片逐个套用 |
| T0-2.4 | 主内容宽度 | `max-width: 1200px; margin: 0 auto`，大屏不再拉伸 |

### T0-3 组件精修（`src/styles.css` + 各页面模板）

| # | 组件 | 修改点 |
|---|---|---|
| T0-3.1 | 按钮 | 5 态：主（紫渐变）/次（白底紫边）/危险/幽灵（透明紫字）/loading（内置 spinner，`btn.is-loading` 加旋转圆圈动画）；禁用统一 `opacity:.45` |
| T0-3.2 | 表单 | `input/select/textarea`：focus 环 `0 0 0 3px rgba(109,40,217,.14)`；label 统一 12px 上标；占位符 `#9CA3AF`；`select` 自定义下拉箭头（SVG 背景） |
| T0-3.3 | 复选框 | 自定义样式：18px 圆角方块，选中紫渐变+白色对勾（SVG） |
| T0-3.4 | 表格 | 表头 sticky + 浅紫底 + 12px 字；行 hover `#FAF7FF`；首列圆角（`border-radius` 表头/行首）；空态插画居中 |
| T0-3.5 | 统计卡 | 图标圆（32px 渐变底+白色 SVG）+ 数值 24px 渐变字 + 说明行 |
| T0-3.6 | Tabs | 底部 2px 渐变指示条（紫→粉）+ 切换滑动过渡（`transform` 动画） |
| T0-3.7 | 日志面板 | 每行：时间（等宽灰）+ 步骤徽标（8px 圆点+文字）+ 消息；错误行左侧 3px 红条 |
| T0-3.8 | 滚动条 | 6px 圆角，thumb `#D5CCEF` hover `#C0B3E6` |
| T0-3.9 | 标签/徽标 | `.tag` 升级：圆角 6px、彩色底（绿/橙/红/紫语义色系 8% 底 + 主色字） |

### T0-4 动效体系（`src/styles.css` + 组件）

| # | 修改点 | 具体内容 |
|---|---|---|
| T0-4.1 | 页面切换 | `main` 内容区 `@keyframes pageIn { from {opacity:0; transform:translateY(6px)} }` 180ms |
| T0-4.2 | 卡片入场 | 列表卡片 `stagger`（`animation-delay: i*40ms`，通过 CSS 类或行内 style） |
| T0-4.3 | 按钮按压 | `:active { transform: scale(.97) }`（已有，保留并统一 easing） |
| T0-4.4 | tab 滑动 | 指示条 `transition: transform var(--dur)` |
| T0-4.5 | hover 提亮 | 卡片/统计卡 `translateY(-2px)` + 阴影升级 |
| T0-4.6 | reduced-motion | 全局媒体查询：动画/过渡时长归零 |

### T0-5 五页专项整改

| # | 页面 | 修改点 |
|---|---|---|
| T0-5.1 | **导入页** | ① 小说选择区：大按钮卡（虚线边框+图标+说明），拖放区样式预留 ② 章节表：表头「启用/标题/字数/段落」+ 行 hover + 禁用章灰显 ③ 素材库：网格卡片视图（缩略图占位 + 文件名 + 类型徽标 + 映射标签），非表格 |
| T0-5.2 | **配置页** | ① 配置组切换：segmented control（胶囊分段，3 组横向）② 三通道：三列并排卡片（≥1100px），每卡独立 header（图标+通道名+状态徽标）③ 测试按钮行内状态：测试中 spinner / 成功绿徽标 / 失败红徽标 ④ 音色库 textarea 收起为「高级选项」折叠 |
| T0-5.3 | **生成页** | ① **步骤指示器**：顶部横向 5 步（提取→剧本→图像→配音→组装），当前步高亮/完成步对勾/失败步红叉（响应 pipeline 事件驱动）② 选项区：分两卡——「生成内容」（图像/表情差分/配音/视频位/BGM/登场卡 6 开关成 2×3 网格）+「预算与范围」（CG 数/图数/视频点数/预算/章节重跑/跳过缓存）③ 费用统计卡：四项（LLM/图像/配音/合计）带图标 ④ 空态插画统一 |
| T0-5.4 | **预览页** | 工具栏卡片：项目路径（等宽）+ 启动/刷新（主）/系统浏览器/停止；iframe 容器圆角+阴影+边框 |
| T0-5.5 | **导出页** | ① 顶部设置卡：标题/Game_key/语言（select：简体中文/繁体中文/English/日本語）② 「导出检查」结果卡：通过绿/警告黄/缺失红 + 明细列表 ③ 三个导出方案卡（网页版 zip / PC exe / APK）：每卡图标+说明+主按钮（zip 卡可点，exe/APK 卡为引导链接）④ 操作日志行 |

### T0-6 品牌质感

| # | 修改点 |
|---|---|
| T0-6.1 | 侧边栏 logo 区：144px logo + 渐变字「NovelForge」+ 副标「AI 视觉小说工坊」 |
| T0-6.2 | 关于弹层：logo/版本/许可（MIT）/致谢（WebGAL MPL-2.0）/仓库链接 |
| T0-6.3 | 渐变克制原则：全站仅 3 处允许渐变（logo、主按钮、激活态）——其余纯色 |
| T0-6.4 | 空态插画三张统一风格（已生成 2 张，补 1 张导出页空态） |

### T0-7 验收（T0）

1. `npx tsx tests/screenshot-all.ts` 重截 6 张
2. MiniMax 视觉评估每张：中文渲染正常 + 美观度 ≥7/10 + 布局无错乱
3. `vue-tsc` 零错误 + 全量测试回归

---

## P0. 导出功能补齐

### P0-1 一键打包 zip（网页版分享包）

| # | 修改点 | 详情 |
|---|---|---|
| P0-1.1 | Rust 依赖 | `Cargo.toml` 增加 `zip = "2"`（默认 feature，含 deflate） |
| P0-1.2 | Rust 命令 | `src-tauri/src/commands.rs` 新增 `build_zip(source_dir: String, zip_path: String, exclude: Vec<String>) -> Result<ZipStats, String>`；递归遍历 source_dir，跳过 `exclude` 匹配的路径段（`.novel2vn`、`*.log`）；返回 `{fileCount, sizeBytes}`；中文文件名用 `zip::write::SimpleFileOptions` 的 UTF-8 支持（`zip` crate 默认 UTF-8 文件名 ✓） |
| P0-1.3 | Rust 测试 | `#[cfg(test)]`：内存构造临时目录（含 `.novel2vn/` 子目录 + 中文文件名文件）→ 打包 → 断言 exclude 未入包、中文名正确、zip 可被 `zip::read` 读回 |
| P0-1.4 | 前端封装 | `src/utils/tauri.ts` 增加 `buildZip(sourceDir, zipPath, exclude)` 方法 |
| P0-1.5 | 导出页 UI | 「打包网页版 zip」按钮：目标路径默认 `<outputDir>_web.zip`（点击后文件对话框选择保存位置，用 `@tauri-apps/plugin-dialog` 的 `save()`）；按钮 loading 态；完成后显示大小/文件数 + 「在文件夹中打开」 |

### P0-2 导出前检查（Lint）

| # | 修改点 | 详情 |
|---|---|---|
| P0-2.1 | 核心模块 | 新增 `src/core/lint.ts`：`lintProject(outputDir) -> LintReport`；`LintReport = { errors: LintIssue[]; warnings: LintIssue[]; summary: { scenes, lines, figures, bgs, vocals, videos, missingAssets } }`；`LintIssue = { level: 'error'\|'warning'; scope: string; message: string }` |
| P0-2.2 | 检查项 1：素材引用完整性 | 扫描 `game/scene/*.txt` 全部指令行：`changeBg`→查 `game/background/`；`changeFigure`→查 `game/figure/`；`bgm`→查 `game/bgm/`；`playVideo`→查 `game/video/`；对话语音参数 `-xxx.mp3`→查 `game/vocal/`；`unlockCg`→查 `game/background/`。缺失 = error |
| P0-2.3 | 检查项 2：语法 | 复用 `tests/unit-render.ts` 的校验逻辑（非注释行必须以 `;` 结尾且匹配指令/对话正则；`label:` 唯一性）；解析失败 = error |
| P0-2.4 | 检查项 3：结构 | 无 `start.txt` = error；章节文件数=0 = error；某章 0 句台词 = warning；存在未引用素材文件 = warning（列出文件名） |
| P0-2.5 | 单元测试 | `tests/unit-lint.ts`：构造带缺失素材/坏语法/空章的临时项目 → 断言错误项 |
| P0-2.6 | 导出页 UI | 「导出检查」按钮 → 结果卡：总结（通过/警告 N/错误 N）+ 分组明细列表（错误红/警告黄）；错误时 zip 按钮禁用并提示 |

### P0-3 导出设置（config.txt 重写）

| # | 修改点 | 详情 |
|---|---|---|
| P0-3.1 | 类型 | `types.ts` 新增 `ExportSettings { title: string; gameKey: string; language: 'zh_CN'\|'zh_TW'\|'en'\|'ja' }` |
| P0-3.2 | 渲染 | `render.ts` 的 `renderConfig(title, gameKey)` 增加 `language` 参数 → 输出 `Default_Language:<lang>;` |
| P0-3.3 | 存储 | 默认设置从 `projectState.lastResult.meta` 读取（标题/Game_key），语言默认 `zh_CN`；随 `project_state.json` 持久化（并入 `saveProjectState` 的 options 或独立字段） |
| P0-3.4 | 应用 | 导出页「应用设置」按钮：调 `renderConfig` 重写 `game/config.txt`（不触碰剧本/素材）|
| P0-3.5 | 校验 | Game_key 长度 6-10、仅字母数字（非法输入提示） |

### P0-4 测试与回归（P0）

- 新增：`unit-lint.ts`（Lint 5 项）、Rust `build_zip` 单测
- 回归：全部 10 项前端测试 + `cargo test` + `vue-tsc` + 引擎验证
- 手动链路：生成 → 修改删除一张背景图 → 导出检查报错 → 修复 → 打包 zip → 解压验证不含 `.novel2vn`

---

## P1. 工具体验补齐

### P1-1 失败任务清单 + 一键重试

| # | 修改点 | 详情 |
|---|---|---|
| P1-1.1 | 事件模型 | `types.ts` 的 `PipelineEvent` 增加 `taskId?: string; taskKind?: 'llm'\|'image'\|'tts'\|'script'` |
| P1-1.2 | 失败记录 | `pipeline.ts`：新增 `failedTasks: { id, kind, step, message, at, retryHint }[]`；提取/剧本（llm）、图像（image）、配音（tts）的 catch 处统一 `this.recordFailure(...)`（重试耗尽后） |
| P1-1.3 | 结果透出 | `PipelineResult` 增加 `failedTasks`；`GeneratePage` 存至 `projectState.lastResult` |
| P1-1.4 | UI | 生成页新增 tab「失败项」：清单（步骤/类型徽标/消息/时间）+ 「重试失败章节」按钮：按失败任务归属章节预选 `rerunChapters` 并提示用户点开始；图像失败附加「清除对应缓存」按钮（删 `cache/images/<fileName>`） |
| P1-1.5 | 持久化 | 失败清单随 `project_state.json` 保存（重启可见） |

### P1-2 成本预算上限

| # | 修改点 | 详情 |
|---|---|---|
| P1-2.1 | 选项 | `GenerationOptions` 增加 `budgetYuan: number`（默认 0 = 不限） |
| P1-2.2 | 管线 | `pipeline.ts`：`afterCost(kind)` 检查累计 `llmCostYuan + imageCostYuan + ttsCostYuan > budgetYuan` → `log warn` + 抛「超出预算 ¥X（累计 ¥Y），已中止；可调高预算或勾选跳过缓存重跑」 |
| P1-2.3 | UI | 生成页「预算与范围」卡：输入 ¥（0=不限）+ 说明文字（含当前价格估算提示） |
| P1-2.4 | 测试 | `unit-cache.ts` 或新增 `unit-budget.ts`：demo 管线注入 budget=0.0001 → 断言中止 |
| P1-2.5 | 持久化 | 随 options 保存 ✓（已有机制） |

### P1-3 日志导出文件

| # | 修改点 | 详情 |
|---|---|---|
| P1-3.1 | 命令 | `GeneratePage` 日志 tab 增加「保存日志」按钮：`tauri.writeTextFile('<outputDir>/.novel2vn/logs/<时间戳>.log', 全文)` |
| P1-3.2 | 内容格式 | 每行 `[HH:mm:ss] [步骤] 级别 消息`；含失败清单摘要尾注 |
| P1-3.3 | 反馈 | 保存成功提示路径 + 「打开文件夹」按钮 |

### P1-4 项目历史列表

| # | 修改点 | 详情 |
|---|---|---|
| P1-4.1 | 存储 | `stores/config.ts`：`configState.recentOutputDirs: string[]`（最近 8 个，去重，最新在前）；随 `config.json` 持久化 |
| P1-4.2 | 记录时机 | ① 生成成功 ② 手动「加载该项目状态」成功 ③ 输出目录变更（浏览选择后） |
| P1-4.3 | UI | 导入页新增「最近项目」卡：历史列表（路径 + 标题/时间从 `project_state.json` 读取）→ 点击 = 设 outputDir + `restoreProject` + 跳转生成页 |
| P1-4.4 | 清理 | 每项带「移除」按钮（仅从历史移除，不删项目） |

---

## 5. 技术改动清单（按文件汇总）

### 新增文件
| 文件 | 用途 |
|---|---|
| `src/core/lint.ts` | P0-2 导出检查核心逻辑 |
| `src/components/AboutDialog.vue` | T0-2.1/T0-6.2 关于弹层 |
| `src/components/StepIndicator.vue` | T0-5.3 生成步骤指示器 |
| `tests/unit-lint.ts` | P0-2 测试 |
| `tests/unit-budget.ts` | P1-2 测试 |
| `docs/IMPROVEMENT_PLAN.md` | 本计划文档 |

### 修改文件
| 文件 | 改动点 |
|---|---|
| `src/styles.css` | T0-1 全量重写；T0-3/T0-4 全部组件与动效样式 |
| `src/App.vue` | T0-2.1 侧边栏 v3、T0-6.1、关于弹层挂载 |
| `src/pages/ImportPage.vue` | T0-2.2 页面头、T0-5.1 素材网格、P1-4.3 最近项目 |
| `src/pages/ConfigPage.vue` | T0-2.2、T0-5.2 三通道并排/segmented/高级折叠 |
| `src/pages/GeneratePage.vue` | T0-2.2、T0-5.3 步骤指示器+选项分区+费用卡、P1-1.4 失败项 tab、P1-2.3 预算、P1-3.1 日志保存 |
| `src/pages/PreviewPage.vue` | T0-2.2、T0-5.4 工具栏 |
| `src/pages/ExportPage.vue` | T0-2.2、T0-5.5 重构、P0-1.5/P0-2.6/P0-3 导出设置+检查+打包 |
| `src/core/pipeline.ts` | P1-1.2 失败记录、P1-2.2 预算中止 |
| `src/core/types.ts` | PipelineEvent.taskId/taskKind、PipelineResult.failedTasks、GenerationOptions.budgetYuan、ExportSettings |
| `src/core/render.ts` | P0-3.2 renderConfig 语言参数 |
| `src/core/project.ts` | P0-3.4 应用设置入口（或直接导出页调用 renderConfig） |
| `src/stores/project.ts` | P1-1.5 失败清单持久化、P1-2.5（自动） |
| `src/stores/config.ts` | P1-4.1 recentOutputDirs |
| `src/utils/tauri.ts` | P0-1.4 buildZip 封装 |
| `src-tauri/Cargo.toml` | P0-1.1 zip crate |
| `src-tauri/src/commands.rs` | P0-1.2 build_zip 命令 + 注册 |
| `tests/screenshot-all.ts` | 导出页空态插画等待逻辑微调（如需要） |
| `README.md` | 导出功能说明更新 |

---

## 6. 测试计划

| 测试 | 覆盖 | 类型 |
|---|---|---|
| `unit-lint.ts`（新） | 素材缺失/语法/空章/未引用素材 4 类 6 用例 | 单元 |
| `unit-budget.ts`（新） | 预算超限中止、0=不限 | 单元 |
| Rust `build_zip` 单测（新） | 排除目录、中文文件名、回读校验 | 单元 |
| 既有 10 项 | 全量回归（渲染/章节/缓存/任务/素材/演出/持久化/重试/去重/端到端） | 回归 |
| `engine-check.ts` | 引擎实机（含 label/config 语言变更后） | 集成 |
| `screenshot-all.ts` + MiniMax | 6 张截图：中文渲染 + 美观度 ≥7 + 布局错乱检测 | 视觉验收 |

## 7. 执行顺序（一次性）

```
1.  T0-1 样式 token → T0-3 组件 → T0-4 动效（styles.css 全量）
2.  T0-2 App/侧边栏/关于 → T0-6 品牌
3.  T0-5 五页专项（导入→配置→生成→预览→导出）
4.  P0-1 Rust zip → P0-2 lint → P0-3 导出设置 → P0-4 测试
5.  P1-1 失败清单 → P1-2 预算 → P1-3 日志 → P1-4 项目历史
6.  全量回归（10 项 + 新增 3 项 + cargo test）
7.  截图 6 张 + MiniMax 验收 → README 更新
8.  git commit + push
```

## 8. 验收总标准

- [ ] UI：6 张截图 MiniMax 评估均 ≥7 分且中文正常
- [ ] 导出：zip 可打包（排除 `.novel2vn`）、Lint 可检出缺失、语言切换生效
- [ ] 体验：失败清单可重试、预算超限中止、日志落盘、项目历史可切换
- [ ] 全量测试通过、`vue-tsc`/`cargo check` 零错误
- [ ] 推送 GitHub（不执行打包构建，等待指令）
