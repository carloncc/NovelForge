import type { ChapterScript, CharacterCard, PipelineEvent, ApiConfig, FailedTask } from "./types";
import { ttsSpeech } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { cacheDirFor, cacheHit } from "./cache";
import { sceneVocalKey } from "./render";
import { ttsConfigById, voiceLibraryFor, voiceProfileById } from "../stores/config";
import { log as logger } from "../utils/logger";

export interface VoiceJob {
  key: string;
  file: string;
  text: string;
  voice: string;
  charId: string;
  ttsConfigId?: string;
  cloned: boolean;
}

function voiceFingerprint(voice: string, configId?: string): string {
  let hash = 2166136261;
  for (const character of `${configId ?? "default"}:${voice}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildVoiceJobs(
  cfg: ApiConfig,
  chapters: ChapterScript[],
  characters: CharacterCard[],
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
    for (const scene of chapter.scenes) {
      // 主流程台词
      scene.lines.forEach((line, i) => {
        if (line.type !== "dialogue") return;
        const key = sceneVocalKey(chapter.chapter, scene.id, i);
        const selected = voiceName(line.characterId);
        jobs.push({
          key,
          file: `v_${key}_${voiceFingerprint(selected.voice, selected.ttsConfigId)}.mp3`,
          text: line.text.slice(0, 500),
          voice: selected.voice,
          charId: line.characterId,
          ttsConfigId: selected.ttsConfigId,
          cloned: selected.cloned,
        });
      });
      // 分支选择台词（与渲染层的序号公式一致）
      (scene.choices || []).forEach((choice, b) => {
        choice.lines.forEach((line, j) => {
          if (line.type !== "dialogue") return;
          const key = sceneVocalKey(chapter.chapter, scene.id, scene.lines.length + 1000 * (b + 1) + j);
          const selected = voiceName(line.characterId);
          jobs.push({
            key,
            file: `v_${key}_${voiceFingerprint(selected.voice, selected.ttsConfigId)}.mp3`,
            text: line.text.slice(0, 500),
            voice: selected.voice,
            charId: line.characterId,
            ttsConfigId: selected.ttsConfigId,
            cloned: selected.cloned,
          });
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
  const speak = async (voice: string): Promise<string> => {
    const res = await ttsSpeech(jobConfig, job.text, voice);
    const ext = res.mime.includes("ogg") ? "ogg" : res.mime.includes("opus") ? "opus" : res.mime.includes("wav") ? "wav" : "mp3";
    const file = job.file.replace(/\.mp3$/, `.${ext}`);
    const path = `${cacheDir}/${file}`;
    await tauri.writeFileBase64(path, res.dataB64);
    return path;
  };
  try {
    return await speak(job.voice);
  } catch (e) {
    if (!job.cloned && job.voice !== fallbackVoice) {
      log({
        step: "配音",
        message: `音色 ${job.voice} 失败，回退默认音色重试：${errMsg(e).slice(0, 100)}`,
        level: "warn",
        at: Date.now(),
      });
      try {
        return await speak(fallbackVoice);
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
): Promise<{ vocal: Record<string, string>; failed: FailedTask[] }> {
  const vocal: Record<string, string> = {};
  const failed: FailedTask[] = [];
  await tauri.mkdirAll(cacheDirFor(cacheRoot, "vocal"));
  logger.info("voice", "开始生成配音", { characters: characters.length, concurrency, force });

  const jobs = buildVoiceJobs(cfg, chapters, characters);
  const total = jobs.length;
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
    while (idx < jobs.length) {
      if (isAborted?.()) return;
      const job = jobs[idx++];
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
  logger.info("voice", "配音生成完成", { total: jobs.length, success: Object.keys(vocal).length, failed: failed.length });
  return { vocal, failed };
}
