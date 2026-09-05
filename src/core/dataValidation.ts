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
    // 行内容校验：空 text 会导致渲染 esc(undefined) 崩溃，提前拦截
    for (const lineInput of scene.lines as unknown[]) {
      const line = record(lineInput, "chapter line");
      if (typeof line.text !== "string" || !line.text.trim()) throw new Error("chapter line has an invalid text");
      if (line.type !== "dialogue" && line.type !== "narration") throw new Error("chapter line has an invalid type");
    }
    // 可选块结构校验：坏结构会导致 CG/分支/视频位静默丢失
    if (scene.cgEvent !== undefined && scene.cgEvent !== null) {
      const cg = record(scene.cgEvent, "chapter cgEvent");
      if (typeof cg.imagePrompt !== "string") throw new Error("chapter cgEvent has an invalid imagePrompt");
    }
    if (scene.choices !== undefined) {
      if (!Array.isArray(scene.choices)) throw new Error("chapter scene has an invalid choices");
      for (const c of scene.choices as unknown[]) {
        const choice = record(c, "chapter choice");
        if (!Array.isArray(choice.lines)) throw new Error("chapter choice has an invalid lines");
      }
    }
    if (scene.videoPoints !== undefined && !Array.isArray(scene.videoPoints)) {
      throw new Error("chapter scene has an invalid videoPoints");
    }
  }
  return chapter as unknown as ChapterScript;
}
