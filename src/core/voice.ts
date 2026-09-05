import type { ChapterScript, CharacterCard, PipelineEvent, ApiConfig, FailedTask } from "./types";
import { ttsSpeech } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { cacheDirFor, cacheHit } from "./cache";
import { sceneVocalKey } from "./render";
import { ttsConfigById, voiceLibraryFor, voiceProfileById } from "../stores/config";
import { log as logger } from "../utils/logger";
import { readAssetMap, updateAssetMap } from "./assetMap";

export interface VoiceJob {
  key: string;
  file: string;
  text: string;
  voice: string;
  charId: string;
  ttsConfigId?: string;
  cloned: boolean;
  /** 每句语速（0.5-2），来自剧本标注；缺省用全局配置 */
  speed?: number;
  /** 每句配音情绪，来自剧本标注；缺省用全局配置 */
  ttsEmotion?: string;
}

/* ===== MiniMax TTS 限速：RPM（每分钟请求数）极低（免费 10 / 充值 20），
   必须串行化 + 最小请求间隔，否则立即触发 code 1002 rate limit。===== */

/** 两次 MiniMax 请求的最小间隔（ms）。20 RPM ≈ 每 3s 一个；取 2.2s 留并发余量，
   免费用户（10 RPM）会触发 1002 后由退避重试自动降速。 */
const MINIMAX_TTS_MIN_INTERVAL_MS = 2200;

let minimaxTtsLastRequestAt = 0;
let minimaxTtsChain = Promise.resolve();

/** 排队执行一个 MiniMax TTS 请求：全局串行 + 保持最小间隔。返回首个 Promise 的 settled 值。 */
function minimaxTtsThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const now = Date.now();
    const wait = Math.max(0, minimaxTtsLastRequestAt + MINIMAX_TTS_MIN_INTERVAL_MS - now);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    minimaxTtsLastRequestAt = Date.now();
    return fn();
  };
  const next = minimaxTtsChain.then(run, run);
  minimaxTtsChain = next.then(() => undefined, () => undefined);
  return next;
}

/** 判断是否 MiniMax 限流错误（code 1002 / rate limit） */
export function isRateLimitError(message: string): boolean {
  return /1002|rate\s*limit|RPM|限流/.test(message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** FNV-1a 32bit 摘要（文件命名用，非加密） */
function fnv1a(parts: (string | number | undefined)[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    const s = String(part ?? "");
    for (const c of s) {
      hash ^= c.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

function voiceFingerprint(voice: string, configId?: string): string {
  return fnv1a([`${configId ?? "default"}:${voice}`]);
}

/** 配音文件名按「位置 key + 音色 + 文本 + 语速 + 情绪」内容寻址。
 * 之前只按 key+音色命名：剧本改文字后 key 不变，旧 mp3 被缓存命中，
 * 游戏里显示新台词、放出来却是旧语音。文本/参数任一变化都会落新文件，旧音频自然作废。 */
function voiceFileName(
  key: string,
  voice: string,
  ttsConfigId: string | undefined,
  text: string,
  speed?: number,
  ttsEmotion?: string,
): string {
  return `v_${key}_${voiceFingerprint(voice, ttsConfigId)}_${fnv1a([text, speed, ttsEmotion])}.mp3`;
}

/** 按当前剧本算出全部配音 key（与 buildVoiceJobs 的 key 公式同源，供映射剪枝用） */
export function vocalKeysForChapters(chapters: ChapterScript[]): string[] {
  const keys: string[] = [];
  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      scene.lines.forEach((_, i) => keys.push(sceneVocalKey(chapter.chapter, scene.id, i)));
      (scene.choices || []).forEach((choice, b) => {
        choice.lines.forEach((_, j) =>
          keys.push(sceneVocalKey(chapter.chapter, scene.id, scene.lines.length + 1000 * (b + 1) + j)));
      });
    }
  }
  return keys;
}

export function buildVoiceJobs(  cfg: ApiConfig,
  chapters: ChapterScript[],
  characters: CharacterCard[],
  chapterIndexes?: Set<number>,
): VoiceJob[] {
  const library = voiceLibraryFor(cfg);
  const fallbackVoice = library[0] || "default";
  const charById = new Map(characters.map((c) => [c.id, c]));
  const voiceName = (charId: string): { voice: string; ttsConfigId?: string; cloned: boolean } => {
    const char = charById.get(charId);
    const profile = voiceProfileById(char?.voiceProfileId);
    if (profile) return { voice: profile.voiceId, ttsConfigId: profile.ttsConfigId, cloned: true };
    const v = char?.voiceName || char?.id || "default";
    return { voice: library.includes(v) ? v : fallbackVoice, cloned: false };
  };
  const jobs: VoiceJob[] = [];
  for (const chapter of chapters) {
    // 分章节生成：只处理选中的章节（chapter 字段为 0-based 连续索引）
    if (chapterIndexes && !chapterIndexes.has(chapter.chapter)) continue;
    for (const scene of chapter.scenes) {
      // 主流程台词：对话按角色音色，旁白/独白按默认音色（fallbackVoice）配音，避免整段静默导致 auto/快进体感断层
      scene.lines.forEach((line, i) => {
        const key = sceneVocalKey(chapter.chapter, scene.id, i);
        const text = line.text.slice(0, 500);
        if (line.type === "dialogue") {
          const selected = voiceName(line.characterId);
          const speed = typeof line.speed === "number" ? line.speed : undefined;
          const ttsEmotion = typeof line.ttsEmotion === "string" && line.ttsEmotion ? line.ttsEmotion : undefined;
          jobs.push({
            key,
            file: voiceFileName(key, selected.voice, selected.ttsConfigId, text, speed, ttsEmotion),
            text,
            voice: selected.voice,
            charId: line.characterId,
            ttsConfigId: selected.ttsConfigId,
            cloned: selected.cloned,
            speed,
            ttsEmotion,
          });
        } else {
          // 旁白/独白：超长先截断 500 字（与对话一致），过长句由 lint 告警建议拆句
          // NarrationLine 无 speed/ttsEmotion 标注，用全局 TTS 默认值
          if (line.text.length > 200) {
            logger.info("voice", "旁白超长（快进易截断，建议拆句）", { key, len: line.text.length });
          }
          jobs.push({
            key,
            file: voiceFileName(key, fallbackVoice, undefined, text),
            text,
            voice: fallbackVoice,
            charId: "narrator",
            ttsConfigId: undefined,
            cloned: false,
            speed: undefined,
            ttsEmotion: undefined,
          });
        }
      });
      // 分支选择台词（与渲染层的序号公式一致）：对话与旁白同样处理
      (scene.choices || []).forEach((choice, b) => {
        choice.lines.forEach((line, j) => {
          const key = sceneVocalKey(chapter.chapter, scene.id, scene.lines.length + 1000 * (b + 1) + j);
          const text = line.text.slice(0, 500);
          if (line.type === "dialogue") {
            const selected = voiceName(line.characterId);
            const speed = typeof line.speed === "number" ? line.speed : undefined;
            const ttsEmotion = typeof line.ttsEmotion === "string" && line.ttsEmotion ? line.ttsEmotion : undefined;
            jobs.push({
              key,
              file: voiceFileName(key, selected.voice, selected.ttsConfigId, text, speed, ttsEmotion),
              text,
              voice: selected.voice,
              charId: line.characterId,
              ttsConfigId: selected.ttsConfigId,
              cloned: selected.cloned,
              speed,
              ttsEmotion,
            });
          } else {
            jobs.push({
              key,
              file: voiceFileName(key, fallbackVoice, undefined, text),
              text,
              voice: fallbackVoice,
              charId: "narrator",
              ttsConfigId: undefined,
              cloned: false,
              speed: undefined,
              ttsEmotion: undefined,
            });
          }
        });
      });
    }
  }
  return jobs;
}

/** 执行单个配音任务（管线批处理与单句重配共用） */
export async function runVoiceJob(
  cfg: ApiConfig,
  job: VoiceJob,
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  force = false,
): Promise<string | null> {
  const cacheDir = cacheDirFor(cacheRoot, "vocal");
  await tauri.mkdirAll(cacheDir);
  const jobConfig = job.ttsConfigId ? ttsConfigById(job.ttsConfigId) : cfg;
  if (!jobConfig) throw new Error(`声音 ${job.voice} 绑定的 TTS 配置不存在`);
  const library = voiceLibraryFor(jobConfig);
  const fallbackVoice = library[0] || "default";
  if (!force) {
    const cached = await cacheHit(cacheDir, job.file);
    if (cached) return cached;
  }
  log({ step: "配音", message: `配音中：${job.voice} 「${job.text.slice(0, 20)}…」`, level: "info", at: Date.now() });
  const isMiniMax = jobConfig.adapter === "minimax-tts" || /minimaxi?\.com/i.test(jobConfig.baseUrl);
  const speak = async (voice: string): Promise<string> => {
    // MiniMax 单次合成受 RPM 限制（免费 10 / 充值 20）：全局串行 + 最小间隔，避免并发打爆限流。
    // 其他 TTS 服务（OpenAI / 硅基流动等）不限速，保持并发。
    const res = isMiniMax
      ? await minimaxTtsThrottle(() => ttsSpeech(jobConfig, job.text, voice, 120, { speed: job.speed, ttsEmotion: job.ttsEmotion }))
      : await ttsSpeech(jobConfig, job.text, voice, 120, { speed: job.speed, ttsEmotion: job.ttsEmotion });
    const ext = res.mime.includes("ogg") ? "ogg" : res.mime.includes("opus") ? "opus" : res.mime.includes("wav") ? "wav" : res.mime.includes("flac") ? "flac" : "mp3";
    const file = job.file.replace(/\.mp3$/, `.${ext}`);
    const path = `${cacheDir}/${file}`;
    await tauri.writeFileBase64(path, res.dataB64);
    return path;
  };
  // 限流重试：1002 / rate limit 时等待退避后重试（最多 4 次，避免一次撞限就把整句跳过）
  const speakWithRetry = async (voice: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const backoff = 8000 + attempt * 5000;
        log({ step: "配音", message: `检测到限流，${backoff / 1000}s 后重试（第 ${attempt} 次）`, level: "warn", at: Date.now() });
        await sleep(backoff);
      }
      try {
        return await speak(voice);
      } catch (e) {
        lastError = e;
        if (!isRateLimitError(errMsg(e))) throw e;
        // 继续下一轮重试
      }
    }
    throw lastError;
  };
  try {
    return await speakWithRetry(job.voice);
  } catch (e) {
    if (!job.cloned && job.voice !== fallbackVoice) {
      log({
        step: "配音",
        message: `音色 ${job.voice} 失败，回退默认音色重试：${errMsg(e).slice(0, 100)}`,
        level: "warn",
        at: Date.now(),
      });
      try {
        return await speakWithRetry(fallbackVoice);
      } catch {
        /* 仍失败则跳过 */
      }
    }
    log({
      step: "配音",
      message: `配音失败（跳过）：${errMsg(e).slice(0, 120)}`,
      level: "warn",
      at: Date.now(),
    });
    return null;
  }
}

export async function generateVoice(
  cfg: ApiConfig,
  chapters: ChapterScript[],
  characters: CharacterCard[],
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  concurrency = 3,
  force = false,
  isAborted?: () => boolean,
  chapterIndexes?: Set<number>,
): Promise<{ vocal: Record<string, string>; failed: FailedTask[]; chars: number }> {
  const vocal: Record<string, string> = {};
  const failed: FailedTask[] = [];
  await tauri.mkdirAll(cacheDirFor(cacheRoot, "vocal"));
  logger.info("voice", "开始生成配音", { characters: characters.length, concurrency, force, chapterScope: chapterIndexes ? chapterIndexes.size : "all" });

  const jobs = buildVoiceJobs(cfg, chapters, characters, chapterIndexes);
  // 静默预分区：缓存命中的句子直接记入结果，不走合成/进度链路。
  // 解决"点一次配音重配，全书 N 句挨个走一遍进度"——命中只是本地文件存在性检查，不产生 TTS 调用。
  // force（整批重配）时跳过检查，全部合成。
  const pending: VoiceJob[] = [];
  if (!force) {
    const vocalCacheDir = cacheDirFor(cacheRoot, "vocal");
    for (const job of jobs) {
      let hit: string | null = null;
      try {
        hit = await cacheHit(vocalCacheDir, job.file);
      } catch {
        hit = null;
      }
      if (hit) {
        vocal[job.key] = hit;
      } else {
        pending.push(job);
      }
    }
  } else {
    pending.push(...jobs);
  }
  const cachedCount = jobs.length - pending.length;
  if (jobs.length > 0 && pending.length === 0) {
    log({ step: "配音", message: `配音阶段完成：${jobs.length} 句全部命中缓存，无需合成（0 计费）`, level: "success", at: Date.now() });
  } else if (cachedCount > 0) {
    log({ step: "配音", message: `缓存复用 ${cachedCount} 句，实际合成 ${pending.length} 句…`, level: "info", at: Date.now() });
  }
  const total = pending.length;
  let done = 0;
  const emitProgress = (job: VoiceJob): void => {
    done++;
    const label = `${job.voice}「${job.text.slice(0, 12)}…」`;
    log({
      step: "配音",
      message: `进度 ${done}/${total}：${label}`,
      level: "info",
      at: Date.now(),
      progress: { done, total, label },
    });
  };

  let idx = 0;
  const runner = async () => {
    while (idx < pending.length) {
      if (isAborted?.()) return;
      const job = pending[idx++];
      const path = await runVoiceJob(cfg, job, cacheRoot, log, force);
      emitProgress(job);
      if (path) {
        vocal[job.key] = path;
      } else {
        failed.push({
          id: `vocal_${job.key}`,
          kind: "tts",
          step: "配音",
          message: `台词配音失败：${job.voice}「${job.text.slice(0, 30)}…」`,
          at: Date.now(),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  // 实字计费：只统计实际下发 TTS 的文本（缓存命中不计费），而非按句数估算
  const chars = pending.reduce((n, j) => n + (j.text?.length ?? 0), 0);
  logger.info("voice", "配音生成完成", { total: jobs.length, success: Object.keys(vocal).length, failed: failed.length, chars });
  return { vocal, failed, chars };
}

/** 配音产物结构修复（“补全缺失语音”）：
 * 按当前剧本逐句核对「剧本 → assets.json 映射 → 磁盘音频」三者一致——
 * - 无映射的句子：重新合成
 * - 文件名与内容哈希不符（旧文本时代残留）或旧命名规则的句子：重新合成并替换
 * - 结束后清理 vocal 缓存里不再被任何映射引用的孤儿文件（v_* 前缀），结构归位
 * 图片/背景等其它产物不受影响。返回统计。 */
export async function repairVoiceAssets(
  cfg: ApiConfig,
  chapters: ChapterScript[],
  characters: CharacterCard[],
  outputDir: string,
  log: (ev: PipelineEvent) => void,
  concurrency = 3,
  isAborted?: () => boolean,
): Promise<{ total: number; fixed: number; failed: number; purged: number; kept: number }> {
  const cacheRoot = `${outputDir.replace(/[\\/]+$/, "")}/.novel2vn/cache`;
  const cacheDir = cacheDirFor(cacheRoot, "vocal");
  await tauri.mkdirAll(cacheDir);
  const jobs = buildVoiceJobs(cfg, chapters, characters);
  const assets = await readAssetMap(outputDir);
  const baseNameNoExt = (p: string): string => (p.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").toLowerCase();
  // 预判需要重配的句子：无映射 / 映射文件名 ≠ 期望内容寻址文件名（内容哈希或命名规则不符）/ 映射指向的文件已不存在
  const need: VoiceJob[] = [];
  for (const job of jobs) {
    const entry = assets.vocal[job.key];
    const entryOk = !!entry
      && baseNameNoExt(entry) === baseNameNoExt(job.file)
      && (await tauri.pathExists(entry).catch(() => false));
    if (!entryOk) need.push(job);
  }
  log({
    step: "配音",
    message: `配音结构检查：共 ${jobs.length} 句，${jobs.length - need.length} 句健康，${need.length} 句缺失/错配需重配`,
    level: "info",
    at: Date.now(),
  });
  const total = jobs.length;
  let fixed = 0;
  let failed = 0;
  let idx = 0;
  let mergeChain: Promise<void> = Promise.resolve();
  const worker = async (): Promise<void> => {
    while (idx < need.length) {
      if (isAborted?.()) return;
      const job = need[idx++];
      const path = await runVoiceJob(cfg, job, cacheRoot, log, true);
      if (path) {
        fixed++;
        // 串行合并防并发写丢（与 regenerate 流程一致）
        mergeChain = mergeChain.then(() => updateAssetMap(outputDir, (map) => { map.vocal[job.key] = path; }));
        await mergeChain;
        log({
          step: "配音",
          message: `进度 ${fixed}/${need.length}：已重配「${job.text.slice(0, 18)}…」`,
          level: "info",
          at: Date.now(),
        });
      } else {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, need.length)) }, () => worker()));
  // 结构归位：删除缓存中不再被 assets.json 引用的孤儿语音文件
  let purged = 0;
  const finalAssets = await readAssetMap(outputDir);
  const referenced = new Set<string>();
  for (const p of Object.values(finalAssets.vocal)) referenced.add((p.split(/[\\/]/).pop() || "").toLowerCase());
  try {
    const entries = await tauri.listDir(cacheDir);
    for (const e of entries) {
      if (e.isDir || !/^v_/i.test(e.name)) continue;
      if (!referenced.has(e.name.toLowerCase())) {
        await tauri.removePath(e.path).catch(() => {});
        purged++;
      }
    }
  } catch {
    /* 目录不存在等 */
  }
  log({
    step: "配音",
    message: purged
      ? `配音结构修复完成：重配 ${fixed} 句，失败 ${failed}，清理孤儿文件 ${purged} 个`
      : `配音结构修复完成：重配 ${fixed} 句，失败 ${failed}（无需清理孤儿文件）`,
    level: fixed ? "success" : "info",
    at: Date.now(),
  });
  return { total, fixed, failed, purged, kept: total - need.length };
}
