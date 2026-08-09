<div align="center">

<img src="docs/logo.png" width="96" alt="NovelForge" />

# NovelForge

**AI 小说 → 视觉小说转换工具** · AI-powered Novel to Visual Novel Converter

导入小说 txt，AI 全自动转换为可玩的视觉小说，导出 PC exe / 手机 APK / 网页版。

Tauri 2 + Vue 3 + WebGAL · 轻量快速 · API 全自定义

</div>

---

## 特性

| | 说明 |
|---|---|
| 📖 **AI 全自动管线** | ① 提取角色/场景/物品卡 → ② 分章剧本（自动编排 CG / 物品演出 / 登场资料卡 / 视频推荐位）→ ③ 生成立绘/背景/CG/物品图 → ④ TTS 配音 → ⑤ 渲染组装 |
| 🎨 **无背景立绘** | AI 抠图（isnet-anime 分割，首次自动下载模型并缓存）优先，失败/离线自动回退改进版色度键抠图（连通 flood-fill + 去绿边 + 羽化） |
| 🎨 **画风一致性** | 全项目「风格锚点图」统一背景/CG 画风 + 固定种子 + 统一负面提示词 + 三视图→立绘→表情/动作链式图生图，多模态自检按参考图核对角色一致 |
| 📖 **视觉圣经门禁** | 批量生图前必须确认「视觉圣经」：上传参考图或整本小说分析确定统一风格 + 每个主角三视图，确认后才放行图像/配音/组装；可单独重生成某一角色三视图，不牵连其他角色 |
| 😊 **表情差分** | 每角色 5 种表情立绘（normal 图做参考保持一致），对话按情绪自动切换 |
| 🔀 **分支选择** | 剧情「抉择时刻」LLM 自动生成 2-3 个选项，各选项进入独立分支后汇合回主线（WebGAL choose/label/jumpLabel） |
| 🎬 **章节标题卡** | 每章开篇黑屏全屏章节名演出，与成熟视觉小说一致 |
| ✨ **画面感增强** | 名场面自动生成整幅 CG；重要物品特写演出；角色首次登场资料卡 |
| 🎬 **视频推荐位** | AI 标记名场面位置 + 生成视频提示词，人工在即梦/可灵生成后按命名放入即自动启用（零 API 费用） |
| 🎙️ **配音 + 音色可控** | TTS 逐句配音，音色库可配置，AI 自动为角色挑选音色，失败自动降级 |
| 🎵 **BGM** | 音乐文件按氛围关键词自动匹配播放，场景/章节切换自动淡出停止（不串场），并解锁 BGM 鉴赏 |
| 🔌 **API 全自定义** | LLM / 视觉识别 / 图像 / TTS 四通道各自 base_url + api_key + model（OpenAI 兼容协议），多套配置切换 + 测试按钮；图像通道可配置参考图数量/图生图/种子等能力 |
| 🗂️ **素材优先** | 导入人物参考图/物品图/背景图，支持手动映射，管线优先用你的素材，缺失才 AI 生成；支持图生图 |
| ♻️ **成本可控** | 全链路磁盘缓存、断点续跑、章节级重跑、中止按钮、token/费用统计 |
| 💾 **状态持久化** | 小说/素材/选项/结果随项目自动保存，重开恢复，最近项目历史一键切换 |
| 🎯 **成本控制** | 生成前预算上限（超限自动中止）、失败任务清单与定位重试、日志落盘 |
| 📦 **三端导出** | 网页版 zip 一键打包（自动排除缓存）/ 导出前检查（Lint）/ 导出设置（标题·Game_key·多语言）/ PC exe / 手机 APK |
| 🔒 **安全** | LLM 输出注入防护、CSP、依赖审计零已知 CVE |

## 截图

| 导入小说 | API 配置 | 生成项目 |
|---|---|---|
| ![导入](docs/screenshots/import.png) | ![配置](docs/screenshots/config.png) | ![生成](docs/screenshots/generate.png) |

| 导出 | 游戏标题 | 游戏剧情 |
|---|---|---|
| ![导出](docs/screenshots/export.png) | ![标题](docs/screenshots/game-title.png) | ![剧情](docs/screenshots/game-story.png) |

## 快速开始

### 环境要求
- Node.js 18+ · pnpm
- Rust（仅开发/打包需要）：https://rustup.rs
- Windows / macOS / Linux
- Linux 用户建议安装中文字体（界面中文显示）：`sudo apt install fonts-noto-cjk`

### 开发运行

```bash
pnpm install
pnpm prepare:template   # 下载 WebGAL 引擎模板（仅首次，约 75MB，自动裁剪）
pnpm tauri dev
```

### 打包发布

```bash
pnpm prepare:template   # 如未执行过
pnpm tauri build
```
产物在 `src-tauri/target/release/bundle/`（Windows exe / macOS dmg / Linux AppImage）。

### 使用流程

1. **导入小说**：选择 txt（自动识别 GBK/UTF-8），章节自动切分；可导入自定义素材
2. **API 配置**：填文本 LLM 的 base_url + key + model（DeepSeek 约 ¥1-2/百万 token 最便宜）；图像/TTS/视觉识别可后补，生图前需先配置图像通道
3. **生成项目**：配置开关（图像/表情差分/配音/视频位/BGM/登场资料卡）→ 开始生成 → 文本阶段先行；启用图像时先进入**视觉圣经确认**（选风格来源 → 生成/确认三视图 → 批准）→ 批准后续跑图像/配音/组装 → 进度日志 + 费用统计
4. **预览**：内嵌 WebGAL 引擎实时试玩
5. **导出**：网页版直接部署；exe/APK 按生成的「导出说明.txt」操作

> 没有 API key 也能体验：自动进入演示模式（内置示例小说），完整跑通全流程。

## API 配置示例

| 服务 | 类型 | Base URL | 模型示例 |
|---|---|---|---|
| DeepSeek | LLM | `https://api.deepseek.com` | `deepseek-chat` |
| 硅基流动 | 视觉识别 | `https://api.siliconflow.cn/v1` | `zai-org/GLM-4.6V` |
| 硅基流动 | 图像（参考图） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen-Image-Edit-2509` |
| 硅基流动 | 图像 | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| 硅基流动 | TTS | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` |
| OpenAI | LLM | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi | LLM | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（本地） | LLM | `http://localhost:11434/v1` | `qwen2.5:7b` |

**视觉识别（vision）通道**：负责所有「看懂图片」的操作（风格参考图分析、角色参考核对、图像自检），与文本 LLM 相互独立，即使文本模型不支持图片也能正常工作。新配置默认 vision 使用硅基流动 `zai-org/GLM-4.6V`，图像默认 `Qwen/Qwen-Image-Edit-2509`（支持最多 3 张参考图 / 图生图）。旧三通道配置首次加载会自动迁移出独立的 vision 配置，不会重复生成。

## 视觉圣经（图像生成门禁）

启用图像生成时，项目必须先确认**视觉圣经**才能批量生图（文本提取/剧本不受影响）：

- **风格来源二选一**：上传一张参考图（由视觉通道分析并直接作为全局风格参考），或让文本 LLM 分析整本小说、再生成一张无角色风格示例图。
- **角色三视图**：每个主角生成三视图（正面/侧面/背面），可单独「重新生成三视图」，可上传角色参考图；只影响该角色，不牵连其他角色与背景/CG。
- **确认与批准**：逐角色确认三视图 → 批准视觉圣经 → 自动续跑图像/配音/组装。任何小说、角色或风格输入变化都会让已批准状态变为「失效」，需重新确认。
- **能力与报错**：图像模型不支持参考图时报 `REFERENCE_UNSUPPORTED`、参考文件缺失时报 `REFERENCE_MISSING`，绝不会静默降级成文生图；视觉通道未配置时给出明确配置提示。

**存储位置**：全部落在项目输出目录 `.novel2vn/visual-bible/` 下（清单 `visual-bible.json` 只存相对路径/提示词/确认状态，不存图片 base64；图片为 `style-reference.*`、`style-sample.png`、`threeview_<角色ID>.png` 等）。若提示参考文件缺失，通常是该目录被手动移动或删除：将文件放回原相对路径，或在视觉圣经页重新上传/重新生成即可恢复。

### Web 版（浏览器直接运行，无需打包）

```bash
npm run dev          # 或 pnpm dev，浏览器打开 http://localhost:5173
```

Web 版与桌面版功能一致，浏览器内自动启用等价实现：

| 桌面（Tauri） | Web 版 |
|---|---|
| 本地文件系统 | IndexedDB 虚拟文件系统（数据持久化在浏览器） |
| Rust HTTP 客户端（无 CORS 限制） | dev 服务器代理转发（`/__novelforge/proxy`） |
| 内嵌本地预览服务器 | 前端 zip 打包上传 → dev 服务器解压静态服务（同源 iframe） |
| Rust rembg 抠图 | canvas 四角 flood-fill 抠图（白/黑底自动去背景） |
| WebGAL 引擎模板随包携带 | dev 服务器按需同步 `src-tauri/templates/webgal` 到 IndexedDB |
| 系统文件选择对话框 | 浏览器 `<input type="file">` |
| 导出 zip 到磁盘 | 导出 zip 自动触发浏览器下载 |

> 生产部署：`npm run build` + `npm run preview`（preview 服务器同样提供代理/预览中间件，可反代部署）；
> 纯静态托管（无后端）时 API 请求降级为浏览器直连（需厂商支持 CORS）。

### 通用适配器（图像 / TTS）

各厂商图像与语音接口协议差异很大（OpenAI 兼容 / MiniMax 专有 / 阿里任务式异步），
NovelForge 内置**配置驱动的通用适配器引擎**（`sync`/`async` 两种模式 + 字段映射模板），
配置页「服务商模板」一键选用即可：

| 服务商 | 图像 | TTS |
|---|---|---|
| OpenAI 兼容（智谱 CogView / OpenAI） | ✅ openai-image | ✅ openai-tts |
| 硅基流动（FLUX，推荐） | ✅ siliconflow-image（seed / 负面提示词 / 图生图完整支持） | ✅ openai-tts |
| MiniMax（image-01 / speech-2.8） | ✅ minimax-image | ✅ minimax-tts（HEX 自动解码） |
| 阿里百炼（wanx-v1 / CosyVoice） | ✅ dashscope-image（任务式轮询，支持 seed/负面提示词） | ✅ dashscope-tts |

任意新厂商：在「高级 → 自定义适配器模板」粘贴 JSON 模板即可接入，无需改代码。
图像通道的参考图能力（图生图）在「图像模型能力」中按模型配置：参考图数量（0-3）、图生图支持、种子支持与编码方式。
启用图像生成时按视觉圣经的参考图驱动角色一致性；模型参考图能力不足或参考文件缺失会明确报错，不会静默降级文生图。

预置模板另含 **Google Gemini**（`/v1beta/models/{model}:generateContent`，inlineData 自动提取）与
**Stability AI**（multipart/form-data + 原始二进制响应）。引擎自动识别各厂商错误体
（base_resp / error.message / output.message 等）并转成可读信息。

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
npx tsx tests/e2e-demo.ts         # 管线端到端

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
│  ├─ core:  extract → script → images →     │
│  │          voice → render → project        │
│  ├─ api:   OpenAI 兼容适配器（LLM/图像/TTS） │
│  └─ Rust:  文件读写 / HTTP 转发 / 预览服务器 │
│            / 色度键抠图 / 配置存储           │
└───────────────┬────────────────────────────┘
                ▼ 产出标准 WebGAL 项目
┌────────────────────────────────────────────┐
│  WebGAL 引擎（MPL-2.0，不改源码）            │
│  预览（内嵌）/ exe（Terre）/ APK（官方工具）  │
└────────────────────────────────────────────┘
```

## 致谢与许可

- [WebGAL](https://github.com/OpenWebGAL/WebGAL) —— 视觉小说引擎（MPL-2.0），详见 [THIRD_PARTY_NOTICE](./THIRD_PARTY_NOTICE)
- NovelForge 本体采用 [MIT](./LICENSE) 许可
- 使用 NovelForge 发布作品时须保留 WebGAL 版权声明；游戏内容版权归创作者所有

## Roadmap

- [x] 画风一致性：风格锚点图 + 固定种子 + 负面提示词 + 链式图生图（含修复默认立绘未生成的缺陷）
- [x] 剧情分支选择（choose/jumpLabel，LLM 自动标注抉择时刻）
- [x] 章节标题卡 / 标题画面（Title_img/Title_bgm）/ BGM 自动淡出停止与鉴赏解锁
- [ ] 表情差分图生图增强（更多表情/服饰差分）
- [ ] AI 音乐生成通道（BGM 全自动）
- [ ] 转场动画演出（背景转场特效）
- [ ] 游戏内角色图鉴
- [ ] 旁白/独白配音（旁白音色）
- [ ] 图片立绘嘴型同步（差分口型）
