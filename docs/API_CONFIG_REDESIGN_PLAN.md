# NovelForge API 配置工作台完整重构计划

> 状态：待评审计划，不描述已实现功能。
> 基线：`a7ccc00` 加上当前工作区未提交改动。
> 本文档中出现的文件、类型、命令、字段和组件，只要不是标注“现状”，均为提案，不代表已经实现。

## 1. 背景与现状审计

### 1.1 用户目标

上一轮确认的需求是：

1. API 配置界面太丑，需要完全重构，不保留现有 `ConfigPage.vue` 的表单和排版。
2. 先分析一个好的 API 配置界面有哪些功能，再据此设计。
3. 搜索各大图片服务官网，确认接口差异和适配方式。
4. 必须支持自定义协议，包括中转站这类格式不标准的图片生成接口。
5. 把完整修改计划写成一个 Markdown 文件，越详细越好。

### 1.2 当前实现

现状文件：

| 文件 | 现状 |
|---|---|
| `src/pages/ConfigPage.vue` | 当前 API 配置页，单文件卡片表单，包含大量内联样式。 |
| `src/stores/config.ts` | 当前配置 store，使用 `ConfigFile`、500ms `watch` 自动保存，API Key 明文写入 `config.json`。 |
| `src/core/types.ts` | 当前定义 `ApiConfig`、`ApiPreset`、`ApiChannel`、`ChannelKey`、`ApiProtocol`。 |
| `src/api/providers.ts` | 当前工作区未提交文件，提供 `PROVIDERS`、`applyProviderDefaults`、`parseModelList` 等，但尚未接入页面和真实图片调用链。 |
| `src/api/templates.ts` | 当前声明式适配器模板，覆盖 OpenAI 兼容、MiniMax、DashScope、Gemini、Stability。 |
| `src/api/universal.ts` | 当前通用请求引擎，支持 sync/async、JSON/form、轮询、结果提取、错误提取。 |
| `src/api/openaiCompatible.ts` | 当前运行时入口，`generateImage` 和 `ttsSpeech` 最终走 `unifiedImage` / `unifiedTts`。 |
| `src/utils/tauri.ts` | 当前 Tauri 包装器，包含 `http`、`readConfig`、`writeConfig` 等。 |
| `src/utils/webRuntime.ts` | 当前 Web 运行时，配置通过 `localStorage` 的 `novelforge:config` 保存。 |
| `src-tauri/src/commands.rs` | 当前 Rust 命令层，有 `read_config`、`write_config`、`http_request`，没有凭据管理命令。 |
| `src-tauri/Cargo.toml` | 当前没有 keyring、QuickJS 等依赖。 |
| `package.json` | 当前没有图标库，没有凭据库，也没有官方 SDK 类型依赖。 |
| `tests/unit-providers.ts` | 当前工作区未提交测试，导入 `buildImageRequestBody`、`ttsEndpointForConfig` 等函数，但这些函数当前没有在 `src/api/openaiCompatible.ts` 中导出。 |

### 1.3 已确认的问题

1. 配置组、三通道、多端点和高级 JSON 全部平铺在同一个页面，缺少任务层级。
2. 页面有大量内联样式、重复表单和弱状态反馈。
3. `src/api/providers.ts` 中的协议判断没有进入真实图片调用链。
4. SiliconFlow 默认图片配置没有专属模板，`generateImage` 会回退到 `getTemplate("openai-image")`，使用 OpenAI 字段。
5. MiniMax 模板只覆盖基础文生图，缺少图生图、专有尺寸、live 风格等能力。
6. DashScope 模板仍是旧版异步协议，没有覆盖 wan2.6 等新协议。
7. Stability 模板使用旧版 v1 路径和 Authorization 假设。
8. Gemini 模板中的模型示例仍是旧模型，API Key 校验没有完成官网级验证。
9. API Key 当前明文写入配置 JSON。
10. 图片测试直接真实生成，会消耗额度，没有免费连通性检查，也没有结果预览。
11. 自定义模板只能通过 JSON 文本框编辑，缺少结构化编辑器、schema 校验和错误定位。
12. `tests/unit-providers.ts` 引用了尚不存在的导出，属于当前未完成代码的一部分。

## 2. 目标、非目标与验收标准

### 2.1 目标

- G1：建立“连接库 + 三通道路由”的 API 配置模型。
- G2：彻底删除并重建 `src/pages/ConfigPage.vue`，不复用当前页面结构。
- G3：文本、图片、TTS 三通道分别引用连接和模型。
- G4：正式适配八家图片服务：SiliconFlow、MiniMax、DashScope、智谱、火山方舟、OpenAI、Google Gemini、Stability AI。
- G5：支持 OpenAI 兼容中转站、完全自定义 JSON/表单/轮询/SSE/脚本转换。
- G6：桌面端凭据进入系统凭据库，Web 端凭据只在会话内存中保存。
- G7：采用显式“保存并应用”，不再对未完成配置自动保存。
- G8：支持免费连通性检查、模型发现和需确认的付费生成测试。
- G9：支持从当前 v1 配置无损迁移，迁移失败时保留旧配置。
- G10：视觉改为明亮、紧凑、专业的工作台，不再以紫色渐变为主。

### 2.2 非目标

- 不重写生成管线的业务语义，只重构 API 配置边界和调用解析。
- 不做 AI 音乐生成、视频生成、自动 APK/exe 构建等超出本任务的模块。
- 不把尚未通过官方契约验证的 OpenAI、Gemini 标记为“已支持”。
- 不允许导入的脚本访问网络、文件、DOM、Tauri、环境变量和进程。

### 2.3 验收标准

- `pnpm build`、`pnpm tauri build` 通过。
- `npx tsx tests/unit-providers.ts` 等测试文件全部通过。
- 当前 v1 配置可迁移到 v2，Key 不再进入 `config.json`。
- Playwright 覆盖新建连接、绑定模型、保存应用、导入导出、免费检查、付费确认。
- 在 1280x860、860x640、640x900 三种视口下无文字截断、无重叠、无横向溢出。
- 所有供应商适配器都有离线契约 fixture，真实调用只在显式环境变量下运行。

## 3. UX 信息架构

### 3.1 页面结构

目标结构：

```text
API 配置工作台
├─ 顶部能力轨道
│   文本 API | 图片 API | TTS API
│   每项显示：供应商、模型、状态、当前路由
├─ 左侧连接库
│   搜索、状态筛选、新建、复制、删除
│   每条连接显示：名称、供应商、Base URL、能力、状态
├─ 右侧编辑区
│   连接信息、凭据、区域/workspace、模型能力、路由绑定
│   高级协议：请求预览、适配器 JSON、脚本
├─ 底部操作区
│   取消、测试、保存并应用
└─ 对话框/抽屉
    新建连接向导、导入导出、模型发现、测试结果
```

### 3.2 新建连接流程

1. 选择官方供应商、OpenAI 兼容服务或自定义协议。
2. 填写连接名、API Key、区域、workspace、Base URL 等供应商专有字段。
3. 执行免费连接检查并读取可用模型。
4. 将模型绑定到文本、图片或 TTS 通道。
5. 校验整个草稿。
6. 点击“保存并应用”后，连接和路由才进入运行态。

### 3.3 状态反馈

- 连接状态：`unknown`、`checking`、`ok`、`error`、`disabled`。
- 草稿状态：`clean`、`dirty`、`saving`、`saved`、`error`。
- 测试状态：`idle`、`running`、`passed`、`failed`。
- 路由状态：`unconfigured`、`configured`、`model_missing`、`credential_missing`、`ready`。

### 3.4 小屏行为

- 860px 以下：连接库收成顶部下拉选择器，编辑区保持单栏。
- 640px 以下：能力轨道改为横向滚动分段控件，高级协议放入抽屉。
- 所有固定尺寸控件使用 `min-width`、`max-width`、`aspect-ratio` 或网格轨道约束，避免内容撑破布局。

## 4. 视觉规范与响应式

### 4.1 提案 token

```css
:root {
  --api-bg: #F4F6F6;
  --api-surface: #FFFFFF;
  --api-text: #182220;
  --api-text-dim: #5B6B68;
  --api-border: #D8E0DE;
  --api-border-strong: #B9C7C3;
  --api-primary: #087F73;
  --api-info: #326C91;
  --api-warn: #A86B12;
  --api-error: #C34B52;
  --api-ok: #18794E;
  --radius-sm: 8px;
  --api-duration: 180ms;
}
```

### 4.2 组件规范

- 主按钮、次级按钮、幽灵按钮、危险按钮、loading 状态保持当前 5 类按钮语义。
- 卡片圆角不超过 8px。
- API、模型、请求 ID 等机器标识使用等宽字体。
- 图标优先使用 `lucide-vue-next`，这是一个提案新增依赖。
- 动画时长控制在 160-200ms，继续使用 `prefers-reduced-motion` 降级。
- 不出现大面积渐变、悬浮装饰卡片、紫色渐变导航和卡片套卡片。

## 5. 配置 Schema v2

### 5.1 提案数据模型

```ts
export type ChannelKey = "llm" | "image" | "tts";

export type ProviderId =
  | "siliconflow"
  | "openai"
  | "deepseek"
  | "dashscope"
  | "moonshot"
  | "ollama"
  | "zhipu"
  | "volcengine"
  | "gemini"
  | "stability"
  | "custom";

export interface ProviderConnection {
  id: string;
  name: string;
  providerId: ProviderId;
  baseUrl: string;
  credentialRef?: string;
  apiKeyOptional?: boolean;
  settings: Record<string, unknown>;
  enabled: boolean;
  status?: "unknown" | "checking" | "ok" | "error" | "disabled";
  lastCheckedAt?: string;
}

export interface ChannelRoute {
  connectionId: string;
  model: string;
  adapterId: string;
  options: Record<string, unknown>;
}

export interface ApiProfile {
  id: string;
  name: string;
  routes: Record<ChannelKey, ChannelRoute | null>;
}

export interface ApiConfigFileV2 {
  schemaVersion: 2;
  connections: ProviderConnection[];
  profiles: ApiProfile[];
  adapters: AdapterDefinitionV2[];
  activeProfileId: string;
  outputDir?: string;
  recentOutputDirs?: string[];
}
```

### 5.2 运行时映射

生成管线继续消费当前的 `ApiConfig`，但 `ApiConfig` 只从 v2 配置实时解析，不再作为持久化格式：

```ts
async function resolveRuntimeConfig(
  file: ApiConfigFileV2,
  profileId: string,
  channel: ChannelKey,
): Promise<ApiConfig>;
```

`resolveRuntimeConfig` 负责：

- 按 `profileId` 找到 profile。
- 按 `channel` 找到 route。
- 按 `connectionId` 找到 connection。
- 通过 `credentialRef` 从凭据库取 Key。
- 按 `adapterId` 找到适配器。
- 生成旧的 `ApiConfig` 形状，供现有 `chatCompletion`、`generateImage`、`ttsSpeech` 调用。

## 6. 凭据安全与迁移

### 6.1 当前行为

- Tauri 端 `read_config` / `write_config` 直接读写 app config 目录下的 `config.json`。
- Web 端 `webReadConfig` / `webWriteConfig` 使用 `localStorage` 的 `novelforge:config`。
- `src/stores/config.ts` 会把 `apiKey` 放进 JSON 并自动保存。

### 6.2 提案行为

- 桌面端新增 Tauri 命令：`credential_set`、`credential_get`、`credential_delete`，使用系统凭据库。
- Windows 使用 Credential Manager，macOS 使用 Keychain，Linux 使用 Secret Service；不可用时不得静默降级为明文。
- Web 端 Key 只保存在 `sessionStorage` 或内存 Map 中，刷新页面后消失。
- `config.json` 只保存 `credentialRef`，不保存 Key。
- 日志、导出文件、错误信息、请求预览中禁止出现 Key。

### 6.3 迁移规则

1. 读取当前 v1 `config.json`。
2. 按供应商、标准化 Base URL、内存中的 Key 合并连接。
3. 保留所有配置组、当前路由、非活跃连接、模型、音色库和自定义模板。
4. 先将所有 Key 写入系统凭据库。
5. Key 全部写入成功后，再原子写入 v2 配置。
6. 任一步失败时保留旧配置和旧文件，不产生半迁移状态。

## 7. 供应商兼容矩阵

| 供应商 | LLM 现状 | 图片现状 | TTS 现状 | 重构后目标 | 官方核对状态 |
|---|---|---|---|---|---|
| SiliconFlow | `providers.ts` 已声明 | 无专属模板，回退 `openai-image` | 无专属 TTS 模板，走 OpenAI 兼容 | 正式 image/TTS 适配器 | 已调研官网入口，仍需契约测试 |
| MiniMax | 不适用 | `minimax-image` 模板 | `minimax-tts` 模板 | 图生图、专有参数、live 风格 | 已调研官网入口，仍需契约测试 |
| DashScope | `providers.ts` 已声明文本兼容 | `dashscope-image` 旧异步模板 | `dashscope-tts` 旧异步模板 | 按模型切换旧版/新版协议 | 已调研官网入口，仍需契约测试 |
| 智谱 | 无独立 provider id | `applyTemplate` 会填 `openai-image` 默认 | `applyTemplate` 会填 `openai-tts` 默认 | 独立适配器与模型发现 | 已调研官网入口，仍需契约测试 |
| 火山方舟 | 不适用 | 当前无模板 | 不适用 | 新增图片适配器 | 已调研官网入口，仍需契约测试 |
| OpenAI | `providers.ts` 已声明 | `openai-image` 模板 | `openai-tts` 模板 | 官方文档/SDK 验证后正式支持 | 上次官网被 Cloudflare 拦截，未完成 |
| Google Gemini | 不适用 | `gemini-image` 模板 | 不适用 | 官方文档/`@google/genai` 类型验证后正式支持 | 上次官网超时，未完成 |
| Stability AI | 不适用 | `stability-image` 模板 | 不适用 | 迁移到官方当前 v2beta 契约 | 已调研官网入口，仍需契约测试 |
| 自定义/中转站 | OpenAI 兼容 | `customTemplate` 可配 | `customTemplate` 可配 | 结构化自定义协议编辑器 | 由用户导入，必须支持 schema 校验 |

## 8. 各供应商适配器要求

通用要求：

- 每个适配器使用官方请求/响应样例建立契约 fixture。
- 不能从本文档复述字段作为最终实现，实施时必须回到官方文档和契约测试。
- 每个适配器必须覆盖鉴权、错误提取、输出解码、超时和重试。
- 图生图能力必须明确支持或明确降级，不能在用户选择参考图后悄悄发错格式。

### 8.1 SiliconFlow

当前模板缺口：

- 没有专属图片模板，`generateImage` 会落到 `openai-image`。
- 需要验证 `image_size`、`batch_size`、参考图、临时 URL 下载等字段。

官方入口：

```text
https://docs.siliconflow.cn/cn/api-reference/images/images-generations
```

### 8.2 MiniMax

当前已有：

- `minimax-image`：`/v1/image_generation`。
- `minimax-tts`：`/v1/t2a_v2`。

重构要求：

- 覆盖文生图、图生图、比例/精确尺寸、URL/base64 输出、live 风格。
- 保留 HEX 音频解码，但错误信息不能泄露原始内容。

官方入口：

```text
https://platform.minimaxi.com/docs/api-reference/image-generation-t2i
```

### 8.3 DashScope

当前已有：

- `dashscope-image`：旧版 `/api/v1/services/aigc/text2image/image-synthesis`。
- `dashscope-tts`：旧版 `/api/v1/services/audio/tts/speech-synthesis`。

重构要求：

- 支持按模型切换旧版异步协议和新协议。
- 支持区域、workspace、异步轮询、结果 URL 下载。

官方入口：

```text
https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference
```

### 8.4 智谱

当前没有独立 provider，只通过 `applyTemplate` 填 `openai-image` / `openai-tts` 默认值。

重构要求：

- 新增 `zhipu` provider。
- 提供独立适配器，覆盖质量、尺寸、水印、同步/异步响应和内容安全错误。

官方入口：

```text
https://docs.bigmodel.cn/api-reference/模型-api/图像生成.md
```

### 8.5 火山方舟

当前没有任何模板。

重构要求：

- 新增 `volcengine` provider。
- 新增图片适配器，覆盖 `/api/v3/images/generations`、参考图、组图和非流式默认路径。

官方入口：

```text
https://docs.volcengine.com/docs/82379/1541523?lang=zh
```

### 8.6 OpenAI

当前已有：

- `openai-image`：`/v1/images/generations`。
- `openai-tts`：`/v1/audio/speech`。

重构要求：

- 在上次官网文档被 Cloudflare 拦截的情况下，必须用官方 SDK 类型或可访问的官方文档完成最终核对。
- 核对完成前不得在 README 或界面中宣称“OpenAI 已支持”。

### 8.7 Google Gemini

当前已有：

- `gemini-image`：`/v1beta/models/{model}:generateContent`。

重构要求：

- 必须用官方文档或 `@google/genai` 类型核对 API Key 鉴权、输出格式和参考图输入。
- 替换当前旧模型示例。

### 8.8 Stability AI

当前已有：

- `stability-image`：`/v1/generation/{model}/text-to-image`。

重构要求：

- 迁移到官方当前 v2beta 契约。
- 覆盖 multipart、原始图片输出、图生图强度和错误结构。

官方入口：

```text
https://platform.stability.ai/docs/api-reference
```

## 9. 自定义协议

### 9.1 当前能力

当前 `AdapterTemplate` 支持：

- `capability`、`mode`、`endpoint`、`method`、`headers`、`contentType`。
- `auth`：bearer 或 header。
- `requestMap`：JSON path 或 form 字段。
- `response`：path、encoding、mime。
- `poll`：GET/POST 轮询、成功/失败状态、结果路径。
- `rawResponse`：直接返回原始二进制。

当前缺口：

- 实际调用层没有使用 `AdapterTemplate.method`，统一按 POST 请求。
- 没有 query、动态 header、HMAC 签名、二进制文件字段、SSE 流式读取。
- 自定义模板只有 JSON 文本框，没有 schema 校验和错误定位。

### 9.2 提案扩展

```ts
export interface AdapterDefinitionV2 extends AdapterTemplate {
  schemaVersion: 2;
  method?: "GET" | "POST" | "PUT" | "PATCH";
  query?: Record<string, TemplateValue>;
  headers?: Record<string, TemplateValue>;
  auth?: AuthDefinitionV2;
  transform?: {
    pre?: string;
    post?: string;
  };
}
```

`AuthDefinitionV2` 提案：

```ts
export type AuthDefinitionV2 =
  | { type: "bearer" }
  | { type: "header"; name: string }
  | { type: "query"; name: string }
  | { type: "body"; path: string }
  | { type: "hmac"; algorithm: string; keyRef: string; fields: string[] }
  | { type: "none" };
```

### 9.3 中转站场景

- OpenAI 兼容中转站：Base URL、Key、模型、路径前缀、模型列表、返回格式。
- 奇怪格式中转站：声明式 JSON 无法覆盖时使用受控脚本转换。
- 所有自定义请求必须先构建“请求预览”，用户可查看脱敏后的 URL、headers、query、body。
- 自定义响应必须用样例响应做离线解析测试。

## 10. 沙箱脚本架构与威胁模型

### 10.1 运行环境

- 使用独立 QuickJS 子进程，不使用浏览器 `eval`，也不在 Tauri 主进程直接执行。
- 候选实现：Rust 侧 QuickJS 子进程二进制；如依赖限制导致不可行，再评估受控 Wasm 方案。
- 脚本只接收结构化输入，不接收真实凭据。
- 脚本完成后，由受控 HTTP 层注入 Key、构造请求和发送网络请求。

### 10.2 限制

| 限制项 | 提案值 |
|---|---|
| 源码大小 | 128 KiB |
| 堆大小 | 64 MiB |
| 单个 hook 执行时间 | 250ms |
| 序列化输出 | 16 MiB |
| 网络访问 | 禁止 |
| 文件访问 | 禁止 |
| DOM 访问 | 禁止 |
| 环境变量 | 禁止 |
| 进程 | 禁止 |
| Tauri API | 禁止 |

### 10.3 导入信任

- 导入的脚本默认禁用。
- 用户必须查看脚本并明确信任后才会启用。
- 导入连接默认禁止私网访问和重定向。
- 本机服务必须显式授权后才能访问。
- 脚本错误不能影响主应用进程，超时直接终止子进程。

## 11. 草稿、保存、应用

### 11.1 状态模型

```ts
interface ConfigDraft {
  id: string;
  file: ApiConfigFileV2;
  credentialInputs: Record<string, string>;
}

interface AppliedConfigSnapshot {
  file: ApiConfigFileV2;
  appliedAt: string;
}
```

### 11.2 交互规则

- 编辑连接时只改 `draft`。
- `dirty` 根据草稿和已应用快照计算。
- “保存并应用”统一执行校验、凭据写入、配置迁移、原子写入、更新运行态。
- “取消”丢弃草稿。
- 页面离开前有未保存改动时提示。
- 移除当前 `configState` 中的 500ms 自动保存 API 配置逻辑。
- 输出目录和最近项目目录可以作为独立偏好保存，不阻塞 API 配置草稿。

## 12. 模型目录与发现

### 12.1 当前基础

`src/api/providers.ts` 已有：

- `classifyModelCapabilities`。
- `parseModelList`。
- `providerIdForConfig`。
- `applyProviderDefaults`。

但当前页面没有调用这些能力。

### 12.2 提案行为

- 每个连接提供“发现模型”按钮。
- 优先请求常见模型列表端点，例如 `/models` 或供应商指定端点。
- 模型缓存键使用连接 id、Base URL、凭据指纹，不使用明文 Key。
- 按能力过滤模型：llm、image、tts。
- 支持手动输入模型名，手动模型不写回供应商目录。
- 模型发现失败时显示已脱敏的错误，不阻断手动配置。

## 13. 免费与付费测试

### 13.1 免费连通性检查

- 校验 URL、协议、必填字段。
- 校验 TLS/连接。
- 校验鉴权。
- 可选读取模型列表或供应商健康端点。
- 不产生图片、不产生语音、不消耗生成额度。

### 13.2 付费生成测试

- 点击真实测试前弹出确认，说明会消耗额度。
- 固定生成一张最低成本测试图或最短测试音频。
- 测试结果展示预览图、耗时、请求 ID、响应类型和脱敏错误。
- 测试请求和结果不允许写入日志明文 Key。

## 14. 导入与导出

### 14.1 导出

- 导出为 schema v2 JSON。
- 导出包含连接、profile、route、adapter、模型目录，不包含凭据。
- 导出文件头写明 schema 版本。

### 14.2 导入

- 导入时校验 schema 版本和必填字段。
- 凭据为空时要求重新输入。
- 脚本和私网连接默认禁用。
- 导入失败时保留当前配置，不覆盖。

## 15. 实现顺序与依赖

### 15.1 阶段划分

```text
Phase 0  现状基线：修复 tests/unit-providers.ts 的引用，建立当前行为快照
Phase 1  类型与 schema：types.ts、AdapterDefinitionV2、ConfigFileV2
Phase 2  凭据后端：Tauri credential 命令、Web session 凭据
Phase 3  配置迁移：v1 -> v2、原子写入、回滚
Phase 4  Store 与路由：config store v2、runtime resolver
Phase 5  UI 骨架：连接库、能力轨道、编辑区、高级抽屉
Phase 6  模型发现与测试：免费检查、付费确认、结果预览
Phase 7  供应商适配器：八家图片 + TTS/LLM 回归
Phase 8  自定义协议与沙箱：结构化编辑器、QuickJS 子进程
Phase 9  视觉与打包：styles.css、Playwright、tauri build
```

依赖关系：

```text
Phase 0 -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5
                                                    \-> Phase 6
                                                     -> Phase 7
                                                     -> Phase 8
                                                    -> Phase 9
```

## 16. 文件与模块改动映射

### 16.1 修改现有文件

| 文件 | 改动 |
|---|---|
| `src/core/types.ts` | 新增 v2 schema 类型，保留旧 `ApiConfig` 作为运行时类型。 |
| `src/api/providers.ts` | 扩展 provider 列表、模型发现、协议解析，并接入真实调用链。 |
| `src/api/universal.ts` | 扩展 `AdapterDefinitionV2`、query、动态 header、auth、SSE、脚本 hook。 |
| `src/api/templates.ts` | 改为模板注册表，新增供应商专属模板，保留旧模板 id 兼容。 |
| `src/api/openaiCompatible.ts` | 补充被 `tests/unit-providers.ts` 引用的函数，或修改测试引用到正确模块。 |
| `src/stores/config.ts` | 重写为 v2 store，移除 API 配置自动保存，新增 draft/apply。 |
| `src/pages/ConfigPage.vue` | 删除并重建为连接工作台。 |
| `src/utils/tauri.ts` | 新增凭据、模型列表、原子配置命令包装。 |
| `src/utils/webRuntime.ts` | Web 凭据改为 session-only，移除 localStorage 中的 Key。 |
| `src/styles.css` | 新增 API 工作台 token 和组件样式。 |
| `src-tauri/src/commands.rs` | 新增凭据命令、原子配置写入、模型列表代理。 |
| `src-tauri/Cargo.toml` | 按实现阶段新增凭据和沙箱依赖。 |
| `package.json` | 按实现阶段新增 `lucide-vue-next` 和必要的类型依赖。 |
| `tests/unit-providers.ts` | 修复引用并扩展为 v2 契约测试。 |

### 16.2 新增文件

| 文件 | 用途 |
|---|---|
| `src/api/schemaV2.ts` | schema v2 类型、校验、迁移和运行时解析。 |
| `src/api/credentials.ts` | 桌面/Web 凭据抽象。 |
| `src/api/modelCatalog.ts` | 模型发现、分类、缓存。 |
| `src/api/connectionCheck.ts` | 免费连通性检查。 |
| `src/api/generationTest.ts` | 需确认的付费测试。 |
| `src/api/scriptSandbox.ts` | QuickJS 子进程调用和限制。 |
| `src/components/api/ConnectionLibrary.vue` | 左侧连接库。 |
| `src/components/api/ConnectionEditor.vue` | 右侧编辑区。 |
| `src/components/api/CapabilityRail.vue` | 顶部能力轨道。 |
| `src/components/api/AdapterEditor.vue` | 高级适配器 JSON/结构化编辑器。 |
| `src/components/api/TestResultPanel.vue` | 测试结果与预览。 |
| `src/components/api/ImportExportDialog.vue` | 导入导出。 |
| `src-tauri/src/credential.rs` | 系统凭据库实现。 |
| `src-tauri/src/script_runner.rs` | QuickJS 子进程运行器。 |
| `tests/unit-config-v2.ts` | schema/migration/resolver 测试。 |
| `tests/unit-credentials.ts` | 凭据抽象测试。 |
| `tests/unit-model-catalog.ts` | 模型发现测试。 |
| `tests/contract/*.json` | 各家供应商请求/响应契约 fixture。 |

## 17. 测试计划

### 17.1 单元测试

- `unit-providers.ts`：供应商、模型能力、协议解析。
- `unit-config-v2.ts`：schema v2 校验、路由解析、运行时 `ApiConfig` 生成。
- `unit-credentials.ts`：桌面凭据抽象和 Web session 行为。
- `unit-model-catalog.ts`：模型发现、分类、去重、缓存。
- `unit-connection-check.ts`：免费检查与付费测试分流。
- `unit-adapters.ts`：每家供应商请求体、响应解析、错误提取。
- `unit-script-sandbox.ts`：死循环、内存膨胀、超时、密钥隔离。

### 17.2 契约测试

- 每家供应商建立离线 fixture。
- 覆盖文生图、参考图、鉴权、错误、响应解析。
- 覆盖 DashScope 异步轮询、临时 URL 下载、Stability multipart、Gemini inline image。

### 17.3 迁移测试

- v1 配置迁移到 v2。
- 重复连接合并。
- 失败回滚。
- 明文 Key 清理。
- 凭据库不可用场景。

### 17.4 端到端测试

- 新建连接、绑定模型、保存应用、修改路由。
- 免费检查、付费确认、结果预览。
- 导入导出，导出文件不包含 Key。
- 脚本导入默认禁用，显式信任后才启用。

### 17.5 视觉测试

- Playwright 截图覆盖 1280x860、860x640、640x900。
- 检查文字截断、重叠、横向滚动。
- 检查 loading、error、empty、disabled 状态。

### 17.6 构建与打包

- `pnpm build`。
- `pnpm tauri build`。
- 便携版启动冒烟测试。

## 18. 回滚策略与完成定义

### 18.1 回滚

- 迁移前将旧 `config.json` 复制为 `config.json.bak`。
- 保留 v1 解析器一个发布周期。
- 迁移失败时恢复 `.bak` 并显示可读原因。
- 凭据写入失败时不允许覆盖旧配置。
- 沙箱子进程崩溃不影响主进程。

### 18.2 完成定义

- [ ] API 配置页已完全重建，不保留旧三卡片布局。
- [ ] 当前 v1 用户可无损迁移到 v2。
- [ ] 桌面 Key 不再明文写入 `config.json`。
- [ ] Web Key 刷新后消失。
- [ ] 八家图片供应商均有契约测试，未验证的不标记为已支持。
- [ ] 自定义协议支持 JSON、表单、轮询、动态 header/query、受控脚本。
- [ ] 免费检查和付费测试分流。
- [ ] `tests/unit-providers.ts` 等测试通过。
- [ ] Playwright 视觉验收通过。
- [ ] 便携版和安装包构建通过。

## 19. 官方来源核对清单

| 供应商 | 官方入口 | 上次核对状态 |
|---|---|---|
| SiliconFlow | `https://docs.siliconflow.cn/cn/api-reference/images/images-generations` | 已读取 |
| MiniMax | `https://platform.minimaxi.com/docs/api-reference/image-generation-t2i` | 已读取 |
| DashScope | `https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference` | 已读取 |
| 智谱 | `https://docs.bigmodel.cn/api-reference/模型-api/图像生成.md` | 已读取 |
| 火山方舟 | `https://docs.volcengine.com/docs/82379/1541523?lang=zh` | 已读取 |
| Stability AI | `https://platform.stability.ai/docs/api-reference` | 已读取 |
| OpenAI | 官方文档/官方 SDK 类型 | 上次被 Cloudflare 拦截，未完成 |
| Google Gemini | 官方文档/`@google/genai` 类型 | 上次超时，未完成 |

## 20. 当前代码核对表

以下符号和路径已在本轮阅读源码时核对，作为计划文档的事实基础：

| 符号/路径 | 核对结论 |
|---|---|
| `src/pages/ConfigPage.vue` | 存在，当前为单文件卡片表单。 |
| `src/stores/config.ts` | 存在，500ms watch 自动保存。 |
| `src/core/types.ts` 的 `ApiConfig`、`ApiPreset`、`ChannelKey` | 存在。 |
| `src/api/providers.ts` 的 `PROVIDERS`、`applyProviderDefaults`、`parseModelList` | 存在，工作区未提交。 |
| `src/api/templates.ts` 的 `PRESET_TEMPLATES`、`getTemplate`、`resolveTemplate` | 存在。 |
| `src/api/universal.ts` 的 `AdapterTemplate`、`callUnified`、`unifiedImage`、`unifiedTts` | 存在。 |
| `src/api/openaiCompatible.ts` 的 `generateImage`、`ttsSpeech`、`testImage` | 存在。 |
| `src/utils/webRuntime.ts` 的 `webReadConfig`、`webWriteConfig` | 存在，使用 `localStorage`。 |
| `src-tauri/src/commands.rs` 的 `read_config`、`write_config`、`http_request` | 存在。 |
| `src-tauri/Cargo.toml` | 当前无 keyring、QuickJS 依赖。 |
| `package.json` | 当前无 `lucide-vue-next`。 |
| `tests/unit-providers.ts` | 引用当前未导出的 `buildImageRequestBody`、`ttsEndpointForConfig` 等。 |

## 21. 风险与开放问题

- 系统凭据库在不同平台行为不同，Linux 无 Secret Service 时需要明确错误处理。
- QuickJS 子进程的打包、跨平台签名和依赖体积需要实现阶段验证。
- 供应商接口变化很快，必须用契约测试锁定，不能只靠 README 描述。
- Web 模式依赖 dev/preview server 代理，纯静态部署下可能因 CORS 降级。
- 迁移是高风险操作，必须保持旧文件备份和回滚路径。
- `tests/unit-providers.ts` 当前是未完成代码的一部分，实施阶段先修复引用或调整测试边界。
