import type { ChapterScript } from "./types";

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

/** 剧本行校验：空 text 会导致渲染 esc(undefined) 崩溃，非法 type 会被渲染端静默跳过。
 * 主流程 lines 与分支 choices.lines 共用同一口径（分支台词同样会被渲染）。 */
function assertScriptLine(lineInput: unknown, label: string): void {
  const line = record(lineInput, label);
  if (typeof line.text !== "string" || !line.text.trim()) throw new Error(`${label} has an invalid text`);
  if (line.type !== "dialogue" && line.type !== "narration") throw new Error(`${label} has an invalid type`);
}

export function parseChapterScript(input: unknown): ChapterScript {
  const chapter = record(input, "chapter cache");
  if (!Number.isInteger(chapter.chapter) || (chapter.chapter as number) < 0) throw new Error("chapter cache has an invalid chapter number");
  if (typeof chapter.title !== "string") throw new Error("chapter cache has an invalid title");
  if (!Array.isArray(chapter.scenes)) throw new Error("chapter cache has an invalid scene list");
  const scenes = chapter.scenes as unknown[];
  const chapterNo = chapter.chapter;
  for (let si = 0; si < scenes.length; si++) {
    const sceneInput = scenes[si];
    const scene = record(sceneInput, `chapter ${String(chapterNo)} scene #${si}`);
    for (const field of ["id", "location", "atmosphere", "time", "bgPrompt"] as const) {
      if (typeof scene[field] !== "string") throw new Error(`chapter scene has an invalid ${field}`);
    }
    for (const field of ["itemEvents", "lines", "figures"] as const) {
      if (!Array.isArray(scene[field])) throw new Error(`chapter scene has an invalid ${field}`);
    }
    // #1311：itemEvents 逐项校验并带场景/事件下标定位（此前仅 Array.isArray，坏项万行章无从找）。
    const lineCount = (scene.lines as unknown[]).length;
    (scene.itemEvents as unknown[]).forEach((evInput, ei) => {
      const where = `chapter ${String(chapterNo)} scene #${si} itemEvent #${ei}`;
      const ev = record(evInput, where);
      if (!Number.isInteger(ev.triggerIndex) || (ev.triggerIndex as number) < 0 || (ev.triggerIndex as number) > Math.max(0, lineCount - 1)) {
        throw new Error(`${where} has an invalid triggerIndex`);
      }
      if (typeof ev.itemId !== "string" || !ev.itemId.trim()) throw new Error(`${where} has an invalid itemId`);
      if (!["obtain", "exchange", "show", "key"].includes(ev.action as string)) {
        throw new Error(`${where} has an invalid action`);
      }
    });
    for (const lineInput of scene.lines as unknown[]) {
      assertScriptLine(lineInput, "chapter line");
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
        // 分支台词与主台词同口径：坏行/空 text 在渲染分支 label 时同样会崩溃
        for (const lineInput of choice.lines as unknown[]) {
          assertScriptLine(lineInput, "chapter choice line");
        }
      }
    }
    if (scene.videoPoints !== undefined) {
      if (!Array.isArray(scene.videoPoints)) throw new Error("chapter scene has an invalid videoPoints");
      // 视频推荐点必填字段校验：id 是任务键、title/videoPrompt 是展示与生成入口，
      // 缺了会渲染出空条目或无法生成视频
      for (const vpInput of scene.videoPoints as unknown[]) {
        const vp = record(vpInput, "chapter videoPoint");
        if (typeof vp.id !== "string" || !vp.id.trim()) throw new Error("chapter videoPoint has an invalid id");
        if (typeof vp.title !== "string" || !vp.title.trim()) throw new Error("chapter videoPoint has an invalid title");
        if (typeof vp.videoPrompt !== "string" || !vp.videoPrompt.trim()) throw new Error("chapter videoPoint has an invalid videoPrompt");
        if (vp.durationSecs !== undefined && typeof vp.durationSecs !== "number") {
          throw new Error("chapter videoPoint has an invalid durationSecs");
        }
      }
    }
    if (scene.shots !== undefined) {
      // 图片小说分镜（#807）：坏数据不得写入剧本缓存——prompt 空会让生图必然失败，
      // triggerLineIndex 越界会让切换点丢失/崩溃。校验不过整章判损坏，重跑即可。
      if (!Array.isArray(scene.shots)) throw new Error("chapter scene has an invalid shots");
      const lineCount = (scene.lines as unknown[]).length;
      for (const shotInput of scene.shots as unknown[]) {
        const shot = record(shotInput, "chapter shot");
        if (typeof shot.id !== "string" || !shot.id.trim()) throw new Error("chapter shot has an invalid id");
        if (typeof shot.prompt !== "string" || !shot.prompt.trim()) throw new Error("chapter shot has an invalid prompt");
        const trigger = shot.triggerLineIndex;
        if (!Number.isInteger(trigger) || (trigger as number) < 0 || (trigger as number) > Math.max(0, lineCount - 1)) {
          throw new Error("chapter shot has an invalid triggerLineIndex");
        }
      }
    }
  }
  return chapter as unknown as ChapterScript;
}
