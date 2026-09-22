# Third-Party Notices

本文件记录 NovelForge 直接借鉴的第三方开源项目（许可证要求署名与说明）。

## TongjiAI4E / VN_Sprite_Expression_Workflow

- 项目名：TongjiAI4E/VN_Sprite_Expression_Workflow
- 地址：https://github.com/TongjiAI4E/VN_Sprite_Expression_Workflow
- 许可证：MIT License（原项目所有权利归其作者所有）
- 参考版本：v0.1.0（JS + Python）
- 借鉴性质：算法与参数参考 + 自研重新实现（TypeScript）。未复制其源代码文件；
  生图候选、rig 自动标定、管线接入均为 NovelForge 自研。

### 参考的算法与参数（详见其 rig.json / verify.py / README / AGENTS.md）

- 固定原图 alpha 与允许区外像素，只合成眉/眼/嘴（+红晕）独立图层。
- 允许区：五官椭圆选区 `[cx,cy,rx,ry]` 并集，扩大 **1.08** 倍后按
  `(1-q) * min(rx,ry) / feather` 羽化，其中 `q = hypot((x-cx)/(rx*1.08), (y-cy)/(ry*1.08))`。
- 笔触提取：以「净脸候选 vs 表情候选」的通道差提取；
  眉/嘴只用变暗 `dark`，眼睛用 `max(dark,light)`；软阈值 `(delta - 7) / 24`。
- 肤色对齐：低色差样本的通道中位差（median of `clean - cand`），跳过高饱和像素。
- 眼球区域乘 `(1 - hairMask)` 解决刘海穿眼；眉毛不受头发遮挡影响。
- 核验：`outside_mask_exact`（允许区外逐像素完全一致）+
  `alpha_exact`（整幅 alpha 通道完全一致）；不合格 exit 1 / 记失败项。
- 纪律：不得为了让校验通过而放宽掩膜；掩膜参数与校验阈值分开放置。

### NovelForge 内对应实现

- `src/core/spriteVerify.ts`（#1084）：允许区掩膜 + 三项校验 + 差异像素数/bbox。
- `src/core/faceRig.ts`（#1085）：rig 结构（crop / parts / skinSamples / feather /
  hairMask）+ base 指纹；bbox 由 vision 模型自动标定（原项目为人工量测）。
- `src/core/faceComposite.ts`（#1086）：裁脸 → 表情编辑 → 上述算法合成回原图 →
  #1084 核验；经 `ImageTask.faceComposite` 可选标记接入（默认关闭）。
