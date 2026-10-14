# 第三方代码修改说明（WebGAL 引擎模板）

本文件记录 NovelForge 对**随包分发的第三方代码**所做的修改，供使用者与再分发者核查。
只陈述技术事实（改了哪个文件、改了什么、为什么），不含法律结论。

- 被修改的第三方项目：[OpenWebGAL/WebGAL](https://github.com/OpenWebGAL/WebGAL)
- 上游版本：**4.6.6**（`WebGAL-4.6.6-web.zip`，官方 Release 资产）
- 许可证：Mozilla Public License 2.0（MPL-2.0）——上游仓库根 `LICENSE`
- 随包位置：`src-tauri/templates/webgal/`（该目录由 `scripts/fetch-webgal-template.mjs` 生成，
  在 `.gitignore` 中，不进入版本库）
- 分发形态：① 经 `src-tauri/src/lib.rs` 的 `include_dir!` 静态编入桌面端二进制；
  ② 经 `src-tauri/tauri.conf.json` 的 `bundle.resources` 随安装包分发；
  ③ 组装生成游戏时被复制进每个导出的游戏目录
- 许可证副本：`src-tauri/templates/webgal/LICENSE`（由 `prepare:template` 从上游拉取，
  sha256 `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5`）

## 修改清单（全部由 `scripts/fetch-webgal-template.mjs` 在下载解压后施加）

| # | 目标文件 | 修改内容 | 原因 |
|---|---|---|---|
| 1 | `assets/index-*.js`（引擎入口，文件名带内容哈希） | 全局字符串替换 `voiceInterruption:ud.no` → `voiceInterruption:ud.yes`（见脚本 `ensureVoiceInterruptionPatch`） | 引擎默认快进/跳句时旧语音不中断；改为中断更符合 galgame 习惯。`check-template.mjs` 会校验该替换已生效 |
| 2 | `index.html` | 在 `</body>` 前注入一段 file:// 协议探测脚本（注入体见 `scripts/file-protocol-probe.html`，见脚本 `ensureFileProtocolProbe`） | 引擎以 ES module 加载，`file://` 下 origin 为不透明 `null`，浏览器按 CORS 拦截，页面停在空白开始页；探测脚本直接替换标题区文案并给出启动方式 |
| 3 | `game/userStyleSheet.css` | 整份替换为 NovelForge 的全局界面主题（源：`src/gameExtra/game-ui/userStyleSheet.css`，见脚本 `ensureGameUi` / `GAME_UI_COPIES`） | 覆盖引擎默认浅蓝主题，统一为深色玻璃拟态风格 |
| 4 | `game/template/UI/Title/title.scss` | 整份替换（源：`src/gameExtra/game-ui/UI/Title/title.scss`） | 标题画面定制 |
| 5 | `game/template/Stage/TextBox/textbox.scss` | 整份替换（源：`src/gameExtra/game-ui/Stage/TextBox/textbox.scss`） | 文本框定制（2560×1440 设计像素、行高/高度约束） |
| 6 | `game/template/Stage/Choose/choose.scss` | 整份替换（源：`src/gameExtra/game-ui/Stage/Choose/choose.scss`） | 选项按钮定制 |
| 7 | `appreciation.html`（新增文件） | 新增 NovelForge 的鉴赏室页面（源：`src/gameExtra/appreciation.html`，见脚本 `ensureAppreciation`） | 引擎自带鉴赏页不满足本项目需求；Web 模式与内嵌模板共用这一份 |
| 8 | `game/vocal/se_*.wav`（新增文件，8 个） | 新增 NovelForge 内置音效（源：`src/gameExtra/se/`，见脚本 `ensureBuiltinSe`） | 下载包中的 `game/vocal` 被裁掉，需回填，否则 `playEffect` 指向不存在的音频 |
| 9 | `game/{vocal,bgm,video,scene,background,figure}`（删除） | 删除上游演示内容（见脚本 `REMOVE`） | 引擎运行时不需要上游 demo 素材，减小包体 |

补充说明：

- 修改 1、2 属于对上游**构建产物**（压缩后的 JS / HTML）的功能性改写；
  修改 3–6 属于用本项目文件**整体覆盖**上游同名资源；修改 7、8 是新增文件；
  修改 9 是删除上游演示素材。模板中其余文件（引擎 `assets/` 产物、`icons/`、
  `manifest.json`、`webgal-serviceworker.js`、`webgal-engine.json`、
  `game/animation/*.json`、`game/config.txt`、`game/flowchart.json` 等）保持上游原样。
- `scripts/check-template.mjs` 会在构建前校验修改 1 已生效、修改 3–6 已回填、修改 8 齐全，
  以及主题里的 CSS Modules 哈希类名在引擎产物中仍存在（引擎升级后这些规则会静默失效，
  该检查会给出警告）。
- 复现方式：`pnpm prepare:template`（下载官方 4.6.6 资产 → 校验 sha256 → 解压 → 施加上述修改）。
  修改后的产物本身不进入版本库；上游源码可从
  <https://github.com/OpenWebGAL/WebGAL> 获取，本项目施加的改动全部由上述脚本与本仓库内
  `src/gameExtra/` 下的源文件完整描述。
- 版本纪律：`scripts/fetch-webgal-template.mjs` 的 `VERSION` 与官方资产摘要
  （`OFFICIAL_RELEASE_DIGESTS`）、`src/core/render.ts` 的 `SUPPORTED_WEBGAL_VERSION`
  必须同步；`tests/unit-webgal-version.ts` 会把这条纪律变成门禁断言。
