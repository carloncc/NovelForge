/**
 * 前端运行时修复回归（2026-10-13 核查报告 F1 / F3 / F5 / F6 / F7 / F9 / F10）。
 *
 * 本仓库没有 jsdom/vitest 渲染环境（单测都是纯 Node + tsx），而 .vue 文件不能被 tsx import。
 * 因此分两层覆盖：
 *
 *   1) 纯算法层：同步判定的纯函数已抽到 `src/components/editCardsSync.ts`，测试**直接 import
 *      真实实现**跑行为用例（不再用"同名镜像副本"——镜像会漂移，且漂移本身没有门禁能发现）。
 *   2) 接线层：emit 前先同步基线、视频轨是否真的被持有并停止、轨道 ended 是否接管状态、
 *      弹层 role/aria-modal/焦点陷阱、语言下拉 aria-label 等——用源码断言锁住，
 *      因为这类改动删一行就静默退化、且没有任何运行时报错。
 *
 * 教训（2026-10-14）：`vue-tsc --noEmit` 与单测**都不编译 .vue**，所以
 * 「`<script setup>` 里 export」这类错误能在测试全绿的情况下溜到 dev server。
 * 门禁已补上 `pnpm build`（vite build 会真正编译 SFC）。
 *
 * webRuntime / i18n 是 .ts，直接 import 真模块（runExclusive 单测 + 导出面断言）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { ExtractionResult } from "../src/core/types";
import { cardSignature, cardsSignature, cardsSyncDecision } from "../src/components/editCardsSync";
import { detachSystemAudioTrack, shouldEndRecordingOnTrackEnded } from "../src/components/editCardsRecording";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf-8");
const EDIT_CARDS = "src/components/EditCards.vue";
/** 同步判定的纯函数模块（2026-10-14 从 EditCards.vue 抽出：script setup 不允许 export） */
const SYNC_MODULE = "src/components/editCardsSync.ts";
/** 去掉注释行后的源码：静态断言不能靠注释里的说明"蒙对" */
const codeOf = (rel: string): string =>
  read(rel)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

/* ==================== F1 + F10：签名判定 ====================
 * 真实实现来自 `src/components/editCardsSync.ts`（顶部 import）。
 * 2026-10-14：这三个纯函数原先写在 EditCards.vue 的 `<script setup>` 里，测试只能用"同名镜像"
 * 复刻逻辑；但 `<script setup>` 里 `export` 是**非法**的（dev server / vite build 直接报错），
 * 于是把它们抽成 .ts 模块 —— 组件与测试 import 同一份实现，镜像漂移问题从根上消失。 */

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "alice", name: "爱丽丝", appearance: "银发", ...over };
}

function result(characters: Record<string, unknown>[], over: Partial<ExtractionResult> = {}): ExtractionResult {
  return { title: "t", characters, scenes: [], items: [], ...over } as unknown as ExtractionResult;
}

function testSignatureIgnoresBase64(): void {
  // 参考图内容（base64）绝不进签名：否则每次 watch 都要对几 MB 字符串做 stringify（F10）
  const big = "A".repeat(50_000);
  const a = cardSignature(card({ referenceImage: big }));
  const b = cardSignature(card({ referenceImage: "A".repeat(50_000) }));
  assert(a === b, "相同长度的参考图签名必须一致");
  assert(!a.includes(big.slice(0, 100)), "签名里绝不能包含 base64 内容（只允许长度）");
  assert(a !== cardSignature(card({ referenceImage: "A".repeat(50_001) })), "参考图被换成不同内容必须能被发现");
  assert(cardSignature(card()) !== a, "清除参考图必须能被发现");
  // 非 base64 字段仍参与签名
  assert(cardSignature(card({ appearance: "黑发" })) !== cardSignature(card()), "普通字段变化必须进签名");
  assert(
    cardSignature(card({ costumes: [{ id: "c1", prompt: "x" }] })) !== cardSignature(card({ costumes: [{ id: "c1", prompt: "y" }] })),
    "服装提示词变化必须进签名",
  );
  // 卡片增删必须进整份签名
  assert(cardsSignature(result([card()])) !== cardsSignature(result([card(), card({ id: "bob" })])), "卡片数量变化必须进签名");
}

function testSaveDoesNotWarn(): void {
  // cardsSignature / cardsSyncDecision 均来自 src/components/editCardsSync.ts（顶部 import 的真实实现）
  // 1) 打开面板：基线 = 当前 props 的签名
  const props1 = result([card({ imagePrompt: "old" })]);
  let baseline = cardsSignature(props1);
  const local = { ...props1, characters: [{ ...props1.characters[0], imagePrompt: "new" }] } as ExtractionResult;

  // 2) 用户改了字段 → watcher 触发：本地与基线不同 = 有未保存编辑（保持原有提示行为）
  assert(cardsSyncDecision(props1, local, baseline).action === "conflict", "用户改动后 watcher 必须判定为有未保存编辑");

  // 3) 点「保存卡片」：save() 先 markSynced() 再 emit("saved", local)
  baseline = cardsSignature(local);
  // 4) 父组件把 props.cards 换成等价新对象（stores/generate: lastResult.cards = cards）
  const props2 = JSON.parse(JSON.stringify(local)) as ExtractionResult;
  assert(
    cardsSyncDecision(props2, local, baseline).action === "sync",
    "保存后父组件的等价回写必须判为 sync —— 判为 conflict 就会用红色 err 覆盖掉「已保存」（F1 假警告）",
  );

  // 5) 保存之后再重新生成：本地已无未保存编辑（基线 == local），必须静默同步新结果
  assert(
    cardsSyncDecision(result([card({ imagePrompt: "regenerated" })]), local, baseline).action === "sync",
    "保存后（无未保存编辑）外部新结果必须同步进面板，不能因基线已对齐而静默丢弃",
  );

  // 6) 用户又改了但没保存时，外部变更必须走 conflict：保留本地编辑（原有行为不得削弱）
  const dirtyLocal = { ...local, characters: [{ ...local.characters[0], imagePrompt: "local-edit-2" }] } as ExtractionResult;
  assert(
    cardsSyncDecision(result([card({ imagePrompt: "regenerated" })]), dirtyLocal, baseline).action === "conflict",
    "有未保存编辑时外部变更必须保留本地编辑并提示冲突",
  );

  // 7) 旧实现的误报条件必须被这条用例覆盖：旧基线（挂载时快照）与保存后的内容**不同**，
  //    旧实现拿它当判据 → 必然走 err 分支覆盖「已保存」。这里把这个条件钉住：
  //    只要将来有人把基线改回"挂载时快照"，第 4 步的 sync 断言就会失败。
  const staleBaseline = cardsSignature(props1);
  assert(staleBaseline !== cardsSignature(local), "旧基线必须与保存后的内容不同（这正是 F1 误报的触发条件）");
  assert(
    cardsSyncDecision(props2, local, baseline).action === "sync",
    "保存后的等价回写必须 sync（基线已对齐）",
  );
}

/** EditCards 的接线断言：保证镜像测的逻辑与组件里真正跑的逻辑一致 */
function testEditCardsWiring(): void {
  const src = codeOf(EDIT_CARDS);
  // F1：基线用签名、保存后同步基线、emit 顺序
  assert(src.includes("lastSyncedSig"), "基线必须用签名而不是整份 JSON 快照");
  assert(src.includes("cardsSignature(props.cards)"), "基线必须由 cardsSignature 计算");
  assert(src.includes("cardsSyncDecision(props.cards, local.value, lastSyncedSig)"), "watcher 必须走 cardsSyncDecision");
  const saveBody = src.slice(src.indexOf("async function save()"));
  const markAt = saveBody.indexOf("markSynced()");
  const emitAt = saveBody.indexOf('emit("saved"');
  assert(markAt >= 0, "save() 必须调用 markSynced() 同步基线");
  assert(emitAt > markAt, "save() 里 markSynced() 必须位于 emit(\"saved\") 之前（顺序反了假警告就会回来）");
  assert(src.includes("卡片有未保存的修改"), "冲突提示文案必须保留（不得削弱原有行为）");
  assert(src.includes("{ deep: true }"), "props.cards 的 watch 仍需 deep（感知 splice 原位替换，#1408）");
  assert(src.includes("local.value = shallowCopyCards(props.cards)"), "同步分支必须走浅拷贝刷新本地副本");
  // F10：深拷贝与整份 stringify 必须消失
  assert(!src.includes("JSON.parse(JSON.stringify(props.cards))"), "不得再深拷贝整份卡片（含内联 base64）");
  assert(!/JSON\.stringify\(local\.value\)/.test(src), "不得再对本地整份卡片做 stringify");
  assert(src.includes("referenceImage"), "签名必须显式处理参考图字段（只记长度）");
  // 参考图签名的实现已抽到 SYNC_MODULE（组件 import 它），断言改读该模块
  assert(
    codeOf(SYNC_MODULE).includes("typeof value === \"string\" ? `b64:${value.length}` : \"none\""),
    "参考图签名必须只记长度",
  );
  // reset 也要对齐基线，否则下一次父组件回写会被误判为冲突
  const resetBody = src.slice(src.indexOf("async function reset()"));
  assert(resetBody.slice(0, 400).includes("markSynced()"), "「放弃修改」后必须对齐基线");
}

/* ==================== F3：屏幕采集的视频轨必须被停止 ==================== */

interface FakeTrack extends MediaStreamTrack {
  stopped: boolean;
}

function fakeTrack(kind: "audio" | "video"): FakeTrack {
  const listeners = new Set<() => void>();
  const track = {
    kind,
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type: string, handler: () => void) { if (type === "ended") listeners.add(handler); },
    removeEventListener(type: string, handler: () => void) { if (type === "ended") listeners.delete(handler); },
    fireEnded() { for (const h of listeners) h(); },
  };
  return track as unknown as FakeTrack;
}

/** 最小 MediaStream fake：只需 getAudioTracks/getVideoTracks/getTracks */
function fakeStream(tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream;
}

/** Node 里没有 MediaStream 全局：被测逻辑会 new MediaStream([audioTrack])，必须补一个构造器 */
function installMediaStreamGlobal(): void {
  const g = globalThis as unknown as { MediaStream?: unknown };
  if (g.MediaStream) return;
  g.MediaStream = class {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) { this.tracks = tracks; }
    getTracks(): FakeTrack[] { return this.tracks; }
    getAudioTracks(): FakeTrack[] { return this.tracks.filter((t) => t.kind === "audio"); }
    getVideoTracks(): FakeTrack[] { return this.tracks.filter((t) => t.kind === "video"); }
  };
}

/* detachSystemAudioTrack / shouldEndRecordingOnTrackEnded 直接来自
 * src/components/editCardsRecording.ts（顶部 import 的真实实现）。 */

function testVideoTrackStops(): void {
  installMediaStreamGlobal();
  // 旧实现只把 audio 轨装进 recordStreamRef，原始流（含视频轨）无人持有 → 视频轨永不停止，
  // 屏幕一直在被采集、浏览器「正在共享屏幕」指示不消失。
  const audio = fakeTrack("audio");
  const video = fakeTrack("video");
  const { audioOnly, videoTrack } = detachSystemAudioTrack(fakeStream([video, audio]));
  assert(video.stopped, "拿到音频轨后必须立刻停止视频轨（否则屏幕持续被采集）");
  assert(!audio.stopped, "音频轨必须保留（录音靠它）");
  assert(audioOnly.getVideoTracks().length === 0, "录音用的流里不得包含视频轨");
  assert(audioOnly.getAudioTracks().length === 1, "录音用的流必须包含音频轨");
  assert(videoTrack === video, "必须把视频轨交回调用方（用于挂 ended 监听）");

  // 组件接线：原始流要留引用、停止入口要停全部轨道、要监听 ended
  const src = codeOf(EDIT_CARDS);
  assert(src.includes("const recordSourceStreamRef = ref<MediaStream | null>(null)"), "必须单独持有 getDisplayMedia 的原始流（含视频轨）");
  assert(src.includes("detachSystemAudioTrack(stream)"), "必须走 detachSystemAudioTrack 取音频轨并停视频轨");
  assert(src.includes("recordSourceStreamRef.value = stream"), "原始流必须被引用（否则视频轨无人可停）");
  assert(/stopAllTracks\(recordSourceStreamRef\.value\)/.test(src), "stopRecordingNow 必须停原始流的全部轨道");
  assert(/stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/.test(src), "stopAllTracks 必须停流内全部轨道（video + audio）");
  assert(src.includes("videoTrack?.addEventListener(\"ended\", onRecordTrackEnded)"), "必须监听视频轨 ended（系统侧停止共享）");
  assert(src.includes("function onRecordTrackEnded()"), "必须处理系统侧结束共享");
  assert(src.includes("系统共享已结束"), "系统结束共享后必须给用户明确提示");
  // 卸载路径必须仍在（stopRecordingNow 会被调用）
  assert(src.slice(src.indexOf("onBeforeUnmount(")).includes("stopRecordingNow()"), "onBeforeUnmount 必须调用 stopRecordingNow 释放全部轨道");
}

/**
 * 回归：`MediaStreamTrack.stop()` 会**同步派发 ended**，而 detachSystemAudioTrack 在录音真正
 * 开始前就停掉视频轨。如果 ended 处理只看 recordingChar（录音开始时就已赋值），这条 ended
 * 会立刻停掉计时器与录音 → 每次录音都秒停在 0 秒（"录音时长不足 0s"）。
 * 判据必须是 recorder 已进入 recording。
 */
function testTrackEndedGate(): void {
  const gate = shouldEndRecordingOnTrackEnded; // 真实实现（src/components/editCardsRecording.ts）
  assert(!gate({ recordingChar: null, recorderState: null }), "空闲时不得响应轨道 ended");
  assert(
    !gate({ recordingChar: "alice", recorderState: "inactive" }),
    "recorder 尚未真正录制时（正是 detachSystemAudioTrack 停视频轨那一刻）必须忽略 ended",
  );
  assert(!gate({ recordingChar: "alice", recorderState: null }), "recorder 不存在时必须忽略 ended");
  assert(gate({ recordingChar: "alice", recorderState: "recording" }), "真正录音中收到 ended 才应结束录音状态");

  const src = codeOf(EDIT_CARDS);
  assert(src.includes("shouldEndRecordingOnTrackEnded"), "组件必须用该判据过滤 ended（否则录音会秒停）");
  assert(
    /shouldEndRecordingOnTrackEnded\(\{ recordingChar: recordingChar\.value, recorderState: recorderRef\.value\?\.state \?\? null \}\)/.test(src),
    "ended 处理必须传入 recorder 真实状态",
  );
}

/* ==================== F9：模板路径 in-flight 去重 ==================== */

async function testRunExclusive(): Promise<void> {
  const { runExclusive } = await import("../src/utils/webRuntime");
  const inflight = new Map<string, Promise<string>>();
  let calls = 0;
  const task = async (): Promise<string> => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return "value";
  };
  // 同一 key 并发两次：任务只跑一次，两个调用拿到同一个 Promise
  const p1 = runExclusive(inflight, "/app/template/game/a.css", task);
  const p2 = runExclusive(inflight, "/app/template/game/a.css", task);
  assert(p1 === p2, "同一路径并发必须复用同一个 in-flight Promise");
  assert((await p1) === "value" && (await p2) === "value", "复用方必须拿到同样的结果");
  assert(calls === 1, `同一路径并发只应触发 1 次拉取，实际 ${calls} 次`);
  assert(inflight.size === 0, "任务结束后必须从表里删除（否则失败会被永久缓存）");

  // 不同 key 互不影响
  await Promise.all([runExclusive(inflight, "k1", task), runExclusive(inflight, "k2", task)]);
  // 经一个显式 number 变量读一次：上面 `assert(calls === 1)` 已把 calls 收窄成字面量 1，
  // 而 calls++ 发生在闭包里、TS 不会因此重置收窄 —— 直接写 `calls === 3` 会误报 TS2367
  // （CI 的 `pnpm typecheck:tests` 会因此变红）。
  const afterParallel: number = calls;
  assert(afterParallel === 3, `不同路径必须各自拉取，实际 ${afterParallel} 次`);

  // 失败也必须结算并清表：否则用户修好问题后重试仍拿到同一个 rejected Promise
  let failCalls = 0;
  const failing = async (): Promise<string> => {
    failCalls++;
    throw new Error("boom");
  };
  await runExclusive(inflight, "bad", failing).catch(() => undefined);
  assert(inflight.size === 0, "失败的任务也必须从表里删除");
  await runExclusive(inflight, "bad", failing).catch(() => undefined);
  assert(failCalls === 2, "清表后重试必须重新执行任务（失败不得被永久缓存）");

  const webSrc = codeOf("src/utils/webRuntime.ts");
  assert(webSrc.includes("templateInflight"), "ensureTemplateLocal 必须有 in-flight 表");
  assert(/runExclusive\(templateInflight, normalized/.test(webSrc), "ensureTemplateLocal 必须用归一化路径做 key");
  assert(/if \(await vfs\.vfsExists\(normalized\)\) return;/.test(webSrc), "缓存命中判定必须在临界区内（并发时只有第一个真去拉）");
}

/* ==================== F5：全仓不得再有原生阻塞弹层 ==================== */

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if ([".ts", ".vue"].includes(extname(e.name))) out.push(p);
  }
  return out;
}

function testNoNativeDialogs(): void {
  const hits: string[] = [];
  const files = walkSrc(join(process.cwd(), "src"));
  assert(files.length > 100, `全仓扫描应覆盖 100+ 文件，实际 ${files.length}（扫描逻辑可能失效）`);
  for (const f of files) {
    readFileSync(f, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/window\.(confirm|prompt|alert)\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
      });
  }
  assert(hits.length === 0, `仍有原生阻塞弹层调用：\n  ${hits.join("\n  ")}`);

  // 被替换的 5 处必须真的走应用内弹层，且提示文案保留
  const wb = codeOf("src/components/generate/ChapterWorkbench.vue");
  const sp = codeOf("src/components/generate/result/ScriptPanel.vue");
  for (const [name, src] of [["ChapterWorkbench.vue", wb], ["ScriptPanel.vue", sp]] as const) {
    assert(src.includes("confirmDialog"), `${name} 必须改用应用内弹层 confirmDialog`);
  }
  assert(/选中的均为停用章/.test(wb), "ChapterWorkbench 的停用章提示必须保留");
  assert((wb.match(/confirmDialog\(/g) ?? []).length >= 3, "ChapterWorkbench 两处停用章提示 + 原有聚合确认都要走弹层");
  assert(sp.includes("打开文件夹失败"), "ScriptPanel 的打开文件夹失败提示必须保留");
  assert(sp.includes("网页版无法直接打开本地文件夹，路径已复制"), "ScriptPanel 的路径已复制提示必须保留");
  assert(sp.includes("网页版无法直接打开本地文件夹，请手动打开"), "ScriptPanel 的手动打开提示必须保留");
  assert((sp.match(/confirmDialog\(/g) ?? []).length >= 4, "ScriptPanel 三处提示 + 原有清空意见确认都要走弹层");
}

/* ==================== F6 + F7：对话框语义 / 语言下拉可访问名称 ==================== */

function testDialogSemanticsAndLangLabel(): void {
  for (const rel of ["src/components/AboutDialog.vue", "src/components/AssetPreview.vue"]) {
    const src = codeOf(rel);
    assert(/^\s*role="dialog"$/m.test(src), `${rel} 必须有 role="dialog"`);
    assert(/^\s*aria-modal="true"$/m.test(src), `${rel} 必须标记 aria-modal`);
    assert(src.includes(":aria-labelledby"), `${rel} 必须关联可访问名称`);
    assert(src.includes('tabindex="-1"'), `${rel} 的容器必须可聚焦`);
    assert(src.includes("focusables"), `${rel} 必须有焦点陷阱`);
    assert(src.includes("lastFocused"), `${rel} 必须记录触发元素并归还焦点`);
    assert(/e\.shiftKey/.test(src), `${rel} 焦点陷阱必须处理 Shift+Tab`);
    assert(/lastFocused\?\.focus/.test(src), `${rel} 关闭/卸载后必须归还焦点`);
    assert(src.includes("maskEl"), `${rel} 必须持有弹层容器引用`);
  }
  const app = codeOf("src/App.vue");
  const langLine = app.split("\n").find((l) => l.includes("lang-select")) ?? "";
  assert(langLine.includes("aria-label"), "语言下拉必须带 aria-label（此前无可访问名称）");
  assert(/t\(['"]界面语言['"]\)/.test(langLine), "语言下拉文案必须走词典键 t('界面语言')");
  // 四语词典必须有该键（否则 en/ja/ko 会显示中文原文）
  for (const lang of ["en", "ja", "ko", "zh-TW"]) {
    assert(read(`src/i18n/${lang}.ts`).includes('"界面语言"'), `${lang} 词典缺少「界面语言」`);
  }
  // 录音结束提示的四语条目（F3 新增的唯一文案键）
  for (const lang of ["en", "ja", "ko", "zh-TW"]) {
    assert(read(`src/i18n/${lang}.ts`).includes('"系统共享已结束（录音已停止计时）'), `${lang} 词典缺少录音结束提示`);
  }
}

/* ==================== F10：Web 版明文密钥槽位已删除 ==================== */

async function testPlaintextSecretPathGone(): Promise<void> {
  const webSrc = codeOf("src/utils/webRuntime.ts");
  assert(!webSrc.includes("webReadApiSecrets"), "webRuntime 不得再有明文密钥读入口");
  assert(!webSrc.includes("webWriteApiSecrets"), "webRuntime 不得再有明文密钥写入口");
  assert(!webSrc.includes("novelforge:api-secrets"), "webRuntime 不得再引用旧明文槽位");
  const tauriSrc = codeOf("src/utils/tauri.ts");
  assert(
    /isWebRuntime\(\)\) \{\s*\n\s*return Promise\.reject\(new Error\("Web 版不支持持久化 API Key/.test(tauriSrc),
    "Web 分支必须显式抛错而不是静默退化到明文槽位",
  );
  // 真实导出面也确认不存在（静态断言可能被字符串拼接绕过）
  const web = await import("../src/utils/webRuntime");
  const keys = Object.keys(web);
  assert(!keys.includes("webReadApiSecrets"), "webRuntime 仍导出 webReadApiSecrets");
  assert(!keys.includes("webWriteApiSecrets"), "webRuntime 仍导出 webWriteApiSecrets");
  assert(keys.includes("runExclusive"), "runExclusive 必须导出（in-flight 去重的可测入口）");
}

async function main(): Promise<void> {
  testSignatureIgnoresBase64();
  testSaveDoesNotWarn();
  testEditCardsWiring();
  testVideoTrackStops();
  testTrackEndedGate();
  await testRunExclusive();
  testNoNativeDialogs();
  testDialogSemanticsAndLangLabel();
  await testPlaintextSecretPathGone();
  console.log("=== 前端运行时修复（F1/F3/F5/F6/F7/F9/F10）回归测试通过 ===");
}

main().catch((error) => {
  console.error("unit-fix-frontend failed:", error);
  process.exit(1);
});
