# 官网修改方案（www.forgepeaknow.com）

> 状态：方案 v1.0 · 未实施
> 目标：让 GitHub README（4 语言，已带 UTM）引来的流量在官网落地为「产品认知 + 下载 + 演示 + 统计闭环」

## 现状诊断（2026-08 实测抓取）

| # | 问题 | 位置 | 优先级 |
|---|---|---|---|
| 1 | Products 区空占位（"正在加载产品…"，0 张产品卡片） | 首页中部 | 🔴 高 |
| 2 | CTA「开始使用」指向 `#products` 空锚点，点击无效果 | Hero 底部 + 尾段 | 🔴 高 |
| 3 | footer GitHub 是裸链接 `github.com` | 页脚 | 🟡 中 |
| 4 | 全站仅中文，无语言切换（README 已 4 语言） | 全局 | 🟢 低（v2） |
| 5 | 无统计工具承接 UTM（README 的 utm 参数已就绪） | 全站 | 🟡 中 |
| ✅ | SEO 基础良好：og:image（NovelForge 截图）、description/keywords 已覆盖 NovelForge | head | — |

## A. 首页修改（最小必要）

1. **Products 区改为静态产品卡片**（移除"正在加载"JS 占位），NovelForge 卡片：
   - logo + 标题「NovelForge · AI 小说 → 视觉小说」
   - 一句话：导入小说，一键生成可玩视觉小说（立绘 / 表情 / CG / 配音 / BGM），导出 PC / APK / 网页
   - 亮点 tag ×3：无需编程 · 自备 API key · 开源 MIT
   - 按钮 ×3：`体验产品`（→ /novelforge）· `GitHub`（→ carloncc/NovelForge）· `在线演示`
2. **Hero CTA 改向**：「开始使用」→ /novelforge 或在线演示；hero 下加产品主视觉（`/demo/novelforge-generate.png` 已存在）
3. **footer 修链**：GitHub → `https://github.com/carloncc/NovelForge`

## B. 新增产品页 `/novelforge`（承接 UTM 流量主落地页）

终端风格延续，页面结构：

```
hero: "One click from novel to visual novel." + 生成界面截图
特性 6 格:
  全自动管线（分章→翻译→提取→剧本→图像→配音→组装）
  无背景立绘（AI 分割 + 色度键回退）
  表情差分 + 三视图（视觉圣经门禁）
  配音 + BGM（音色库 / 氛围匹配）
  多语翻译（中/英/日/韩）
  三端导出（exe / APK / 网页 zip）
下载区: GitHub Releases · Web 演示 · 系统要求
API 兼容表: DeepSeek / 硅基流动 / Ollama / OpenAI / Kimi / MiniMax / 阿里百炼 / Gemini / Stability
FAQ 5 条:
  需要 API key 吗？—— 演示模式无需，完整生成需自备 key
  免费吗？—— 开源 MIT，API 费用自担
  生成质量如何？—— 与所选模型能力相关，支持风格锚点/三视图保证一致性
  能商用/分发吗？—— 可以，保留 WebGAL 版权声明即可（链接免责声明）
  支持哪些平台？—— Win / macOS / Linux + 浏览器 Web 版
免责声明块（与 README 一致）
CTA: 去 GitHub ⭐ / 在线体验
SEO: title / description / hreflang（en / zh / ja / ko）
```

## C. 统计承接（UTM 闭环）

1. 接入统计：Cloudflare Web Analytics（免费、零代码）或 Plausible / GA4
2. README 已带参数：`utm_source=github&utm_medium=readme&utm_content={en|zh-cn|ja-jp|ko-kr}`
   - 统计后台可直接按 `utm_content` 看各语言 README 的转化
3. **站内 UTM 透传**：带参数进站后站内跳转（首页 → /novelforge → 下载）不丢参数，保证转化路径完整可归因
4. 建议事件埋点：`novelforge.cta_click` / `novelforge.download_click` / `novelforge.demo_click`

## D. 可选 v2

- 首页 + 产品页语言切换（EN / 中文，hreflang 对齐 README 4 语言）
- NovelForge 页加"用 NovelForge 做的游戏"画廊（社区 UGC 展示，呼应 README Community）

## 验收标准

- [ ] 首页 Products 区显示产品卡片，CTA 可点击到达产品页/演示
- [ ] /novelforge 页上线，SEO（title/description/hreflang）就绪
- [ ] footer GitHub 链接指向真实仓库
- [ ] 统计工具接入，README UTM 参数在后台可区分 4 语言来源
- [ ] 站内跳转 UTM 透传不丢失
