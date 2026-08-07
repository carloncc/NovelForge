import type { ChapterScript, CharacterCard, PipelineEvent, ApiConfig } from "./types";
import { ttsSpeech } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { cacheDirFor, cacheHit } from "./cache";
import { sanitizeId } from "./render";
import { voiceLibraryFor } from "../stores/config";
import { log as logger } from "../utils/logger";

export interface VoiceJob {
  key: string;
  file: string;
  text: string;
  voice: string;
  charId: string;
}

export function buildVoiceJobs(
  cfg: ApiConfig,
  chapters: ChapterScript[],
  characters: CharacterCard[],
): VoiceJob[] {
  const library = voiceLibraryFor(cfg);
  const fallbackVoice = library[0] || "default";
  const voiceName = (charId: string): string => {
    const char = characters.find((c) => c.id === charId);
    const v = char?.voiceName || char?.id || "default";
    return library.includes(v) ? v : fallbackVoice;
  };
  const jobs: VoiceJob[] = [];
  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      scene.lines.forEach((line, i) => {
        if (line.type !== "dialogue") return;
        const key = `ch${chapter.chapter}_${sanitizeId(scene.id)}_${i}`;
        jobs.push({
          key,
          file: `v_${key}.mp3`,
          text: line.text.slice(0, 500),
          voice: voiceName(line.characterId),
          charId: line.characterId,
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
  const library = voiceLibraryFor(cfg);
  const fallbackVoice = library[0] || "default";
  if (!force) {
    const cached = await cacheHit(cacheDir, job.file);
    if (cached) return cached;
  }
  log({ step: "配音", message: `配音中：${job.voice} 「${job.text.slice(0, 20)}…」`, level: "info", at: Date.now() });
  const speak = async (voice: string): Promise<string> => {
    const res = await ttsSpeech(cfg, job.text, voice);
    const ext = res.mime.includes("ogg") ? "ogg" : res.mime.includes("opus") ? "opus" : res.mime.includes("wav") ? "wav" : "mp3";
    const file = job.file.replace(/\.mp3$/, `.${ext}`);
    const path = `${cacheDir}/${file}`;
    await tauri.writeFileBase64(path, res.dataB64);
    return path;
  };
  try {
    return await speak(job.voice);
  } catch (e) {
    if (job.voice !== fallbackVoice) {
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
      message: `配音失败（跳过）：${(e as Error).message.slice(0, 120)}`,
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
  concurrency = 2,
  force = false,
): Promise<Record<string, string>> {
  const vocal: Record<string, string> = {};
  await tauri.mkdirAll(cacheDirFor(cacheRoot, "vocal"));
  logger.info("voice", "开始生成配音", { characters: characters.length, concurrency, force });

  const jobs = buildVoiceJobs(cfg, chapters, characters);

  let idx = 0;
  const runner = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const path = await runVoiceJob(cfg, job, cacheRoot, log, force);
      if (path) vocal[job.key] = path;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  logger.info("voice", "配音生成完成", { total: jobs.length, success: Object.keys(vocal).length });
  return vocal;
}
