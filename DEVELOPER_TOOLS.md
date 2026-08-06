# 🛠️ 开发者工具指南

NovelForge 提供了一套强大的开发者工具，帮助你构建更稳定、更高效的应用。

## 📦 工具模块

### 🗂️ 路径工具 (`src/utils/path.ts`)

跨平台路径处理工具，统一 Windows 和 Unix 路径格式。

```typescript
import { normalizePath, joinPath, basename } from "./utils/path";

// 标准化路径 (Windows: C:\path -> C:/path)
const normalized = normalizePath(path);

// 安全拼接路径
const fullPath = joinPath(baseDir, "subdir", "file.txt");

// 提取文件名
const filename = basename(path);

// 生成安全文件名
const safe = safeFilename("file:name*.txt"); // -> "file_name_.txt"
```

**可用函数：**
- `normalizePath()` - 标准化路径分隔符
- `basename()` - 获取文件名
- `dirname()` - 获取目录路径
- `joinPath()` - 连接路径片段
- `cleanPath()` - 清理路径
- `safeFilename()` - 生成安全文件名
- `extname()` - 获取扩展名
- `basenameWithoutExt()` - 获取不含扩展名的文件名

---

### 🛡️ 错误处理 (`src/utils/errors.ts`)

结构化错误处理，提供用户友好的错误消息。

```typescript
import { createError, ErrorCode, formatError, retry } from "./utils/errors";

// 创建结构化错误
throw createError(ErrorCode.FILE_NOT_FOUND, {
  path: filePath
});

// 格式化错误消息（自动附加建议）
const message = formatError(error);

// 自动重试
const result = await retry(
  () => apiCall(),
  { maxAttempts: 3, delayMs: 1000 }
);
```

---

### ⚡ 性能工具 (`src/utils/performance.ts`)

性能优化工具集，提升应用响应速度。

```typescript
import {
  debounce,
  throttle,
  memoize,
  createTimer,
  ConcurrencyLimiter
} from "./utils/performance";

// 防抖（延迟执行）
const debouncedSearch = debounce((query) => {
  performSearch(query);
}, 300);

// 性能监控
const timer = createTimer("项目生成");
timer.mark("模板加载");
timer.summary();

// 并发控制
const limiter = new ConcurrencyLimiter(3);
await limiter.run(() => executeTask());
```

---

**更新日期：** 2026-08-06  
**版本：** v0.1.1
