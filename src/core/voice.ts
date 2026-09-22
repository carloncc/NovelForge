import type { ChapterScript, CharacterCard, PipelineEvent, ApiConfig, FailedTask } from "./types";
import { ttsSpeech } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { cacheDirFor } from "./cache";
import { sceneVocalKey, sceneVocalKeyPart, splitLineForSpeech } from "./render";
import { ttsConfigById, requireVoiceLibrary, voiceLibraryFor, voiceProfileById } from "../stores/config";
import { pickVoiceForGender, voiceGenderOf } from "./minimaxVoices";
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

/** 配音文件名解析：v_<key>_<voiceFp>_<textHash>.<ext>。
 * key 可含下划线，但 fp/hash 为 base36（无下划线），故从右切最后两段即得；
 * 扩展名不限 mp3（部分 TTS 落 ogg/opus/wav）。 */
export function splitVocalFileName(fileName: string): { key: string; fp: string; hash: string } | null {
  const base = (fileName.split(/[\\/]/).pop() || "").replace(/\.(mp3|ogg|opus|wav|flac|m4a)$/i, "");
  const m = /^v_(.+)_([0-9a-z]+)_([0-9a-z]+)$/.exec(base);
  if (!m) return null;
  return { key: m[1], fp: m[2].toLowerCase(), hash: m[3].toLowerCase() };
}

const VOCAL_EXTS = ["mp3", "ogg", "opus", "wav", "flac", "m4a"];

/** 配音缓存命中：精确文件名优先，否则按 stem 匹配音频扩展名。
 * runVoiceJob 会按 mime 落 ogg 等扩展名，只查 .mp3 会导致每次都 miss 重合成。 */
export async function vocalHit(dir: string, fileName: string): Promise<string | null> {
  const path = `${dir}/${fileName}`;
  try {
    if (await tauri.pathExists(path)) return path;
  } catch {
    /* ignore */
  }
  const base = fileName.replace(/\.(mp3|ogg|opus|wav|flac|m4a)$/i, "");
  for (const ext of VOCAL_EXTS) {
    const candidate = `${dir}/${base}.${ext}`;
    if (candidate === path) continue;
    try {
      if (await tauri.pathExists(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 孤儿语音内容索引：`${voiceFp}_${textHash}` → 文件路径。
 * 同一音色＋同一文本（含语速/情绪参数）即同一句话，key（章节/场景/行号）变化不影响内容，
 * 重分章/重提后可用它把旧文件认领回来，0 计费。 */
export async function buildVocalContentIndex(vocalCacheDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  try {
    const entries = await tauri.listDir(vocalCacheDir);
    for (const e of entries) {
      if (e.isDir) continue;
      const parts = splitVocalFileName(e.name);
      if (parts) index.set(`${parts.fp}_${parts.hash}`, e.path);
    }
  } catch {
    /* 目录不存在 */
  }
  return index;
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

/** 按当前剧本算出全部配音 key（与 buildVoiceJobs 的 key 公式同源，供映射剪枝用）。
 * 长台词按 splitLineForSpeech 展开 _pN 段 key：否则剪枝会把分段映射全删，组装后长台词静默无声。 */
export function vocalKeysForChapters(chapters: ChapterScript[]): string[] {
  const keys: string[] = [];
  const pushLine = (baseKey: string, text: string): void => {
    const parts = splitLineForSpeech(text || "");
    if (parts.length <= 1) {
      keys.push(baseKey);
      return;
    }
    parts.forEach((_, si) => keys.push(sceneVocalKeyPart(baseKey, si, parts.length)));
  };
  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      scene.lines.forEach((line, i) => pushLine(sceneVocalKey(chapter.chapter, scene.id, i), line.text));
      (scene.choices || []).forEach((choice, b) => {
        choice.lines.forEach((line, j) =>
          pushLine(sceneVocalKey(chapter.chapter, scene.id, scene.lines.length + 1000 * (b + 1) + j), line.text));
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
  // #1139：音色库为空时直接抛可读错误（各 TTS 服务均无 "default" 音色）；
  // 禁止再回退假音色逐句 400 失败重试（长篇=数百次无效请求 + 日志刷屏）。
  const library = requireVoiceLibrary(cfg);
  const fallbackVoice = library[0];
  const charById = new Map(characters.map((c) => [c.id, c]));
  const voiceName = (charId: string): { voice: string; ttsConfigId?: string; cloned: boolean } => {
    const char = charById.get(charId);
    const profile = voiceProfileById(char?.voiceProfileId);
    if (profile) return { voice: profile.voiceId, ttsConfigId: profile.ttsConfigId, cloned: true };
    const gender = char?.gender;
    const explicit = char?.voiceName;
    if (explicit && library.includes(explicit)) {
      const voiceGender = voiceGenderOf(explicit);
      // 性别明确且与角色不符（旧项目里 AI 选错/默认回退成男声）→ 重新按性别挑选，修复「女角色男声」
      if (!gender || voiceGender === undefined || voiceGender === "other" || voiceGender === gender) {
        return { voice: explicit, cloned: false };
      }
    }
    const picked = pickVoiceForGender(library, gender, char?.id || charId);
    if (picked) return { voice: picked, cloned: false };
    const v = explicit || charId;
    return { voice: library.includes(v) ? v : fallbackVoice, cloned: false };
  };
  const jobs: VoiceJob[] = [];
  for (const chapter of chapters) {
    // 分章节生成：只处理选中的章节（chapter 字段为 0-based 连续索引）
    if (chapterIndexes && !chapterIndexes.has(chapter.chapter)) continue;
    for (const scene of chapter.scenes) {
      // 主流程台词：对话按角色音色，旁白/独白按默认音色（fallbackVoice）配音，避免整段静默导致 auto/快进体感断层
      scene.lines.forEach((line, i) => {
        // 超长台词按句拆段：key 与渲染层 sceneVocalKeyPart 同公式（多段统一 _pN 后缀），
        // 修复「玩家读到全文、听到的却只有前 500 字」的声画不一致（此前静默 slice(0,500)）
        const baseKey = sceneVocalKey(chapter.chapter, scene.id, i);
        const parts = splitLineForSpeech(line.text);
        if (parts.length > 1) {
          logger.info("voice", "超长台词已按句拆分配音", { key: baseKey, len: line.text.length, parts: parts.length });
        }
        parts.forEach((text, si) => {
          const key = sceneVocalKeyPart(baseKey, si, parts.length);
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
            // 旁白/独白：NarrationLine 无 speed/ttsEmotion 标注，用全局 TTS 默认值
            if (text.length > 200) {
              logger.info("voice", "旁白超长（快进易截断，建议拆句）", { key, len: text.length });
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
      });
      // 分支选择台词（与渲染层的序号公式一致）：对话与旁白同样处理
      (scene.choices || []).forEach((choice, b) => {
        choice.lines.forEach((line, j) => {
          const baseKey = sceneVocalKey(chapter.chapter, scene.id, scene.lines.length + 1000 * (b + 1) + j);
          const parts = splitLineForSpeech(line.text);
          parts.forEach((text, si) => {
            const key = sceneVocalKeyPart(baseKey, si, parts.length);
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
      });
    }
  }
  return jobs;
}

/** 执行单个配音任务（管线批处理与单句重配共用）。
 * isAborted 返回 true 时：不再发起新的合成请求、退避等待中直接放弃（已发出的请求仍会跑完）。 */
export async function runVoiceJob(
  cfg: ApiConfig,
  job: VoiceJob,
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  force = false,
  isAborted?: () => boolean,
  /** B16：每次真正发起 TTS 合成请求时回调文本长度（按实际下发计费；中止/null 返回的任务不计入） */
  onSynthesis?: (chars: number) => void,
): Promise<string | null> {
  const cacheDir = cacheDirFor(cacheRoot, "vocal");
  await tauri.mkdirAll(cacheDir);
  const jobConfig = job.ttsConfigId ? ttsConfigById(job.ttsConfigId) : cfg;
  if (!jobConfig) {
    // 不能 throw：单个任务的配置缺失不应打死整批（此前会冒泡中断整个批处理）
    log({ step: "配音", message: `配音失败（跳过）：声音 ${job.voice} 绑定的 TTS 配置不存在`, level: "warn", at: Date.now() });
    return null;
  }
  if (isAborted?.()) return null;
  const library = voiceLibraryFor(jobConfig);
  // #1139：空库直接跳过并给出可读提示，不发起任何合成请求（更不回退假音色 "default" 重试）。
  if (!library.length) {
    log({ step: "配音", message: "音色库为空，已跳过配音：请先在「API 配置 > TTS 配音 > 音色列表」中填写至少一个可用音色", level: "warn", at: Date.now() });
    return null;
  }
  const fallbackVoice = library[0];
  if (!force) {
    const cached = await vocalHit(cacheDir, job.file);
    if (cached) return cached;
  }
  log({ step: "配音", message: `配音中：${job.voice} 「${job.text.slice(0, 20)}…」`, level: "info", at: Date.now() });
  const isMiniMax = jobConfig.adapter === "minimax-tts" || /minimaxi?\.com/i.test(jobConfig.baseUrl);
  const speak = async (voice: string): Promise<string> => {
    // B16：真正发起合成前才登记计费字符——缓存命中/中止跳过/配置缺失都不会走到这里
    onSynthesis?.(job.text.length);
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
  // 限流重试：1002 / rate limit 时等待退避后重试（最多 4 次，避免一次撞限就把整句跳过）。
  // 中止信号在每轮开始与退避等待后检查：点了停止就不再发起新的合成请求。
  const speakWithRetry = async (voice: string): Promise<string | null> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (isAborted?.()) return null;
      if (attempt > 0) {
        const backoff = 8000 + attempt * 5000;
        log({ step: "配音", message: `检测到限流，${backoff / 1000}s 后重试（第 ${attempt} 次）`, level: "warn", at: Date.now() });
        await sleep(backoff);
        if (isAborted?.()) return null;
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
  // 孤儿认领：exact 文件名对不上时，按音色＋文本哈希找内容相同的文件（重分章/重提换 key 后免费找回）。
  const pending: VoiceJob[] = [];
  let relinked = 0;
  if (!force) {
    const vocalCacheDir = cacheDirFor(cacheRoot, "vocal");
    let contentIndex: Map<string, string> | null = null;
    for (const job of jobs) {
      let hit: string | null = null;
      try {
        hit = await vocalHit(vocalCacheDir, job.file);
      } catch {
        hit = null;
      }
      if (hit) {
        vocal[job.key] = hit;
      } else {
        if (!contentIndex) {
          contentIndex = await buildVocalContentIndex(vocalCacheDir).catch(() => new Map<string, string>());
        }
        const parts = splitVocalFileName(job.file);
        const found = parts ? contentIndex.get(`${parts.fp}_${parts.hash}`) : undefined;
        if (found) {
          vocal[job.key] = found;
          relinked++;
        } else {
          pending.push(job);
        }
      }
    }
  } else {
    pending.push(...jobs);
  }
  const cachedCount = jobs.length - pending.length;
  if (jobs.length > 0 && pending.length === 0) {
    log({ step: "配音", message: `配音阶段完成：${jobs.length} 句全部命中缓存，无需合成（0 计费）`, level: "success", at: Date.now() });
  } else if (cachedCount > 0) {
    log({
      step: "配音",
      message: `缓存复用 ${cachedCount} 句${relinked > 0 ? `（其中 ${relinked} 句为孤儿语音认领：key 变化但内容一致，0 计费）` : ""}，实际合成 ${pending.length} 句…`,
      level: "info",
      at: Date.now(),
    });
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
  // B16：费用按「实际发起合成」的文本长度累计（旧实现按全部 pending 上限预估，中止后未派发的句子也被计费）
  let synthChars = 0;
  const runner = async () => {
    while (idx < pending.length) {
      if (isAborted?.()) return;
      const job = pending[idx++];
      const path = await runVoiceJob(cfg, job, cacheRoot, log, force, isAborted, (n) => {
        synthChars += n;
      });
      emitProgress(job);
      if (path) {
        vocal[job.key] = path;
      } else if (isAborted?.()) {
        return; // 中止：不计失败、不再派发（避免停止后失败数虚增）
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
  // 实字计费：只统计实际下发 TTS 的文本（缓存命中不发请求不计费；中止后未派发的任务也不计）
  const chars = synthChars;
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
): Promise<{ total: number; fixed: number; failed: number; purged: number; kept: number; relinked: number; aborted: boolean }> {
  const cacheRoot = `${outputDir.replace(/[\\/]+$/, "")}/.novel2vn/cache`;
  const cacheDir = cacheDirFor(cacheRoot, "vocal");
  await tauri.mkdirAll(cacheDir);
  const jobs = buildVoiceJobs(cfg, chapters, characters);
  const assets = await readAssetMap(outputDir);
  const baseNameNoExt = (p: string): string => (p.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").toLowerCase();
  // 预判需要重配的句子：无映射 / 映射文件名 ≠ 期望内容寻址文件名（内容哈希或命名规则不符）/ 映射指向的文件已不存在
  // 孤儿认领优先：内容一致（同音色同文本）的旧文件直接改映射指过去，不花钱重配
  const need: VoiceJob[] = [];
  let relinked = 0;
  let contentIndex: Map<string, string> | null = null;
  const relinkedPairs: Array<{ key: string; path: string }> = [];
  for (const job of jobs) {
    if (isAborted?.()) {
      log({ step: "配音", message: "补全缺失/错配语音已中断（检查阶段，未开始重配）", level: "warn", at: Date.now() });
      return { total: jobs.length, fixed: 0, failed: 0, purged: 0, kept: 0, relinked, aborted: true };
    }
    const entry = assets.vocal[job.key];
    const entryOk = !!entry
      && baseNameNoExt(entry) === baseNameNoExt(job.file)
      && (await tauri.pathExists(entry).catch(() => false));
    if (entryOk) continue;
    if (!contentIndex) {
      contentIndex = await buildVocalContentIndex(cacheDir).catch(() => new Map<string, string>());
    }
    const parts = splitVocalFileName(job.file);
    const found = parts ? contentIndex.get(`${parts.fp}_${parts.hash}`) : undefined;
    if (found && (await tauri.pathExists(found).catch(() => false))) {
      // 先收集、循环后一次写映射：逐句 updateAssetMap 是整文件读改写，N 句认领即 N 次全量写
      relinkedPairs.push({ key: job.key, path: found });
      relinked++;
      continue;
    }
    need.push(job);
  }
  // 预检循环是串行的，批量写一次即可（worker 里的并发合并链在此之后，照样可见）
  if (relinkedPairs.length) {
    await updateAssetMap(outputDir, (map) => {
      for (const r of relinkedPairs) map.vocal[r.key] = r.path;
    }).catch(() => {});
  }
  log({
    step: "配音",
    message: `配音结构检查：共 ${jobs.length} 句，${jobs.length - need.length - relinked} 句健康，${relinked} 句孤儿认领（0 计费），${need.length} 句缺失/错配需重配`,
    level: "info",
    at: Date.now(),
  });
  const total = jobs.length;
  let fixed = 0;
  let failed = 0;
  let idx = 0;
  let mergeChain: Promise<void> = Promise.resolve();
  // 本轮新写入的文件：映射合并失败时也不能在随后的孤儿清理里被删掉（付费产物，可被下次内容索引认领）
  const freshFiles = new Set<string>();
  const worker = async (): Promise<void> => {
    while (idx < need.length) {
      if (isAborted?.()) return;
      const job = need[idx++];
      const path = await runVoiceJob(cfg, job, cacheRoot, log, true, isAborted);
      if (path) {
        fixed++;
        freshFiles.add((path.split(/[\\/]/).pop() || "").toLowerCase());
        // 串行合并防并发写丢（与 regenerate 流程一致）；catch 防止单次写失败毒化整条链
        mergeChain = mergeChain
          .then(() => updateAssetMap(outputDir, (map) => { map.vocal[job.key] = path; }))
          .catch((e) => {
            log({ step: "配音", message: `配音映射合并失败（该句未入映射，可重新补配）：${String(e).slice(0, 120)}`, level: "warn", at: Date.now() });
          });
        await mergeChain;
        log({
          step: "配音",
          message: `进度 ${fixed}/${need.length}：已重配「${job.text.slice(0, 18)}…」`,
          level: "info",
          at: Date.now(),
        });
      } else if (isAborted?.()) {
        return;
      } else {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, need.length)) }, () => worker()));
  const aborted = isAborted?.() === true;
  // 结构归位：把缓存中不再被 assets.json 引用的孤儿语音移入回收目录（已中断则不清理，避免半套状态）。
  // B86：旧实现直接删除——旧命名/无法解析的 v_* 文件会被当孤儿误删（付费产物永久丢失）；
  // 改为移入 .novel2vn/trash/，可从磁盘找回或用内容索引重新认领，不再直接销毁。
  let purged = 0;
  if (!aborted) {
    const finalAssets = await readAssetMap(outputDir);
    const referenced = new Set<string>();
    for (const p of Object.values(finalAssets.vocal)) referenced.add((p.split(/[\\/]/).pop() || "").toLowerCase());
    const trashDir = `${outputDir.replace(/[\\/]+$/, "")}/.novel2vn/trash`;
    try {
      const entries = await tauri.listDir(cacheDir);
      for (const e of entries) {
        if (e.isDir || !/^v_/i.test(e.name)) continue;
        // 不回收本轮刚生成的文件：映射写失败只记 warn，但文件是付费产物，删掉会进入「生成→写失败→删除→再生成」循环
        if (referenced.has(e.name.toLowerCase()) || freshFiles.has(e.name.toLowerCase())) continue;
        try {
          await tauri.mkdirAll(trashDir);
          await tauri.replacePath(e.path, `${trashDir}/${e.name}`);
          purged++;
        } catch (moveError) {
          // 回收失败（权限/跨盘）绝不退回删除：付费产物宁可留着，仅告警
          logger.warn("voice", "孤儿语音移入回收目录失败，已保留原文件", {
            file: e.name,
            error: errMsg(moveError),
          });
        }
      }
    } catch {
      /* 目录不存在等 */
    }
  }
  log({
    step: "配音",
    message: aborted
      ? `配音结构修复已中断：孤儿认领 ${relinked} 句，重配 ${fixed} 句，失败 ${failed}（孤儿文件未清理）`
      : purged
        ? `配音结构修复完成：孤儿认领 ${relinked} 句，重配 ${fixed} 句，失败 ${failed}，孤儿文件 ${purged} 个已移入回收目录`
        : `配音结构修复完成：孤儿认领 ${relinked} 句，重配 ${fixed} 句，失败 ${failed}（无需清理孤儿文件）`,
    level: aborted ? "warn" : fixed ? "success" : "info",
    at: Date.now(),
  });
  return { total, fixed, failed, purged, kept: total - need.length - relinked, relinked, aborted };
}
