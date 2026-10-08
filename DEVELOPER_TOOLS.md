# 🛠️ 开发者工具指南

NovelForge 提供了一套开发者工具，帮助你构建更稳定、更高效的应用。

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

`errMsg(e)`：从任意异常取值（Tauri invoke 常以纯字符串 reject，直接读 `Error.message` 会得到 undefined）。
这是全仓通用的取值入口。

```typescript
import { errMsg } from "./utils/errors";

try {
  await run();
} catch (e) {
  log.error("stage", errMsg(e));
}
```

`ErrorCode` / `createError()` / `safeAsync()` 是结构化错误包装，目前只有 `TEMPLATE_NOT_FOUND`
一处调用（`src/utils/template.ts` 的模板解析）。新增错误码时请一并补 `ERROR_MESSAGES` 文案。

---

### ⚡ 并发控制 (`src/utils/performance.ts`)

```typescript
import { ConcurrencyLimiter } from "./utils/performance";

const limiter = new ConcurrencyLimiter(3); // 上限会被夹到 >= 1（NaN / 0 / 负数一律退回 1）
await limiter.run(() => executeTask());
limiter.setMaxConcurrent(8); // 动态调整：增大立即生效，减小后运行数自然回落
```

---

### 🧪 测试与校验脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm test` | 单元 + 离线端到端（`node scripts/run-tests.mjs`） |
| `pnpm test:e2e` | 追加 Playwright 浏览器端用例（需先 `pnpm exec playwright install`） |
| `pnpm typecheck:tests` | `tests/` 的类型检查（`tsconfig.tests.json`） |
| `pnpm check:i18n` | 校验各语言词典与 `scripts/i18n-keys.txt` 键集一致 |
| `pnpm check:template` | 校验 WebGAL 模板是否已回填（构建前必跑） |

需要人工条件（API 密钥 / 已生成游戏目录）的用例不参与自动门禁，但会被 runner 显式列出：
`tests/stage-runner.ts`、`tests/engine-check.ts`、`tests/screenshot.ts`、`tests/_probe-render.ts`。

---

**更新日期：** 2026-10-07
**版本：** v0.3.0
