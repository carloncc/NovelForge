# NovelForge 变更日志

所有值得注意的项目更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
