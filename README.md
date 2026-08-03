<div align="center">

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
| 🎨 **无背景立绘** | AI 生成 + 色度键自动抠图（透明底，零依赖零费用） |
| 😊 **表情差分** | 每角色 5 种表情立绘（normal 图做参考保持一致），对话按情绪自动切换 |
| ✨ **画面感增强** | 名场面自动生成整幅 CG；重要物品特写演出；角色首次登场资料卡 |
| 🎬 **视频推荐位** | AI 标记名场面位置 + 生成视频提示词，人工在即梦/可灵生成后按命名放入即自动启用（零 API 费用） |
| 🎙️ **配音 + 音色可控** | TTS 逐句配音，音色库可配置，AI 自动为角色挑选音色，失败自动降级 |
| 🎵 **BGM** | 音乐文件按氛围关键词自动匹配播放 |
| 🔌 **API 全自定义** | LLM / 图像 / TTS 三通道各自 base_url + api_key + model（OpenAI 兼容协议），多套配置切换 + 测试按钮 |
| 🗂️ **素材优先** | 导入人物参考图/物品图/背景图，支持手动映射，管线优先用你的素材，缺失才 AI 生成；支持图生图 |
| ♻️ **成本可控** | 全链路磁盘缓存、断点续跑、章节级重跑、中止按钮、token/费用统计 |
| 💾 **状态持久化** | 小说/素材/选项/结果随项目自动保存，重开恢复，多项目切换 |
| 📦 **三端导出** | 网页版（浏览器即玩）/ PC exe（WebGAL Terre 一键导出）/ 手机 APK（官方构建工具） |
| 🔒 **安全** | LLM 输出注入防护、CSP、依赖审计零已知 CVE |

## 截图

| 导入小说 | API 配置 | 生成项目 |
|---|---|---|
| ![导入](docs/screenshots/import.png) | ![配置](docs/screenshots/config.png) | ![生成](docs/screenshots/generate.png) |

## 快速开始

### 环境要求
- Node.js 18+ · pnpm
- Rust（仅开发/打包需要）：https://rustup.rs
- Windows / macOS / Linux

### 开发运行

```bash
pnpm install
pnpm tauri dev
```

### 打包发布

```bash
pnpm tauri build
```
产物在 `src-tauri/target/release/bundle/`（Windows exe / macOS dmg / Linux AppImage）。

### 使用流程

1. **导入小说**：选择 txt（自动识别 GBK/UTF-8），章节自动切分；可导入自定义素材
2. **API 配置**：填文本 LLM 的 base_url + key + model（DeepSeek 约 ¥1-2/百万 token 最便宜）；图像/TTS 可后补
3. **生成项目**：配置开关（图像/表情差分/配音/视频位/BGM/登场资料卡）→ 开始生成 → 进度日志 + 费用统计
4. **预览**：内嵌 WebGAL 引擎实时试玩
5. **导出**：网页版直接部署；exe/APK 按生成的「导出说明.txt」操作

> 没有 API key 也能体验：自动进入演示模式（内置示例小说），完整跑通全流程。

## API 配置示例

| 服务 | 类型 | Base URL | 模型示例 |
|---|---|---|---|
| DeepSeek | LLM | `https://api.deepseek.com` | `deepseek-chat` |
| 硅基流动 | 图像 | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| 硅基流动 | TTS | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` |
| OpenAI | LLM | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi | LLM | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（本地） | LLM | `http://localhost:11434/v1` | `qwen2.5:7b` |

任意 OpenAI 兼容服务均可；图像通道支持参考图（图生图）时自动用于角色一致性，不支持则自动降级文生图。

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

- [ ] 表情差分图生图增强（更多表情/服饰差分）
- [ ] AI 音乐生成通道（BGM 全自动）
- [ ] 转场动画演出
- [ ] 游戏内角色图鉴
