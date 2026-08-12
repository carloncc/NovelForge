<div align="center">

<img src="docs/logo.png" width="96" alt="NovelForge" />

# NovelForge

**一个按钮，小说变视觉小说。**

纯文字看不下去，画面才有代入感。一键把小说变成可游玩的视觉小说——立绘、表情、CG、配音、BGM、剧情分支全部自动生成；预览、打包（exe / APK / 网页版）、分发。

<p>
  <a href="https://github.com/carloncc/NovelForge/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/carloncc/NovelForge?color=blue"></a>
  <a href="https://github.com/carloncc/NovelForge/releases"><img alt="Release" src="https://img.shields.io/github/v/release/carloncc/NovelForge"></a>
  <a href="https://github.com/carloncc/NovelForge/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/carloncc/NovelForge"></a>
  <a href="https://github.com/carloncc/NovelForge/issues"><img alt="Issues" src="https://img.shields.io/github/issues/carloncc/NovelForge"></a>
  <a href="https://www.forgepeaknow.com/"><img alt="Website" src="https://img.shields.io/badge/Website-forgepeaknow.com-64748b"></a>
</p>
Tauri 2 + Vue 3 + WebGAL · 轻量快速 · API 全自定义

[English](README.md) · **简体中文** · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [官网](https://www.forgepeaknow.com/) · [更新日志](https://github.com/carloncc/NovelForge/releases)

</div>

---

<details>
<summary><kbd>📑 目录</kbd></summary>

- [为什么要用 NovelForge？](#为什么要用-novelforge)
- [一个按钮，一步到位](#一个按钮一步到位)
- [快速开始](#快速开始)
- [什么时候不适合用 NovelForge](#什么时候不适合用-novelforge)
- [特性](#特性)
- [截图](#截图)
- [API 配置示例](#api-配置示例)
- [视觉圣经（图像生成门禁）](#视觉圣经图像生成门禁)
- [Web 版（浏览器直接运行，无需打包）](#web-版浏览器直接运行无需打包)
- [通用适配器（图像 / TTS）](#通用适配器图像--tts)
- [输出项目结构（标准 WebGAL 项目）](#输出项目结构标准-webgal-项目)
- [开发与测试](#开发与测试)
- [技术架构](#技术架构)
- [社区](#社区)
- [贡献](#贡献)
- [免责声明](#免责声明)
- [致谢与许可](#致谢与许可)
- [Roadmap](#roadmap)

</details>

## 为什么要用 NovelForge？

| | 理由 |
|---|---|
| 🪄 **一个按钮，零手工** | 手工制作一部视觉小说需要逐张绘制立绘、逐场搭建演出、逐句录制配音。NovelForge 将这些全部自动化：导入小说 → 点生成 → 得到可玩、可分发的成品 |
| 🎬 **看剧情，不是看字** | 文字承载故事，但带表情的角色、场景 CG、配音与 BGM 能提供纯文字没有的代入感——且全部自动生成，无需手工制作画面 |
| 🔥 **专为没人改编的小说而生** | 热门作品有人改编、有人翻译，小众作品却两者都难获得。NovelForge 正针对这一缺口：让冷门故事也能变成可分享的视觉小说，内置多语翻译（中/英/日/韩） |

## 一个按钮，一步到位

```
小说.txt ─▶ 一个按钮 ─▶ 立绘 · 表情 · CG · 背景 ─▶ 配音 · BGM ─▶ 可游玩的视觉小说
   AI 管线：分章 → 翻译 → 提取 → 剧本 → 图像 → 配音 → 组装        └─▶ 预览 / exe / APK / 网页版 zip
```

> 需要自备 API key（没有 key？自动进入演示模式，内置示例小说跑通全流程）。启用图像时，批量生成前有一次风格确认（视觉圣经）。

## 快速开始

### 下载应用

| 平台 | 获取方式 |
|---|---|
| Windows / macOS / Linux | [最新 Release](https://github.com/carloncc/NovelForge/releases)（无需安装 Rust/Node） |
| 任意平台（浏览器） | Web 演示版——免安装，浏览器直接运行（见下） |
| 官网 | [https://www.forgepeaknow.com/](https://www.forgepeaknow.com/) —— Web 演示与最新动态 |

> 没有 API key 也能体验：自动进入演示模式（内置示例小说），完整跑通全流程——先试再配。

### 运行 Web 演示版（免安装、不打包）

```bash
git clone git@github.com:carloncc/NovelForge.git
cd NovelForge
pnpm install
pnpm prepare:template   # 下载 WebGAL 引擎模板（仅首次，约 75MB，自动裁剪）
npm run dev             # 浏览器打开 http://localhost:5173
```

### 桌面版开发运行

```bash
pnpm tauri dev
```

环境要求：Node.js 18+ · pnpm · Rust（https://rustup.rs）· Windows / macOS / Linux。

### 打包发布

```bash
pnpm tauri build
```
产物在 `src-tauri/target/release/bundle/`（Windows exe / macOS dmg / Linux AppImage）。

### 使用流程

1. **导入小说**：选择 txt（自动识别 GBK/UTF-8），章节自动切分；支持多文件导入与 LLM 智能分章；可导入自定义素材
2. **API 配置**：填文本 LLM 的 base_url + key + model（DeepSeek 最便宜，约 ¥1-2/百万 token）；图像/TTS/视觉识别可后补，生图前需先配置图像通道
3. **生成项目**：开关（图像/表情差分/配音/视频位/BGM/登场资料卡）→ 开始生成 → 文本阶段先行；启用图像时先进入**视觉圣经确认**（选风格来源 → 生成/确认三视图 → 批准）→ 批准后续跑图像/配音/组装 → 进度日志 + 费用统计。支持分阶段生成（只重跑需要的阶段），AI 分章可提供人工意见反馈
4. **预览**：内嵌 WebGAL 引擎实时试玩
5. **导出**：网页版直接部署；exe/APK 按生成的「导出说明.txt」操作

## 什么时候不适合用 NovelForge

- 想要指定画师的像素级艺术：生成立绘是 AI 产物——适合个人项目，不适合商业美术精修交付。
- 只想要纯文字阅读器（不要画面）：这是视觉小说管线，不是电子书阅读器。
- 完全不能接受 AI 成本：生成需要用自己的 key 调用厂商 API（演示模式免费，但只产出示例项目）。

## 特性

| | 说明 |
|---|---|
| 📖 **一站式全自动管线** | 分章 → 多语翻译 → 卡片提取 → 剧本（自动 CG 演出/物品特写/登场资料卡/视频推荐位）→ 图像 → 配音 → 标准 WebGAL 组装 |
| 🎨 **无背景立绘** | 自动抠图（AI 分割，模型首次自动下载缓存；离线自动回退改进版色度键：连通 flood-fill + 去绿边 + 羽化） |
| 🎨 **画风一致性** | 全项目「风格锚点图」+ 固定种子 + 统一负面提示词 + 链式图生图（三视图 → 立绘 → 表情/动作），多模态自检按参考图核对角色一致 |
| 📖 **视觉圣经门禁** | 批量生图前必须确认「视觉圣经」：选风格来源（上传参考图由视觉通道分析 / LLM 分析整本小说生成风格示例）+ 每个主角三视图（正/侧/背）。单独重生成某角色三视图不牵连他人；任何输入变化都会使批准失效 |
| 😊 **表情差分** | 每角色 5 种表情立绘（normal 图做参考保持一致），对话按情绪自动切换 |
| 🏃 **动作立绘** | 基于三视图图生图生成动作立绘（拔剑/挥手/抱臂等），形象始终一致 |
| 🔀 **分支选择** | LLM 检测抉择时刻并生成 2-3 个选项，各分支最终汇合回主线（WebGAL choose/label/jumpLabel） |
| 🎬 **章节标题卡** | 每章开篇黑屏全屏章节名演出 |
| ✨ **画面感增强** | 名场面自动生成整幅 CG；重要物品特写演出；角色首次登场资料卡 |
| 🎬 **视频推荐位** | AI 标记名场面位置并生成视频提示词，按命名放入视频（如即梦/可灵）即自动启用（零 API 费用） |
| 🎙️ **配音 + 音色可控** | TTS 逐句配音，音色库可配置，AI 自动为角色挑选音色，失败自动降级 |
| 🎵 **BGM** | 音乐文件按氛围关键词自动匹配播放，场景/章节切换自动淡出停止，并解锁 BGM 鉴赏 |
| 🔌 **API 全自定义** | LLM / 视觉识别 / 图像 / TTS 四通道各自 base_url + api_key + model（OpenAI 兼容协议），多套配置切换 + 测试按钮；图像通道按模型配置能力（参考图数量/图生图/种子），支持自动能力探测 |
| 🗂️ **素材优先** | 导入人物/物品/背景图，支持手动映射，管线优先使用你的素材，缺失才 AI 生成 |
| ♻️ **成本可控** | 全链路磁盘缓存、断点续跑、章节级重跑、中止按钮、token/费用统计、预算上限（超限自动中止）、失败任务清单与定位重试、日志落盘 |
| 💾 **状态持久化** | 小说/素材/选项/结果随项目自动保存，AI 分章快照防止重启丢失，最近项目历史一键切换 |
| 📦 **三端导出** | 网页版 zip（自动排除缓存）/ 导出前检查（Lint）/ 导出设置（标题·Game_key·界面语言）/ PC exe（WebGAL Terre）/ 手机 APK（官方工具） |
| 🔒 **安全** | LLM 输出注入防护、CSP、依赖审计零已知 CVE |

## 截图

| 导入小说 | API 配置 | 生成项目 |
|---|---|---|
| ![导入](docs/screenshots/import.png) | ![配置](docs/screenshots/config.png) | ![生成](docs/screenshots/generate.png) |

| 导出 | 游戏标题 | 游戏剧情 |
|---|---|---|
| ![导出](docs/screenshots/export.png) | ![标题](docs/screenshots/game-title.png) | ![剧情](docs/screenshots/game-story.png) |

## API 配置示例

| 服务 | 通道 | Base URL | 模型示例 |
|---|---|---|---|
| DeepSeek | LLM | `https://api.deepseek.com` | `deepseek-chat` |
| 硅基流动 | 视觉识别 | `https://api.siliconflow.cn/v1` | `zai-org/GLM-4.6V` |
| 硅基流动 | 图像（参考图） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen-Image-Edit-2509` |
| 硅基流动 | 图像 | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| 硅基流动 | TTS | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` |
| OpenAI | LLM | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi | LLM | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（本地） | LLM | `http://localhost:11434/v1` | `qwen2.5:7b` |

**视觉识别（vision）通道**：负责所有「看懂图片」的操作（风格参考图分析、角色参考核对、图像自检），与文本 LLM 相互独立。新配置默认 vision 用硅基流动 `zai-org/GLM-4.6V`，图像默认 `Qwen/Qwen-Image-Edit-2509`（最多 3 张参考图 / 图生图）。旧三通道配置首次加载自动迁移出独立 vision 配置。

## 视觉圣经（图像生成门禁）

启用图像生成时，项目必须先确认**视觉圣经**才能批量生图（文本提取/剧本不受影响）：

- **风格来源二选一**：上传参考图（视觉通道分析并作为全局风格参考），或让 LLM 分析整本小说后生成一张无角色风格示例图。
- **角色三视图**：每个主角生成正/侧/背三视图，可单独「重新生成三视图」，可上传角色参考图；只影响该角色。
- **确认与批准**：逐角色确认 → 批准视觉圣经 → 自动续跑图像/配音/组装。任何小说、角色或风格输入变化都会使已批准状态失效。
- **绝不静默降级**：模型不支持参考图报 `REFERENCE_UNSUPPORTED`，参考文件缺失报 `REFERENCE_MISSING`；视觉通道未配置时给出明确提示。

**存储位置**：全部在项目输出目录 `.novel2vn/visual-bible/`（清单 `visual-bible.json` 只存相对路径/提示词/确认状态，不存 base64；图片为 `style-reference.*`、`style-sample.png`、`threeview_<角色ID>.png` 等）。若提示参考文件缺失，通常是目录被移动或删除：放回原路径或在视觉圣经页重新上传/重新生成即可。

## Web 版（浏览器直接运行，无需打包）

```bash
npm run dev          # 或 pnpm dev，浏览器打开 http://localhost:5173
```

Web 版与桌面版功能一致，浏览器内自动启用等价实现：

| 桌面（Tauri） | Web 版 |
|---|---|
| 本地文件系统 | IndexedDB 虚拟文件系统（数据持久化在浏览器） |
| Rust HTTP 客户端（无 CORS 限制） | dev 服务器代理转发（`/__novelforge/proxy`） |
| 内嵌本地预览服务器 | 前端 zip 打包上传 → dev 服务器解压静态服务（同源 iframe） |
| Rust rembg 抠图 | canvas 连通 flood-fill 色度键抠图（白/黑底自动去背景） |
| WebGAL 引擎模板随包携带 | dev 服务器按需同步 `src-tauri/templates/webgal` 到 IndexedDB |
| 系统文件选择对话框 | 浏览器 `<input type="file">` |
| 导出 zip 到磁盘 | 导出 zip 自动触发浏览器下载 |

> 生产部署：`npm run build` + `npm run preview`（preview 服务器同样提供代理/预览中间件，可反代部署）；
> 纯静态托管（无后端）时 API 请求降级为浏览器直连（需厂商支持 CORS）。

## 通用适配器（图像 / TTS）

各厂商图像与语音接口协议差异很大（OpenAI 兼容 / MiniMax 专有 / 阿里任务式异步），
NovelForge 内置**配置驱动的通用适配器引擎**（`sync`/`async` 两种模式 + 字段映射模板），配置页「服务商模板」一键选用：

| 服务商 | 图像 | TTS |
|---|---|---|
| OpenAI 兼容（智谱 CogView / OpenAI） | ✅ openai-image | ✅ openai-tts |
| 硅基流动（FLUX，推荐） | ✅ siliconflow-image（seed / 负面提示词 / 图生图完整支持） | ✅ openai-tts |
| MiniMax（image-01 / speech-2.8） | ✅ minimax-image | ✅ minimax-tts（HEX 自动解码） |
| 阿里百炼（wanx-v1 / CosyVoice） | ✅ dashscope-image（任务式轮询，支持 seed/负面提示词） | ✅ dashscope-tts |

预置模板另含 **Google Gemini**（`/v1beta/models/{model}:generateContent`，inlineData 自动提取）与
**Stability AI**（multipart/form-data + 原始二进制响应）。引擎自动识别各厂商错误体并转成可读信息。

任意新厂商：在「高级 → 自定义适配器模板」粘贴 JSON 模板即可接入，无需改代码。
参考图能力（0-3 张、图生图、种子）在图像通道按模型配置并自动探测；能力不足或参考文件缺失会明确报错，不会静默降级文生图。

## 输出项目结构（标准 WebGAL 项目）

```
输出目录/
├─ index.html, assets/          # WebGAL 引擎（内置）
├─ 导出说明.txt                 # exe/APK/网页版导出步骤
├─ video_plan.txt               # AI 生成的视频推荐位清单（提示词）
└─ game/
   ├─ config.txt                # 游戏配置
   ├─ scene/start.txt, ch*.txt  # 剧本（可直接文本编辑）
   ├─ background/  figure/  vocal/  bgm/  video/
   └─ .novel2vn/                # 缓存与中间产物（可删除）
      └─ visual-bible/          # 视觉圣经：清单 + 风格参考/示例 + 角色三视图
```

## 开发与测试

```bash
# 单元与端到端测试（Node）
npx tsx tests/unit-render.ts      # 渲染注入边界
npx tsx tests/unit-chapters.ts    # 章节切分边界
npx tsx tests/unit-cache.ts       # 缓存/断点续跑一致性
npx tsx tests/unit-tasks.ts       # 图像任务构建
npx tsx tests/unit-material.ts    # 素材优先匹配
npx tsx tests/unit-features.ts    # 登场资料卡/表情/BGM/视频位
npx tsx tests/unit-persist.ts     # 状态持久化
npx tsx tests/unit-retry.ts       # API 重试机制
npx tsx tests/unit-dedupe.ts      # 场景 id 去重
npx tsx tests/unit-universal.ts   # 通用适配器引擎（全厂商模板）
npx tsx tests/unit-vfs.ts         # IndexedDB 虚拟文件系统
npx tsx tests/e2e-demo.ts         # 端到端管线（示例小说）

# 引擎实机验证（无头浏览器加载 WebGAL 播放生成的游戏）
npx tsx tests/engine-check.ts <项目目录>

# Rust 侧测试（色度键抠图）
cd src-tauri && cargo test
```

## 技术架构

```
┌────────────────────────────────────────────┐
│  NovelForge（Tauri 2 + Vue 3 + TypeScript） │
│  ├─ pages: 导入 / 配置 / 生成 / 预览 / 导出  │
│  ├─ core:  split → translate → extract →   │
│  │          script → images → voice →      │
│  │          render → project               │
│  ├─ api:   OpenAI 兼容适配器               │
│  │          （LLM / 视觉 / 图像 / TTS）      │
│  └─ Rust:  文件读写 / HTTP 转发 / 预览服务器 │
│            / 色度键抠图 / 配置存储           │
└───────────────┬────────────────────────────┘
                ▼ 产出标准 WebGAL 项目
┌────────────────────────────────────────────┐
│  WebGAL 引擎（MPL-2.0，不改源码）            │
│  预览（内嵌）/ exe（Terre）/ APK（官方工具）  │
└────────────────────────────────────────────┘
```

## 社区

- [官网](https://www.forgepeaknow.com/) —— Web 演示与最新动态
- [Issues & 功能建议](https://github.com/carloncc/NovelForge/issues) —— 报 bug、提想法、给反馈
- [Discussions](https://github.com/carloncc/NovelForge/discussions) —— 晒出你做出来的游戏、提问交流
- [WebGAL](https://github.com/OpenWebGAL/WebGAL) —— 引擎本体，它的社区熟悉 WebGAL 场景脚本

[![Star History](https://api.star-history.com/svg?repos=carloncc/NovelForge&type=Date)](https://star-history.com/#carloncc/NovelForge&Date)

把你生成的视觉小说晒出来——这正是这个工具存在的意义。

## 贡献

欢迎一切形式的贡献——bug 报告、功能建议、翻译、代码。

- 报 bug / 提需求：[Issues](https://github.com/carloncc/NovelForge/issues)
- 交流讨论：[Discussions](https://github.com/carloncc/NovelForge/discussions)
- 提交代码前请先跑测试（见[开发与测试](#开发与测试)）

**主要维护者：** [@carloncc](https://github.com/carloncc)

## 免责声明

本软件按「现状」提供，不作任何担保。使用 NovelForge 即表示你知晓并同意：

- **你对生成内容全权负责**：工具产出的所有 AI 内容（图像/配音/剧本）及你的使用、发布、分发方式均由你承担责任。作者无法控制模型输出，对此不承担任何责任。
- **只使用你有权使用的内容**：请仅导入你拥有或已获授权改编的小说。生成结果可能受你所配置的 AI 服务商条款约束。
- **第三方 API 费用与条款自理**：NovelForge 使用你自己配置的 key 调用服务商，请自行监控用量与账单。
- **禁止生成违法或侵权内容**：包括受版权保护的角色、真实人物肖像、仇恨与有害内容。你须遵守适用的法律法规与平台政策。
- **保留必要署名**：使用 NovelForge 发布的作品须保留 WebGAL 版权声明（见 [LICENSE](./LICENSE)）。

## 致谢与许可

- [WebGAL](https://github.com/OpenWebGAL/WebGAL) —— 视觉小说引擎（MPL-2.0），详见 [THIRD_PARTY_NOTICE](./THIRD_PARTY_NOTICE)
- NovelForge 本体采用 [MIT](./LICENSE) 许可
- 使用 NovelForge 发布作品时须保留 WebGAL 版权声明；游戏内容版权归创作者所有

## Roadmap

- [x] 画风一致性：风格锚点图 + 固定种子 + 负面提示词 + 链式图生图
- [x] 剧情分支选择（choose/jumpLabel，LLM 自动标注抉择时刻）
- [x] 章节标题卡 / 标题画面（Title_img/Title_bgm）/ BGM 自动淡出停止与鉴赏解锁
- [x] 视觉圣经门禁：风格参考 + 角色三视图 + 批准流程
- [x] 分阶段生成 + 人工意见反馈（AI 分章）/ 多文件导入 / 多语翻译
- [ ] 表情差分图生图增强（更多表情/服饰差分）
- [ ] AI 音乐生成通道（BGM 全自动）
- [ ] 转场动画演出（背景转场特效）
- [ ] 游戏内角色图鉴
- [ ] 旁白/独白配音（旁白音色）
- [ ] 图片立绘嘴型同步（差分口型）
