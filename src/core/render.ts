import type { ChapterScript, CharacterCard, ItemCard, Line, SceneJSON } from "./types";

export interface RenderAssets {
  bg: Record<string, string>;
  cg: Record<string, string>;
  figure: Record<string, string>;
  item: Record<string, string>;
  vocal: Record<string, string>;
  bgm?: Record<string, string>;
}

export interface RenderOptions {
  title: string;
  gameKey: string;
  characters: CharacterCard[];
  items: ItemCard[];
  assets: RenderAssets;
  videos?: Record<string, string>;
  seenCharacters?: Set<string>;
  introCard?: boolean;
  figureEmotions?: boolean;
  /** 人物动作：入场/退场动画、情绪动作、剧情镜头震动；默认开启 */
  figureActions?: boolean;
}

export function sanitizeId(id: string): string {
  const cleaned = (id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unnamed";
}

/** 台词配音键：渲染与配音阶段共用同一公式，保证键一致 */
export function sceneVocalKey(chapter: number, sceneId: string, idx: number): string {
  return `ch${chapter}_${sanitizeId(sceneId)}_${idx}`;
}

function esc(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\./g, "\\.")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

function comment(text: string): string {
  return (text || "").replace(/\r?\n/g, " ").slice(0, 80);
}

function sanitizeLabel(text: string): string {
  return (text || "章节").replace(/[\\/:*?"<>|\r\n;]/g, "_").slice(0, 30);
}

function getBaseName(f: string): string {
  return f.split(/[\\/]/).pop() || f;
}

/* ===== 人物动作：入场动画 + 情绪动作 + 剧情镜头震动 ===== */

const ENTRANCES = ["enter-from-left", "enter-from-right", "enter-from-bottom"];

/** 情绪 → 角色临时动作（作用于 fig-left，即当前说话角色所在插槽） */
function motionFor(emotion?: string): string | null {
  switch (emotion) {
    case "angry":
      return '[{"duration":0},{"position":{"x":-10,"y":0},"duration":70},{"position":{"x":10,"y":0},"duration":140},{"position":{"x":-10,"y":0},"duration":140},{"position":{"x":0,"y":0},"duration":70}]';
    case "surprised":
      return '[{"duration":0},{"scale":{"x":1.08,"y":1.08},"duration":180},{"scale":{"x":1,"y":1},"duration":180}]';
    case "happy":
      return '[{"duration":0},{"position":{"x":0,"y":-14},"duration":170},{"position":{"x":0,"y":0},"duration":170}]';
    case "sad":
      return '[{"duration":0},{"position":{"x":0,"y":6},"duration":320},{"position":{"x":0,"y":0},"duration":320}]';
    default:
      return null;
  }
}

/** 旁白/剧情中有明显动作或冲击感 → 触发舞台镜头震动 */
function isDramatic(text: string): boolean {
  return /(轰鸣|爆炸|崩塌|巨响|震耳|怒吼|嘶吼|冲撞|猛然|狠狠|轰然|剧烈|颤抖|踉跄|飞扑|倒下|拔出|挥剑|斩|劈开)/.test(text);
}

function renderItemEvent(scene: SceneJSON, idx: number, opts: RenderOptions): string[] {
  const ev = scene.itemEvents[idx];
  if (!ev) return [];
  const item = opts.items.find((i) => i.id === ev.itemId);
  const file = opts.assets.item[ev.itemId];
  const name = comment(item?.name || ev.itemId);
  const desc = esc(ev.description || item?.appearance || "道具出现");
  const safeItemId = sanitizeId(ev.itemId);
  const out: string[] = [];
  out.push(`; ---- 物品演出：${name} ----`);
  if (file) {
    out.push(`changeFigure:${getBaseName(file)} -id=item_${safeItemId} -next;`);
  }
  out.push(`intro:「${esc(item?.name || ev.itemId)}」|${desc} -hold;`);
  if (file) {
    out.push(`changeFigure:none -id=item_${safeItemId} -next;`);
  }
  return out;
}

export function renderChapter(
  chapter: ChapterScript,
  opts: RenderOptions,
  chapterCount: number,
): string {
  const out: string[] = [];
  out.push(`; ===== 第 ${chapter.chapter + 1} 章 ${comment(chapter.title)} =====`);
  out.push(`; 由 NovelForge 自动生成`);
  out.push("");
  // 章节标签：供 WebGAL 流程图（任务/章节选择界面）显示与跳转
  out.push(`label:ch${chapter.chapter + 1}_${sanitizeLabel(chapter.title)};`);
  // 清场：避免上一章节的立绘残留
  const useActions = opts.figureActions !== false;
  const clearExit = useActions ? " -exit=exit" : "";
  out.push(`changeFigure:none -left${clearExit} -next;`);
  out.push(`changeFigure:none${clearExit} -next;`);
  out.push(`changeFigure:none -right${clearExit} -next;`);
  // 章节标题卡：黑屏全屏章节名（成熟视觉小说标配，点击继续）
  out.push(`; ---- 章节标题卡 ----`);
  out.push(`intro:第 ${chapter.chapter + 1} 章 · ${esc(chapter.title)} -fontColor=rgba(255,255,255,1) -fontSize=large -hold;`);

  // 舞台立绘管理：同时最多 2 个角色（左/右插槽），新角色出现时按最近说话顺序驱逐
  const stageSlot = new Map<string, "left" | "right">();
  const stageOrder: string[] = [];
  const lastFigureFile = new Map<string, string>();
  let entranceIdx = 0;
  // BGM 状态：WebGAL 的 changeScene 不自动清舞台，跨场景/跨章节残留的音乐需显式停止
  let lastBgm: string | null = null;
  const bgmUnlocked = new Set<string>();

  // 单句渲染（主流程与分支选择共用），idx 为台词在场景内的配音键序号
  const renderLine = (line: Line, idx: number, scene: SceneJSON): void => {
    if (line.type === "dialogue") {
      const char = opts.characters.find((c) => c.id === line.characterId);
      const figureFile = opts.assets.figure[line.characterId];
      // 立绘优先级：台词指定动作 → 对应动作立绘；否则表情差分立绘；否则默认立绘
      let displayFile = figureFile;
      if (line.action) {
        const actionFile = opts.assets.figure[`${line.characterId}_act_${sanitizeId(line.action)}`];
        if (actionFile) displayFile = actionFile;
      } else if (opts.figureEmotions !== false && line.emotion && line.emotion !== "normal") {
        displayFile = opts.assets.figure[`${line.characterId}_${line.emotion}`] ?? figureFile;
      }
      // 舞台管理 + 人物动作：最多 2 个角色同台（左/右），新角色入场 / 表情切换 / 情绪动作
      let slot = stageSlot.get(line.characterId);
      const appearing = !!displayFile && !slot;
      if (displayFile) {
        if (appearing) {
          // 分配插槽；左右满员则驱逐最久没说话的角色
          const used = new Set(stageSlot.values());
          if (!used.has("left")) {
            slot = "left";
          } else if (!used.has("right")) {
            slot = "right";
          } else {
            const victim = stageOrder[stageOrder.length - 1];
            const victimSlot = stageSlot.get(victim)!;
            out.push(`changeFigure:none -${victimSlot}${useActions ? " -exit=exit" : ""} -next;`);
            stageSlot.delete(victim);
            stageOrder.splice(stageOrder.indexOf(victim), 1);
            lastFigureFile.delete(victim);
            slot = victimSlot;
          }
          stageSlot.set(line.characterId, slot);
          if (useActions) {
            const entrance = ENTRANCES[entranceIdx++ % ENTRANCES.length];
            out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -enter=${entrance} -next;`);
          } else {
            out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -next;`);
          }
        } else if (displayFile !== lastFigureFile.get(line.characterId)) {
          out.push(`changeFigure:${getBaseName(displayFile)} -${slot} -next;`);
        }
        lastFigureFile.set(line.characterId, displayFile);
      }
      // 情绪动作：说话时的震动/弹出/跳动（入场那一句跳过，避免与入场动画叠加）
      if (useActions && displayFile && !appearing && slot && line.emotion && line.emotion !== "normal") {
        const motion = motionFor(line.emotion);
        if (motion) out.push(`setTempAnimation:${motion} -target=fig-${slot} -next;`);
      }
      // 更新最近说话顺序（用于驱逐）
      const oi = stageOrder.indexOf(line.characterId);
      if (oi >= 0) stageOrder.splice(oi, 1);
      stageOrder.unshift(line.characterId);
      // 首次登场资料演出：立绘 + 文本框资料卡（旁白形式，立绘保持可见）
      if (opts.introCard !== false && char && !opts.seenCharacters?.has(line.characterId)) {
        opts.seenCharacters?.add(line.characterId);
        const parts = [`【${esc(char.name)}】`];
        if (char.appearance) parts.push(esc(char.appearance));
        if (char.personality) parts.push(esc(char.personality));
        out.push(`:${parts.join(" ")};`);
      }
      const name = esc(char?.name || line.characterId || "???");
      const vocalKey = sceneVocalKey(chapter.chapter, scene.id, idx);
      const vocalFile = opts.assets.vocal[vocalKey];
      const vocalArg = vocalFile ? ` -${getBaseName(vocalFile)}` : "";
      out.push(`${name}:${esc(line.text)}${vocalArg};`);
    } else if (line.monologue) {
      if (useActions && isDramatic(line.text)) {
        out.push(`setAnimation:shake -target=bg-main -next;`);
      }
      out.push(`intro:${esc(line.text)} -hold;`);
    } else {
      if (useActions && isDramatic(line.text)) {
        out.push(`setAnimation:shake -target=bg-main -next;`);
      }
      out.push(`:${esc(line.text)};`);
    }
  };

  for (const scene of chapter.scenes) {
    out.push("");
    out.push(`; ---- 场景：${comment(scene.location)}（${comment(scene.atmosphere)} ${comment(scene.time)}）----`);

    // BGM：匹配到的音乐文件则播放（并解锁鉴赏）；无匹配则淡出停止，避免串场
    const bgmFile = opts.assets.bgm?.[scene.id];
    if (bgmFile) {
      out.push(`bgm:${getBaseName(bgmFile)} -next;`);
      if (!bgmUnlocked.has(bgmFile)) {
        bgmUnlocked.add(bgmFile);
        const bgmName = getBaseName(bgmFile).replace(/\.(mp3|ogg|wav|m4a|opus)$/i, "");
        out.push(`unlockBgm:${getBaseName(bgmFile)} -name=${esc(bgmName)};`);
      }
      lastBgm = bgmFile;
    } else if (lastBgm) {
      out.push(`bgm:none -enter=600 -next;`);
      lastBgm = null;
    }

    const bgFile = opts.assets.bg[scene.id];
    if (bgFile) {
      out.push(`changeBg:${getBaseName(bgFile)} -next;`);
    }

    // 视频推荐位：有用户放置的视频文件则播放，否则注释占位（不执行）
    for (const vp of scene.videoPoints || []) {
      const vfile = opts.videos?.[sanitizeId(vp.id)];
      if (vfile) {
        out.push(`; ---- 视频演出：${comment(vp.title)} ----`);
        out.push(`playVideo:${getBaseName(vfile)};`);
      } else {
        out.push(`; [视频位] ${comment(vp.title)}：${comment(vp.description)}（提示词见 video_plan.txt，把生成的 mp4 命名为 video_${sanitizeId(vp.id)}.mp4 放入 video 文件夹后刷新即启用）`);
      }
    }

    const cgFile = opts.assets.cg[scene.id];
    const cg = scene.cgEvent;
    if (cg && cgFile) {
      out.push(`changeBg:${getBaseName(cgFile)} -next;`);
      out.push(`unlockCg:${getBaseName(cgFile)} -name=${esc(cg.title || cg.description || "CG")};`);
      out.push(`:${esc(cg.description || cg.title)};`);
      out.push(`changeBg:${bgFile ? getBaseName(bgFile) : "none"} -next;`);
    }

    const eventIdxByTrigger = new Map<number, number>();
    scene.itemEvents.forEach((ev, i) => {
      if (!eventIdxByTrigger.has(ev.triggerIndex)) eventIdxByTrigger.set(ev.triggerIndex, i);
    });

    scene.lines.forEach((line, i) => {
      const evIdx = eventIdxByTrigger.get(i);
      if (evIdx !== undefined) {
        out.push(...renderItemEvent(scene, evIdx, opts));
      }
      renderLine(line, i, scene);
    });

    const lastEvIdx = eventIdxByTrigger.get(scene.lines.length);
    if (lastEvIdx !== undefined) {
      out.push(...renderItemEvent(scene, lastEvIdx, opts));
    }

    // 分支选择：场景末尾弹出选项，各分支为独立 label 块，结束后跳回合并点继续
    if (scene.choices && scene.choices.length) {
      const prefix = `ch${chapter.chapter + 1}_${sanitizeId(scene.id)}`;
      const joinLabel = `${prefix}_join`;
      const args = scene.choices
        .map((c, ci) => `${esc((c.prompt || "继续").replace(/\|/g, "｜"))}:${prefix}_c${ci + 1}`)
        .join("|");
      out.push("");
      out.push(`; ---- 分支选择 ----`);
      out.push(`choose:${args};`);
      scene.choices.forEach((c, ci) => {
        out.push(`label:${prefix}_c${ci + 1};`);
        c.lines.forEach((line, j) => renderLine(line, scene.lines.length + 1000 * (ci + 1) + j, scene));
        out.push(`jumpLabel:${joinLabel};`);
      });
      out.push(`label:${joinLabel};`);
    }
  }

  const isLast = chapter.chapter + 1 >= chapterCount;
  if (isLast) {
    out.push("");
    out.push(`end;`);
  } else {
    out.push("");
    out.push(`changeScene:ch${chapter.chapter + 2}.txt;`);
  }

  return out.join("\n");
}

export function renderStart(chapterCount: number, title: string): string {
  const out: string[] = [];
  out.push(`; ${comment(title)}`);
  out.push(`; 由 NovelForge 自动生成`);
  out.push("");
  if (chapterCount > 0) {
    out.push(`changeScene:ch1.txt;`);
  }
  return out.join("\n");
}

function cleanConfigValue(text: string): string {
  return (text || "").replace(/[;\r\n]+/g, " ").trim().slice(0, 60);
}

export type WebgalLanguage = "zh_CN" | "zh_TW" | "en" | "ja";

export function renderConfig(
  title: string,
  gameKey: string,
  language: WebgalLanguage = "zh_CN",
  titleImg?: string,
  titleBgm?: string,
): string {
  const lines = [
    `Game_name:${cleanConfigValue(title)};`,
    `Game_key:${cleanConfigValue(gameKey)};`,
    `Enable_Appreciation:true;`,
    `Enable_Continue:true;`,
    `Enable_flowchart:true;`,
    `Show_panic:true;`,
    `Default_Language:${language};`,
  ];
  if (titleImg) lines.push(`Title_img:${cleanConfigValue(titleImg)};`);
  if (titleBgm) lines.push(`Title_bgm:${cleanConfigValue(titleBgm)};`);
  return lines.join("\n");
}



