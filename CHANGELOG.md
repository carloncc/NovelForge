# NovelForge 变更日志

所有值得注意的项目更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.3.0] - 2026-09-07

### 新增
- 项目列表：每个项目绑定小说×输出目录，切换自动换目录和全套状态；导入不同小说提示分独立目录，防缓存串味
- 视觉圣经全局重新生成改为批量并行（默认 3 并发，可跟图像通道配置走），附进度条与单角色失败隔离
- 提取分段手动旋钮（生成页 Agent 模式下「提取分段」，0=自动）：中转网关有单请求超时墙时可调小（如 40000）绕过 HTTP 500
- 角色描述重生成请求 JSON 模式 + 括号平衡解析：模型在 JSON 后跟闲聊不再报“不是合法 JSON”
- LLM opt-in 类 403 自动追加中文指引（打开链接完成 opt-in 或换模型）

### 修复
- 中文小说提取分段预算按实际语种估算（约 0.6 字符/token，以前按 1.5 算导致 80 万字巨段触发网关 500），另加 15 万字硬上限
- 风格描述里的背景词会跟绿幕后缀冲突：三视图/立绘/动作/服装/物品提示词统一先剥背景词（背景/CG/锚点不受影响）
- 剧本核对报告在重写后沿用旧结果：新鲜生成与自动重写后强制重算
- 换装无服装图时误屏蔽表情差分；配音孤儿认领批量写映射、健康计数口径对齐
- IPv6 本地 Host（[::1]:5173）被误判非本地导致 403；圣经同步仅删多余条目时不再强制要求图像 Key
- .gitignore 拼写修正（.novel2n/ → .novel2vn/，运行时缓存此前实际未被忽略）

## [0.2.0] - 2026-08-16

### 新增
- 移除所有内容数量上限（0=不限量），取消预算超限自动中止，改为失败任务清单 + 定向重试
- 服装/形态变体立绘、音效（SE）、演出增强、鉴赏（Appreciation）画廊
- 提取 Agent 模式、分阶段状态看板、角色不限量、各 API 通道独立并发控制
- API Key 使用系统钥匙串加密存储（keyring），避免明文落盘
- 资源缩略图懒加载（LazyThumb + 资产缩略图缓存），性能优化
- 统一路径/错误处理/性能工具模块；数据校验（dataValidation）与资产映射（assetMap）

### 修复
- 图像提示词压缩、参考图能力探测与降级（REFERENCE_UNSUPPORTED / REFERENCE_MISSING）
- 移除 AI 抠图模型，改为纯代码色度键（连通 flood-fill + 去绿边 + 羽化）
- 服务端 UTF-8 charset、文字生成彻底串行（LLM 全局并发 1）消除 error sending request
- 按模型上下文动态决定输入预算（128K 默认），避免推理模型输出截断

### 文档
- README 增加游戏实机截图（标题页 / 剧情场景 / 名场面 CG）与下载徽章

---

## [Unreleased]

### 新增
- 统一路径处理工具模块 `src/utils/path.ts`
  - `normalizePath()` - 标准化路径分隔符
  - `basename()` - 获取文件名
  - `dirname()` - 获取目录路径
  - `joinPath()` - 安全拼接路径
  - `cleanPath()` - 清理路径
  - `safeFilename()` - 生成安全文件名
  - `extname()` - 获取扩展名
  - `basenameWithoutExt()` - 获取不含扩展名的文件名

- 错误处理工具模块 `src/utils/errors.ts`
  - `NovelForgeError` - 自定义错误类
  - `ErrorCode` - 错误类型枚举
  - `createError()` - 创建结构化错误
  - `formatError()` - 格式化用户友好的错误消息
  - `safeAsync()` - 安全执行异步操作
  - `retry()` - 自动重试机制
  - `logError()` - 错误日志

- 性能优化工具模块 `src/utils/performance.ts`
  - `debounce()` - 防抖函数
  - `throttle()` - 节流函数
  - `createBatcher()` - 批量处理
  - `memoize()` - 结果缓存
  - `ConcurrencyLimiter` - 并发控制
  - `PerformanceTimer` - 性能计时器
  - `measurePerformance()` - 性能监控装饰器

### 优化
- `src/utils/template.ts` - 使用统一路径工具和错误处理
- `src/core/cache.ts` - 使用 `cleanPath()` 和 `safeFilename()`
- `src/core/project.ts` - 所有路径操作标准化，提高可读性
- `src/core/render.ts` - 使用统一的 `basename()` 函数
- `src/core/chapters.ts` - 使用 `basename()` 和 `basenameWithoutExt()`
- `src/utils/vfsWeb.ts` - 使用统一的路径处理函数

### 文档
- 新增 `OPTIMIZATION_SUMMARY.md` - 详细的优化总结文档
- 新增 `CHANGELOG.md` - 项目变更日志

---

## [0.1.0] - 2026-08-05

### 修复
- 修复 WebGAL 模板路径在 Windows 下的查找问题
  - 问题：Windows 返回的路径使用反斜杠 `\`，导致模板查找失败
  - 解决：在 `src/utils/template.ts` 中标准化路径为正斜杠
  - 提交：f309002

### 新增
- 初始版本发布
- 小说转视觉小说核心功能
- AI 驱动的角色提取和场景脚本生成
- 图片生成和语音合成集成
- WebGAL 引擎项目导出
- 项目预览功能
- 多章节处理
- 素材缓存机制

### 特性
- 🎨 Vue 3 + TypeScript 前端
- ⚡ Vite 构建工具
- 🦀 Tauri 2.0 桌面应用框架
- 🤖 OpenAI Compatible API 支持
- 🎭 角色卡片和场景分析
- 🖼️ AI 图片生成（背景、CG、立绘）
- 🔊 AI 语音合成
- 📦 WebGAL 项目打包
- 🌐 网页版导出（ZIP）
- 💾 IndexedDB 浏览器存储支持

---

## 版本说明

### 版本号规则

遵循语义化版本 `MAJOR.MINOR.PATCH`：

- **MAJOR**：不兼容的 API 变更
- **MINOR**：向后兼容的功能新增
- **PATCH**：向后兼容的问题修复

### 变更类型

- **新增 (Added)** - 新功能
- **优化 (Changed)** - 现有功能的变更
- **弃用 (Deprecated)** - 即将移除的功能
- **移除 (Removed)** - 已移除的功能
- **修复 (Fixed)** - Bug 修复
- **安全 (Security)** - 安全性修复

---

**仓库：** https://github.com/carloncc/NovelForge  
**作者：** 陈俊龙 <1599692505@qq.com>
