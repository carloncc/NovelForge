import type { ChapterScript } from "./types";

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

export function parseChapterScript(input: unknown): ChapterScript {
  const chapter = record(input, "chapter cache");
  if (!Number.isInteger(chapter.chapter) || (chapter.chapter as number) < 0) throw new Error("chapter cache has an invalid chapter number");
  if (typeof chapter.title !== "string") throw new Error("chapter cache has an invalid title");
  if (!Array.isArray(chapter.scenes)) throw new Error("chapter cache has an invalid scene list");
  for (const sceneInput of chapter.scenes) {
    const scene = record(sceneInput, "chapter scene");
    for (const field of ["id", "location", "atmosphere", "time", "bgPrompt"] as const) {
      if (typeof scene[field] !== "string") throw new Error(`chapter scene has an invalid ${field}`);
    }
    for (const field of ["itemEvents", "lines", "figures"] as const) {
      if (!Array.isArray(scene[field])) throw new Error(`chapter scene has an invalid ${field}`);
    }
  }
  return chapter as unknown as ChapterScript;
}
