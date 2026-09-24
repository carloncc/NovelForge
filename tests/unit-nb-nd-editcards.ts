/**
 * nb-nD 1401/1408/1410（卡片编辑 UI 侧）回归单测：
 * - 1401 录音互斥纯函数 + EditCards.vue 接线静态断言
 * - 1408 浅 watch 加 deep 静态断言
 * - 1410 保存互斥纯函数 + 保存按钮 disabled/入口拦截静态断言
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldBlockCardSave, shouldBlockRecordingStart } from "../src/core/cards";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const VUE_PATH = join(process.cwd(), "src", "components", "EditCards.vue");

function testRecordingMutex(): void {
  assert(!shouldBlockRecordingStart({ recordingChar: null, hasRecorder: false, hasStream: false, hasTimer: false }), "空闲时应允许开始录音");
  assert(shouldBlockRecordingStart({ recordingChar: "alice", hasRecorder: false, hasStream: false, hasTimer: false }), "已有角色录音中应拦截");
  assert(shouldBlockRecordingStart({ recordingChar: null, hasRecorder: true, hasStream: false, hasTimer: false }), "残留 recorder 应拦截");
  assert(shouldBlockRecordingStart({ recordingChar: null, hasRecorder: false, hasStream: true, hasTimer: false }), "残留音频流应拦截");
  assert(shouldBlockRecordingStart({ recordingChar: null, hasRecorder: false, hasStream: false, hasTimer: true }), "残留计时器应拦截");
}

function testSaveMutex(): void {
  assert(!shouldBlockCardSave({ saving: false, recognizing: false, voiceBusy: false, castBusy: false, recording: false }), "全空闲时应允许保存");
  assert(shouldBlockCardSave({ saving: true, recognizing: false, voiceBusy: false, castBusy: false, recording: false }), "保存自身在途时应拦截重入");
  assert(shouldBlockCardSave({ saving: false, recognizing: true, voiceBusy: false, castBusy: false, recording: false }), "AI 识别在途时应拦截保存");
  assert(shouldBlockCardSave({ saving: false, recognizing: false, voiceBusy: true, castBusy: false, recording: false }), "音色克隆在途时应拦截保存");
  assert(shouldBlockCardSave({ saving: false, recognizing: false, voiceBusy: false, castBusy: true, recording: false }), "AI 选音色在途时应拦截保存");
  assert(shouldBlockCardSave({ saving: false, recognizing: false, voiceBusy: false, castBusy: false, recording: true }), "录音在途时应拦截保存");
}

function testVueWiring(): void {
  const src = readFileSync(VUE_PATH, "utf-8");
  // 1401：入口互斥 + 计时器防御 + 串卡停止拦截
  assert(src.includes("shouldBlockRecordingStart"), "EditCards 必须调用录音互斥守卫");
  assert(src.includes("已有录音在进行，请先停止或取消当前录音"), "EditCards 必须有录音互斥提示文案");
  assert(src.includes("当前正在录音的不是该角色，请先停止当前录音"), "停止克隆必须校验归属角色");
  // 1401：录音中禁用其他角色的录音按钮
  assert(src.includes("recordingChar !== null"), "其他角色的录音按钮必须在录音中禁用");
  // 1408：splice 原位替换可被感知
  assert(src.includes("{ deep: true }"), "props.cards 的 watch 必须加 deep（感知 splice 原位替换）");
  // 1410：保存按钮禁用态 + 入口二次拦截
  assert(src.includes("shouldBlockCardSave"), "EditCards 保存必须调用保存互斥守卫");
  assert(src.includes("有识别/克隆/选音色/录音任务在进行"), "EditCards 必须有保存互斥提示文案");
  assert(
    src.includes(":disabled=\"busy || charRecognizing !== null || voiceBusy !== null || castBusy || recordingChar !== null\""),
    "保存按钮 disabled 必须覆盖识别/克隆/选音色/录音四态",
  );
}

async function main(): Promise<void> {
  testRecordingMutex();
  testSaveMutex();
  testVueWiring();
  console.log("=== nb-nD editcards (1401/1408/1410) unit tests passed ===");
}

main().catch((error) => {
  console.error("nb-nD editcards unit tests failed:", error);
  process.exit(1);
});
