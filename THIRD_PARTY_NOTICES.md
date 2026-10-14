# Third-Party Notices

本文件记录 NovelForge 直接借鉴或随包分发的第三方开源项目（许可证要求署名与说明）。

## WebGAL（随包分发的引擎）

- 项目名：OpenWebGAL/WebGAL
- 地址：https://github.com/OpenWebGAL/WebGAL
- 许可证：Mozilla Public License 2.0（MPL-2.0）
- 随包版本：**4.6.6**（官方 Release 资产 `WebGAL-4.6.6-web.zip`，sha256
  `d8011933005f62397b3d1ea6cd14b8a7f58ce34a390000afa48f12a2d8f0349a`）
- 随包位置：`src-tauri/templates/webgal/`（由 `pnpm prepare:template` 下载生成，不在版本库内）
- 分发形态：① `src-tauri/src/lib.rs` 的 `include_dir!` 静态编入桌面端二进制；
  ② `src-tauri/tauri.conf.json` 的 `bundle.resources` 随安装包分发；
  ③ 组装生成游戏时复制进每个导出的游戏目录
- 许可证副本：随包放在 `src-tauri/templates/webgal/LICENSE`
  （由 `scripts/fetch-webgal-template.mjs` 从上游拉取，sha256
  `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5`；
  上游 web 包根目录本身不含 LICENSE）
- **修改说明**：随包分发的引擎产物**并非上游原样**——`scripts/fetch-webgal-template.mjs`
  会改写引擎入口 JS（`voiceInterruption` 默认值）、在 `index.html` 注入 file:// 协议探测脚本、
  用本项目文件覆盖 4 个界面样式文件，并新增鉴赏室页面与内置音效。
  逐文件、逐项说明见 [`THIRD_PARTY_MODIFICATIONS.md`](./THIRD_PARTY_MODIFICATIONS.md)；
  施加改动的脚本与源文件均在本仓库内（`scripts/fetch-webgal-template.mjs`、`src/gameExtra/`）
- 发布要求（来自上游官方下载页）：使用 WebGAL 制作的游戏在发布时须保留 WebGAL 相关版权声明；
  使用本软件产生的所有风险由使用者自行承担

## TongjiAI4E / VN_Sprite_Expression_Workflow
