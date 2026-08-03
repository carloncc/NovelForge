import type { ChapterScript, CharacterCard, PipelineEvent, ApiConfig } from "./types";
import { ttsSpeech } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { cacheDirFor, cacheHit } from "./cache";
import { sanitizeId } from "./render";
import { voiceLibraryFor } from "../stores/config";

export async function generateVoice(
  cfg: ApiConfig,
  chapters: ChapterScript[],
  characters: CharacterCard[],
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  concurrency = 2,
): Promise<Record<string, string>> {
  const vocal: Record<string, string> = {};
  const cacheDir = cacheDirFor(cacheRoot, "vocal");
  await tauri.mkdirAll(cacheDir);

  const library = voiceLibraryFor(cfg);
  const fallbackVoice = library[0] || "default";
  const voiceName = (charId: string): string => {
    const char = characters.find((c) => c.id === charId);
    const v = char?.voiceName || char?.id || "default";
    return library.includes(v) ? v : fallbackVoice;
  };

  const jobs: { key: string; file: string; text: string; voice: string }[] = [];
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
        });
      });
    }
  }

  let idx = 0;
  const runner = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const cached = await cacheHit(cacheDir, job.file);
      if (cached) {
        vocal[job.key] = cached;
        continue;
      }
      log({ step: "配音", message: `配音中：${job.voice} 「${job.text.slice(0, 20)}…」`, level: "info", at: Date.now() });
      try {
        const res = await ttsSpeech(cfg, job.text, job.voice);
        const ext = res.mime.includes("ogg") ? "ogg" : res.mime.includes("opus") ? "opus" : res.mime.includes("wav") ? "wav" : "mp3";
        const file = job.file.replace(/\.mp3$/, `.${ext}`);
        const path = `${cacheDir}/${file}`;
        await tauri.writeFileBase64(path, res.dataB64);
        vocal[job.key] = path;
      } catch (e) {
        if (job.voice !== fallbackVoice) {
          log({
            step: "配音",
            message: `音色 ${job.voice} 失败，回退默认音色重试：${(e as Error).message.slice(0, 100)}`,
            level: "warn",
            at: Date.now(),
          });
          try {
            const res = await ttsSpeech(cfg, job.text, fallbackVoice);
            const ext = res.mime.includes("ogg") ? "ogg" : res.mime.includes("opus") ? "opus" : res.mime.includes("wav") ? "wav" : "mp3";
            const file = job.file.replace(/\.mp3$/, `.${ext}`);
            const path = `${cacheDir}/${file}`;
            await tauri.writeFileBase64(path, res.dataB64);
            vocal[job.key] = path;
            continue;
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
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => runner());
  await Promise.all(workers);
  return vocal;
}
