<script setup lang="ts">
import { ref } from "vue";
import { projectState } from "../stores/project";
import { tauri } from "../utils/tauri";

const message = ref("");

async function openFolder(): Promise<void> {
  if (!projectState.lastResult) {
    message.value = "请先生成项目";
    return;
  }
  await tauri.openInExplorer(projectState.lastResult.meta.outputDir);
}

async function copyPath(): Promise<void> {
  if (!projectState.lastResult) return;
  await navigator.clipboard.writeText(projectState.lastResult.meta.outputDir);
  message.value = "路径已复制到剪贴板";
}
</script>

<template>
  <div class="page-title">导出</div>
  <div class="page-sub">生成的标准 WebGAL 项目可三端分发：网页版 / PC exe / 手机 APK</div>

  <div class="card">
    <h3>当前项目</h3>
    <p v-if="projectState.lastResult">
      <span style="color: var(--accent-2); font-weight: 600">{{ projectState.lastResult.meta.title }}</span>
      · {{ projectState.lastResult.meta.chapterCount }} 章 ·
      {{ projectState.lastResult.meta.sceneCount }} 场景 ·
      {{ projectState.lastResult.meta.lineCount }} 句台词
      <br />
      <code style="color: var(--text-dim)">{{ projectState.lastResult.meta.outputDir }}</code>
    </p>
    <p v-else class="empty">尚未生成项目</p>
    <div class="row" style="margin-top: 10px">
      <button class="btn" @click="openFolder">在文件管理器中打开</button>
      <button class="btn secondary" @click="copyPath">复制路径</button>
    </div>
    <p v-if="message" style="color: var(--ok); margin-top: 8px">{{ message }}</p>
  </div>

  <div class="card">
    <h3>① 网页版（手机/PC 浏览器即玩，零成本）</h3>
    <p style="color: var(--text-dim); line-height: 1.9">
      项目文件夹本身就是一个完整网页游戏（含 WebGAL 引擎）。把整个文件夹（不含
      <code>.novel2vn</code> 隐藏目录）上传到任意静态托管（GitHub Pages / Vercel / 云服务器 / 网盘直链），
      或在手机上用浏览器直接打开 <code>index.html</code> 即可游玩。
    </p>
  </div>

  <div class="card">
    <h3>② PC 端 exe（WebGAL Terre 编辑器，官方方案）</h3>
    <p style="color: var(--text-dim); line-height: 1.9">
      下载
      <a href="https://www.openwebgal.com/zh-cn/download/" target="_blank" style="color: var(--accent-2)">WebGAL Terre 编辑器</a>
      → 新建项目指向本项目的 <code>game</code> 文件夹（或直接打开项目）→ 点击「发布游戏」→ 选择
      Windows 即可一键导出 exe 安装包。
    </p>
  </div>

  <div class="card">
    <h3>③ 手机端 APK（官方构建工具）</h3>
    <p style="color: var(--text-dim); line-height: 1.9">
      使用官方
      <a href="https://github.com/OpenWebGAL/webgal-apk-build-tool" target="_blank" style="color: var(--accent-2)">webgal-apk-build-tool</a>
      （或 WebGAL-Android 壳工程）读取本项目文件夹 + 签名信息，一键构建 Android 安装包。
      需要安装 Android SDK 环境；也可以用网页版 + PWA 方案零成本替代。
    </p>
  </div>

  <div class="card">
    <h3>使用注意</h3>
    <ul style="color: var(--text-dim); font-size: 13px; line-height: 2; padding-left: 18px">
      <li>发布时须保留 WebGAL 版权声明（MPL-2.0），游戏本身版权归你所有。</li>
      <li>生成素材缓存在 <code>.novel2vn/cache</code>，重新生成不重复计费；删除该目录可彻底重跑。</li>
      <li>想微调剧本？直接用文本编辑器修改 <code>game/scene/ch*.txt</code>，保存后点「预览」页的刷新即可。</li>
    </ul>
  </div>
</template>

<script lang="ts">
export default { name: "ExportPage" };
</script>
