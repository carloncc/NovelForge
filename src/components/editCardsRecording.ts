/**
 * 录音（系统声音克隆）相关的纯函数（从 EditCards.vue 抽出，2026-10-14）。
 *
 * 抽出的原因与 editCardsSync.ts 相同：它们原先写在 `<script setup>` 里并被 `export`，
 * 而 **`<script setup>` 不允许 ES module 导出**（dev server / `vite build` 直接报错），
 * 且 `vue-tsc` 与单测都不编译 .vue，所以这个错误能一路溜到开发者的屏幕上。
 * 抽成 .ts 后组件与单测 import 同一份实现，测试不再依赖"同名镜像副本"。
 */

/**
 * 从 getDisplayMedia 的原始流里取出音频轨，并立刻停掉视频轨（F3）。
 *
 * 为什么单独抽成函数：原实现的注释写着「只要音频轨；视频轨仅供满足捕获要求，立即停止」，
 * 但代码只把 audio 轨装进 MediaStream 存进 recordStreamRef，原始 stream（含视频轨）此后
 * 没有任何引用——视频轨永远不会被 stop，屏幕采集一直持续到组件卸载，浏览器的
 * 「正在共享屏幕」指示不消失。这里做成纯函数以便用 mock 流做单测。
 */
export function detachSystemAudioTrack(stream: MediaStream): { audioOnly: MediaStream; videoTrack: MediaStreamTrack | null } {
  const audioTrack = stream.getAudioTracks()[0];
  // 先停视频轨再返回：调用方（startSystemAudioRecording）拿到 audioOnly 时，
  // 屏幕采集已经结束，不需要再记着"稍后停"
  const videoTrack = stream.getVideoTracks()[0] ?? null;
  stream.getVideoTracks().forEach((track) => track.stop());
  return { audioOnly: new MediaStream([audioTrack]), videoTrack };
}

/**
 * 系统侧结束共享（用户点系统/浏览器的「停止共享」，或共享的窗口被关闭）→ 同步结束录音状态。
 *  F3：此前没有这条路径，音视频轨 ended 后界面仍显示"正在录音"、计时器一直加，
 *  用户只能自己点「取消」。
 *
 *  这里**故意不动 recorderRef / recordingChar**：MediaRecorder 仍持有已录分片，
 *  保留"录音中"的按钮组，用户才能点「停止并克隆」把已录到的音频用掉（或点「取消」丢弃）。
 *  若在这里就把状态复位，按钮组会消失、已录分片无人消费。只停表 + 明确告知。
 *
 *  必须有 `recorder.state === "recording"` 这道门（而不是只判断 recordingChar）：
 *  `MediaStreamTrack.stop()` 会**同步派发 ended**，而 detachSystemAudioTrack 在录音真正
 *  开始前就停掉视频轨——只看 recordingChar 的话，这条 ended 会立刻停掉计时器与录音，
 *  于是每次录音都秒停在 0 秒（表现为"录音时长不足 0s"）。recorder 已进入 recording 才说明
 *  采集真的在进行，此时 ended 才是用户侧结束共享。
 */
export function shouldEndRecordingOnTrackEnded(args: { recordingChar: string | null; recorderState: string | null }): boolean {
  if (args.recordingChar === null) return false;
  return args.recorderState === "recording";
}
