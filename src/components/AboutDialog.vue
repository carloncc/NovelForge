<script setup lang="ts">
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const version = "0.1.0";
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <img src="/src/assets/logo.png" alt="NovelForge" />
        <div>
          <div class="m-title">NovelForge</div>
          <div class="m-sub">AI 视觉小说工坊 · v{{ version }}</div>
        </div>
      </div>
      <div class="modal-body">
        <p>导入小说，AI 全自动转换为可玩的视觉小说（WebGAL 项目），支持 PC / 手机 / 网页三端导出。</p>
        <p style="margin-top: 8px">
          开源协议：<a href="https://github.com/carloncc/NovelForge/blob/main/LICENSE" target="_blank">MIT</a>
          · 引擎致谢：<a href="https://github.com/OpenWebGAL/WebGAL" target="_blank">WebGAL</a>（MPL-2.0）
        </p>
        <p style="margin-top: 8px">
          项目主页：<a href="https://github.com/carloncc/NovelForge" target="_blank">github.com/carloncc/NovelForge</a>
        </p>
        <div style="margin-top: var(--space-4); text-align: right">
          <button class="btn secondary small" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>
