/**
 * 引擎对照修复的回归测试（2026-10-13 核查报告 F1/F2/F3/F5 + 群戏站位）。
 *
 * 这个文件的立场：**不钉死历史字面量，只钉死不变量与几何推导**。
 * 报告里的核心结论（Max_line 就是行数、环境音要 -id 循环、粒子特效、站位目标名）
 * 都能从「textbox.scss 的几何」「引擎常量 2560×1440」重新算出来，所以这里：
 *   ① 直接解析 textbox.scss 取出真实几何，重算每行字数/可见行数；
 *   ② 断言 render.ts 导出的常量与 config.txt 的 Max_line 与重算结果**完全一致**；
 *   ③ 断言取景变换的可见比例由 2560×1440 推出（而不是注释里那句 1920×1080）。
 * 只要有人改了 SCSS、改了舞台尺寸或改了常量，这里立刻失败——这正是报告 F1 要求的「几何一变就失败」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AMBIENT_SE,
  FIGURE_FRAMING,
  FIGURE_FRAMING_OFFSET_Y,
  FIGURE_FRAMING_SCALE,
  FIGURE_FRAMING_ZOOM,
  FIGURE_FRAMING_ZOOM_OFFSET_Y,
  FIGURE_FRAMING_ZOOM_SCALE,
  MAX_STAGE_FIGURES,
  ROOT_FONT_SCALE,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  STAGE_POSITIONS,
  TEXTBOX_CHAR_WIDTH_EM,
  TEXTBOX_FONT_SCALE,
  TEXTBOX_GEOMETRY,
  TEXTBOX_LINE_HEIGHT_EM,
  TEXTBOX_PAGE_MAX_CHARS,
  TTS_SPEECH_MAX_CHARS,
  ambientSeId,
  detectWeather,
  figureTransformTarget,
  figureVisibleRatio,
  renderChapter,
  renderConfig,
  textboxCapacityChars,
  textboxCharsPerLine,
  textboxVisibleLines,
} from "../src/core/render";
import type { ChapterScript, CharacterCard, SceneJSON } from "../src/core/types";
import type { RenderAssets } from "../src/core/render";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const ROOT = process.cwd().replace(/\\/g, "/");
/** 模板 SCSS 的**仓库内源头**（src-tauri/templates/webgal/ 是 gitignored 生成物，不能作为事实来源）。 */
const SCSS_PATH = "src/gameExtra/game-ui/Stage/TextBox/textbox.scss";

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** 从 SCSS 里取某个选择器块内的某个属性值（如 .TextBox_main 的 max-height / padding）。 */
function scssProp(block: string, prop: string): number {
  const re = new RegExp(`${prop}\\s*:\\s*(-?[0-9.]+)px`);
  const m = re.exec(block);
  assert(m, `未能从 ${SCSS_PATH} 解析出 ${prop}（几何不变量无法校验）`);
  return Number(m![1]);
}

function scssBlock(src: string, selector: string): string {
  const start = src.indexOf(selector);
  assert(start >= 0, `${SCSS_PATH} 里找不到选择器 ${selector}`);
  const open = src.indexOf("{", start);
  const close = src.indexOf("}", open);
  assert(open > 0 && close > open, `${SCSS_PATH} 的 ${selector} 块不完整`);
  return src.slice(open, close);
}

/* ============ ① 文本框容量不变量（报告 F1） ============ */

function testTextboxCapacity(): void {
  const scss = readSrc(SCSS_PATH);
  const main = scssBlock(scss, ".TextBox_main {");
  const textBlock = scssBlock(scss, ".text {");

  // SCSS 是唯一事实来源：先把它读出来
  const boxHeightPx = scssProp(main, "max-height");
  const padding = /padding\s*:\s*([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px/.exec(main);
  assert(padding, `${SCSS_PATH} 的 .TextBox_main padding 应形如「上 左右 下」三值简写`);
  const [, padTop, padX, padBottom] = padding!.map(Number);
  const insetX = scssProp(main, "left");
  const scssLineHeight = Number(/line-height\s*:\s*([0-9.]+)\s*!important/.exec(textBlock)?.[1]);
  assert(Number.isFinite(scssLineHeight), `${SCSS_PATH} 的 .text 应有 line-height: N !important`);

  // 再断言 render.ts 的常量与 SCSS 一致（两边不一致 → 推导出来的容量是假的）
  assert(
    TEXTBOX_GEOMETRY.boxHeightPx === boxHeightPx,
    `TEXTBOX_GEOMETRY.boxHeightPx(${TEXTBOX_GEOMETRY.boxHeightPx}) 必须等于 SCSS 的 max-height(${boxHeightPx})`,
  );
  assert(TEXTBOX_GEOMETRY.paddingTopPx === padTop, `TEXTBOX_GEOMETRY.paddingTopPx 应为 ${padTop}`);
  assert(TEXTBOX_GEOMETRY.paddingBottomPx === padBottom, `TEXTBOX_GEOMETRY.paddingBottomPx 应为 ${padBottom}`);
  assert(TEXTBOX_GEOMETRY.paddingXPx === padX, `TEXTBOX_GEOMETRY.paddingXPx 应为 ${padX}`);
  assert(TEXTBOX_GEOMETRY.insetXPx === insetX, `TEXTBOX_GEOMETRY.insetXPx 应为 ${insetX}`);
  assert(
    TEXTBOX_LINE_HEIGHT_EM === scssLineHeight,
    `TEXTBOX_LINE_HEIGHT_EM(${TEXTBOX_LINE_HEIGHT_EM}) 必须等于 SCSS 的 line-height(${scssLineHeight})`,
  );

  // 独立重算（不复用 render.ts 的函数，避免「用被测函数验证被测函数」）
  const fontPx = 16 * ROOT_FONT_SCALE * TEXTBOX_FONT_SCALE;
  const lineHeightPx = fontPx * scssLineHeight;
  const contentWidth = STAGE_WIDTH - 2 * insetX - 2 * padX - TEXTBOX_GEOMETRY.enginePaddingLeftEm * fontPx;
  const expectedPerLine = Math.floor(contentWidth / (fontPx * TEXTBOX_CHAR_WIDTH_EM));
  const expectedLines = Math.floor((boxHeightPx - padTop - padBottom) / lineHeightPx);

  assert(
    textboxCharsPerLine() === expectedPerLine,
    `每行字数应由 SCSS 几何推出 ${expectedPerLine}，实际 ${textboxCharsPerLine()}`,
  );
  assert(
    textboxVisibleLines() === expectedLines,
    `可见整行数应由 SCSS 几何推出 ${expectedLines}，实际 ${textboxVisibleLines()}`,
  );
  assert(expectedLines >= 1, "文本框至少要能显示 1 行");
  assert(
    textboxCapacityChars() === expectedLines * expectedPerLine,
    "容量 = 整行数 × 每行字数",
  );

  // 不变量：1 个 `|` 分段 = 1 个视觉行（引擎每段渲染成一个 nowrap 的 div）
  assert(
    TEXTBOX_PAGE_MAX_CHARS === textboxCharsPerLine(),
    `TEXTBOX_PAGE_MAX_CHARS(${TEXTBOX_PAGE_MAX_CHARS}) 必须等于每行字数(${textboxCharsPerLine()})`,
  );
  // 不变量：单条语音上限 = 一屏可见字数（否则配音念完而玩家只看到一部分）
  assert(
    TTS_SPEECH_MAX_CHARS === textboxCapacityChars(),
    `TTS_SPEECH_MAX_CHARS(${TTS_SPEECH_MAX_CHARS}) 必须等于一屏可见字数(${textboxCapacityChars()})`,
  );

  // config.txt：Max_line 必须**同时**满足「覆盖全部分页」与「不超过可见行数」
  const cfg = renderConfig("t", "k");
  const maxLine = Number(/^Max_line:(\d+);$/m.exec(cfg)?.[1]);
  assert(Number.isFinite(maxLine), `config.txt 必须含 Max_line，实际：\n${cfg}`);
  const needed = Math.ceil(TTS_SPEECH_MAX_CHARS / TEXTBOX_PAGE_MAX_CHARS);
  assert(
    maxLine >= needed,
    `Max_line(${maxLine}) 必须覆盖单条消息的全部分页(${needed})，否则尾部被引擎 .slice(0, Max_line) 丢弃`,
  );
  assert(
    maxLine <= textboxVisibleLines(),
    `Max_line(${maxLine}) 不得超过可见整行数(${textboxVisibleLines()})，否则多出来的行被 overflow:hidden 裁掉（F1 的原始 bug）`,
  );
  assert(
    new RegExp(`^Line_height:${scssLineHeight};$`, "m").test(cfg),
    `config 的 Line_height 必须与 SCSS 行高一致（否则可见行数推导失效），实际：\n${cfg}`,
  );

  // 长台词的分页数不得超过 Max_line（有配音的台词按 TTS 上限拆段，每段再按页容量分页）
  const pageCount = Math.ceil(TTS_SPEECH_MAX_CHARS / TEXTBOX_PAGE_MAX_CHARS);
  assert(
    pageCount <= maxLine,
    `最长的一条配音消息分 ${pageCount} 页，而 Max_line 只有 ${maxLine}——最后一页会被引擎丢掉`,
  );

  console.log(
    `[容量] 每行 ${textboxCharsPerLine()} 字 × ${textboxVisibleLines()} 行 = ${textboxCapacityChars()} 字/屏；`
    + `Max_line:${maxLine}；框高 ${boxHeightPx}px（由 ${SCSS_PATH} 重算一致）`,
  );
}

/* ============ ② 立绘取景几何（报告 F5） ============ */

function testFigureFramingGeometry(): void {
  // 引擎舞台常量（4.6.6 产物 Qm）——注释里写 1920×1080 是错的，这里把它变成断言
  assert(STAGE_WIDTH === 2560 && STAGE_HEIGHT === 1440, `舞台应为 2560×1440，实际 ${STAGE_WIDTH}×${STAGE_HEIGHT}`);

  const contained = 1440; // 1024² 立绘 contain 到 1440 高的舞台
  const visible = figureVisibleRatio(FIGURE_FRAMING_SCALE, FIGURE_FRAMING_OFFSET_Y);
  const expected = (contained - FIGURE_FRAMING_OFFSET_Y) / (contained * FIGURE_FRAMING_SCALE);
  assert(
    Math.abs(visible - expected) < 1e-9,
    `可见比例应由「(contain − offsetY) ÷ (contain × scale)」推出 ${expected}，实际 ${visible}`,
  );
  // 手算值：顶边 = 1440 − 1440×1.75 + 350 = −730 → 可见 1440+730 = 2170 / 2520 ≈ 43.3%
  assert(
    Math.abs(visible - 0.4325) < 0.001,
    `FIGURE_FRAMING 的可见比例应约 43.3%（2560×1440 舞台），实际 ${(visible * 100).toFixed(1)}%`,
  );
  assert(
    visible > 0.25 && visible < 0.6,
    `半身取景的可见比例应落在 25%–60%（腰部～大腿取景区间），实际 ${(visible * 100).toFixed(1)}%`,
  );

  const zoom = figureVisibleRatio(FIGURE_FRAMING_ZOOM_SCALE, FIGURE_FRAMING_ZOOM_OFFSET_Y);
  assert(
    Math.abs(zoom - 0.3267) < 0.001,
    `FIGURE_FRAMING_ZOOM 的可见比例应约 32.7%，实际 ${(zoom * 100).toFixed(1)}%`,
  );
  assert(zoom < visible, "高潮推近必须比常规取景更近（可见比例更小）");

  // 变换 JSON 必须由常量算出（防止有人改常量却忘了改字符串）
  const parse = (json: string): { scale: { x: number }; position: { x: number; y: number } } =>
    JSON.parse(json) as { scale: { x: number }; position: { x: number; y: number } };
  const framing = parse(FIGURE_FRAMING);
  assert(framing.scale.x === FIGURE_FRAMING_SCALE, `FIGURE_FRAMING.scale 应为 ${FIGURE_FRAMING_SCALE}`);
  assert(framing.position.y === FIGURE_FRAMING_OFFSET_Y, `FIGURE_FRAMING.position.y 应为 ${FIGURE_FRAMING_OFFSET_Y}`);
  assert(framing.position.x === 0, "取景不应横向偏移（站位由引擎 q1() 决定）");
  const zoomJson = parse(FIGURE_FRAMING_ZOOM);
  assert(zoomJson.scale.x === FIGURE_FRAMING_ZOOM_SCALE, `FIGURE_FRAMING_ZOOM.scale 应为 ${FIGURE_FRAMING_ZOOM_SCALE}`);
  assert(
    zoomJson.position.y === FIGURE_FRAMING_ZOOM_OFFSET_Y,
    `FIGURE_FRAMING_ZOOM.position.y 应为 ${FIGURE_FRAMING_ZOOM_OFFSET_Y}`,
  );

  console.log(`[取景] 常规可见 ${(visible * 100).toFixed(1)}%，推近 ${(zoom * 100).toFixed(1)}%（按 2560×1440 重算）`);
}

/* ============ ③ 群戏站位（报告：群戏被压成 1v1） ============ */

const POSITION_ORDER = ["left", "right", "center", "left13", "right13"] as const;

function card(id: string, name: string): CharacterCard {
  return { id, name, appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" };
}

function sceneWithSpeakers(speakers: string[]): SceneJSON {
  return {
    id: "s1",
    location: "议事厅",
    atmosphere: "平静",
    time: "白天",
    bgPrompt: "bg",
    itemEvents: [],
    lines: speakers.map((id) => ({ type: "dialogue", characterId: id, text: `我是${id}`, emotion: "normal" })),
    figures: [],
  };
}

function renderSpeakers(speakers: string[], figureActions = true): string {
  const characters = speakers.map((id) => card(id, `角色${id}`));
  const figure: Record<string, string> = {};
  for (const id of speakers) figure[id] = `/x/f_${id}.png`;
  const chapter: ChapterScript = { chapter: 0, title: "第一章", scenes: [sceneWithSpeakers(speakers)] };
  const assets: RenderAssets = { bg: {}, cg: {}, figure, item: {}, vocal: {} };
  return renderChapter(
    chapter,
    { characters, items: [], assets, introCard: false, figureActions } as never,
    1,
  );
}

function testStagePositions(): void {
  // 引擎原生 7 站位，本项目用前 5 个；顺序即分配顺序（先来先占外侧位）
  assert(
    JSON.stringify(STAGE_POSITIONS) === JSON.stringify(POSITION_ORDER),
    `STAGE_POSITIONS 应为 ${JSON.stringify(POSITION_ORDER)}，实际 ${JSON.stringify(STAGE_POSITIONS)}`,
  );
  assert(MAX_STAGE_FIGURES === POSITION_ORDER.length, "同台上限应等于可用站位数量");
  // 每个站位都必须映射到引擎自己的变换目标名（fig-center / fig-left13 …）
  for (const p of POSITION_ORDER) {
    assert(figureTransformTarget(p) === `fig-${p}`, `站位 ${p} 的变换目标应为 fig-${p}`);
  }

  // 3 人：left / right / center 三个不同站位，且取景 target 各不相同
  const out3 = renderSpeakers(["a", "b", "c"]);
  for (const p of ["left", "right", "center"]) {
    assert(out3.includes(`changeFigure:f_${p === "left" ? "a" : p === "right" ? "b" : "c"}.png -${p}`), `3 人应各自占用 ${p} 站位`);
    assert(
      out3.includes(`setTransform:${FIGURE_FRAMING} -target=fig-${p} -duration=0`),
      `站位 ${p} 必须输出对应的取景 target（写死 fig-left/fig-right 会套错立绘）`,
    );
  }
  // 关键回归：第 3 人**不得**驱逐第 1 人（旧实现只有左右两槽，群戏被压成 1v1）
  assert(
    !out3.includes("changeFigure:none -left -exit=exit -next;") || out3.indexOf("changeFigure:none -left -exit=exit -next;") < out3.indexOf("changeFigure:f_a.png"),
    "3 人同台时第 1 人不应被驱逐（章首清场之外的 changeFigure:none -left 即为驱逐）",
  );

  // 5 人：再加 left13 / right13，全部 5 个站位各就各位
  const out5 = renderSpeakers(["a", "b", "c", "d", "e"]);
  for (const p of POSITION_ORDER) {
    assert(out5.includes(` -${p} -enter=`), `5 人时应有角色占用 ${p} 站位`);
    assert(out5.includes(`-target=fig-${p} -duration=0`), `5 人时 ${p} 站位必须有对应取景 target`);
  }
  assert(
    !/-undefined/.test(out5),
    "不得输出 -undefined 站位（旧实现在插槽状态异常时会把 undefined 当站位名）",
  );

  // 第 6 人：超出上限，必须驱逐最久没说话的角色并复用其站位（而不是叠加到已有站位上）
  const out6 = renderSpeakers(["a", "b", "c", "d", "e", "f"]);
  assert(out6.includes("changeFigure:f_f.png"), "第 6 人应有立绘");
  const evictions = out6.split("\n").filter((l) => /^changeFigure:none -(left|right|center|left13|right13)( -exit=exit)? -next;$/.test(l.trim()));
  assert(
    evictions.length >= 1,
    `第 6 人必须驱逐一个角色（同台上限 ${MAX_STAGE_FIGURES}），实际没有任何驱逐指令`,
  );
  const sixPositions = POSITION_ORDER.filter((p) => out6.includes(` -${p} -enter=`));
  assert(sixPositions.length === MAX_STAGE_FIGURES, `同台站位应恰好 ${MAX_STAGE_FIGURES} 个，实际 ${sixPositions.length}`);

  // figureActions:false 时不得出现入场动画，但取景 target 仍要跟着站位走
  // （注意章首清场用的是 -exit=exit，与入场动画 -enter=<动画名> 不是一回事，别把两者混为一谈）
  const outNoAnim = renderSpeakers(["a", "b", "c"], false);
  assert(!outNoAnim.includes("-enter=enter-from-"), "figureActions:false 不应输出入场动画");
  assert(outNoAnim.includes("-target=fig-center -duration=0"), "关闭动作后仍需为 center 站位套取景");

  // 章首清场必须覆盖全部可用站位：上一章末尾可能停在 center/left13/right13 上
  const header = out3.slice(0, out3.indexOf("; ---- 跨章复位 ----"));
  for (const p of ["left", "right", "left13", "right13"]) {
    assert(header.includes(`changeFigure:none -${p}`), `章首清场应覆盖 ${p} 站位`);
  }
  assert(header.includes("changeFigure:none -next;"), "章首清场应覆盖默认（center）站位");

  console.log(`[站位] 同台 ${MAX_STAGE_FIGURES} 人，站位 ${POSITION_ORDER.join("/")}，各自输出 fig-<站位> 取景`);
}

/* ============ ④ 环境音效 -id 循环（报告 F2） ============ */

function testAmbientSe(): void {
  // 持续氛围音必须循环；点状音必须一次性
  for (const se of ["rain", "wind", "battle", "tension"]) {
    assert(AMBIENT_SE.has(se), `${se} 应属持续氛围音（内置素材 3–4 秒，不循环会在场景中途静音）`);
  }
  for (const se of ["thunder", "door", "sword", "step"]) {
    assert(!AMBIENT_SE.has(se), `${se} 应属一次性事件音（本身就是「发生了一次」）`);
  }

  // 雨 → 晴 → 雨：两次起播都带 -id，中间的晴天必须显式停止（否则雨声一直下）
  const chapter: ChapterScript = {
    chapter: 0,
    title: "第一章",
    scenes: [
      sceneWithSpeakers(["a"]),
      { ...sceneWithSpeakers(["a"]), id: "s2", location: "书房", atmosphere: "温馨日常", lines: [] },
      { ...sceneWithSpeakers(["a"]), id: "s3", location: "野外", atmosphere: "大雨倾盆", lines: [] },
    ],
  };
  chapter.scenes[0] = { ...chapter.scenes[0], location: "野外", atmosphere: "大雨倾盆" };
  const out = renderChapter(
    chapter,
    { characters: [card("a", "甲")], items: [], assets: { bg: {}, cg: {}, figure: { a: "/x/a.png" }, item: {}, vocal: {} }, introCard: false } as never,
    1,
  );
  const lines = out.split("\n").map((l) => l.trim());
  const rainLines = lines.filter((l) => l.startsWith("playEffect:se_rain.wav"));
  assert(rainLines.length === 2, `[雨,晴,雨] 应起播 2 次雨声，实际 ${rainLines.length}`);
  for (const l of rainLines) {
    assert(
      l.includes(`-id=${ambientSeId("rain")}`),
      `持续氛围音必须带 -id 才会循环（引擎：设置 id 后音效循环播放），实际：${l}`,
    );
  }
  const stops = lines.filter((l) => l.startsWith("playEffect:none"));
  assert(stops.length >= 1, "离开雨场景必须显式停止循环音（playEffect:none），否则雨会一直下到下一场");

  // 雷（不带「雨」字）：detectSe 给 thunder（点状一次性），天气侧无粒子
  // 注意「雷雨交加」里含「雨」字，会先命中 rain 分支——这是 detectSe 既有的关键词优先级，不是 bug。
  const thunderScene: SceneJSON = { ...sceneWithSpeakers(["a"]), location: "荒原", atmosphere: "雷声轰鸣" };
  const thunderChapter: ChapterScript = { chapter: 0, title: "第一章", scenes: [thunderScene] };
  const thunderOut = renderChapter(
    thunderChapter,
    { characters: [card("a", "甲")], items: [], assets: { bg: {}, cg: {}, figure: { a: "/x/a.png" }, item: {}, vocal: {} }, introCard: false } as never,
    1,
  );
  const thunderLine = thunderOut.split("\n").map((l) => l.trim()).find((l) => l.startsWith("playEffect:se_"));
  assert(!!thunderLine, "雷声场景应有音效");
  assert(thunderLine!.includes("se_thunder.wav"), `打雷应命中雷声，实际：${thunderLine}`);
  assert(!thunderLine!.includes("-id="), `一次性音效不应带 -id（带了就永远循环），实际：${thunderLine}`);
  assert(!thunderOut.includes("pixiPerform:"), "只有雷声没有雨雪时不应添加粒子特效");

  // 雷雨交加：detectSe 命中 rain（「雨」字优先），天气侧同样下雨
  const stormScene: SceneJSON = { ...sceneWithSpeakers(["a"]), location: "荒原", atmosphere: "雷雨交加" };
  const stormOut = renderChapter(
    { chapter: 0, title: "第一章", scenes: [stormScene] },
    { characters: [card("a", "甲")], items: [], assets: { bg: {}, cg: {}, figure: { a: "/x/a.png" }, item: {}, vocal: {} }, introCard: false } as never,
    1,
  );
  assert(stormOut.includes("playEffect:se_rain.wav -id=amb_rain"), "雷雨交加应命中雨声（含「雨」字优先于「雷」）");
  assert(stormOut.includes("pixiPerform:rain;"), "雷雨场景的画面应下雨（天气判据与音效判据独立）");

  console.log(`[音效] 持续氛围音 ${[...AMBIENT_SE].join("/")} 带 -id 循环，点状音一次性，离场显式停止`);
}

/* ============ ⑤ 天气粒子特效（报告 F3） ============ */

function testWeather(): void {
  const mk = (location: string, atmosphere: string, time = "白天"): SceneJSON => ({
    ...sceneWithSpeakers(["a"]),
    location,
    atmosphere,
    time,
  });
  const cases: Array<[string, string, string | null]> = [
    ["野外", "大雨倾盆", "rain"],
    ["荒原", "雷雨交加", "rain"],
    ["雪山", "风雪交加", "heavySnow"],
    ["庭院", "细雪飘落", "snow"],
    ["樱花园", "春日暖阳", "cherryBlossoms"],
    ["书房", "温馨日常", null],
  ];
  for (const [loc, atm, expected] of cases) {
    assert(
      detectWeather(mk(loc, atm)) === expected,
      `detectWeather(${loc}/${atm}) 应为 ${expected}，实际 ${detectWeather(mk(loc, atm))}`,
    );
  }
  // 顺序：暴雪优先于雪，雨优先于雷（雷雨的主氛围是雨）
  assert(detectWeather(mk("x", "暴雪")) === "heavySnow", "暴雪应先于普通雪命中");
  assert(detectWeather(mk("x", "雷雨")) === "rain", "雷雨应判为 rain（音效侧才是 thunder）");

  const assets: RenderAssets = { bg: {}, cg: {}, figure: { a: "/x/a.png" }, item: {}, vocal: {} };
  const chapter: ChapterScript = {
    chapter: 0,
    title: "第一章",
    scenes: [mk("野外", "大雨倾盆"), mk("书房", "温馨日常"), mk("庭院", "细雪飘落")],
  };
  const out = renderChapter(chapter, { characters: [card("a", "甲")], items: [], assets, introCard: false } as never, 1);
  const lines = out.split("\n").map((l) => l.trim());

  // 每个天气变化的场景都要先 pixiInit（文档：不重新初始化，特效会一直运行）
  assert(lines.filter((l) => l === "pixiInit;").length === 3, `三个场景天气都发生变化，应各输出一次 pixiInit，实际 ${lines.filter((l) => l === "pixiInit;").length}`);
  const performs = lines.filter((l) => l.startsWith("pixiPerform:"));
  assert(performs.length === 2, `雨与雪各一次 pixiPerform，实际 ${performs.length}`);
  assert(performs[0] === "pixiPerform:rain;", `首场应为雨，实际 ${performs[0]}`);
  assert(performs[1] === "pixiPerform:snow;", `末场应为雪，实际 ${performs[1]}`);
  // pixiInit 必须紧邻其 pixiPerform（清场→铺新效果），否则中间插指令会破坏「先清后铺」的语义
  const rainIdx = lines.indexOf("pixiPerform:rain;");
  assert(lines[rainIdx - 1] === "pixiInit;", "pixiPerform 必须紧跟 pixiInit（先初始化再添加效果）");

  // 晴天场景必须清掉上一场的粒子（只 pixiInit、不再 pixiPerform）
  const clearSceneIdx = out.indexOf("; ---- 场景：书房");
  const clearSceneBlock = out.slice(clearSceneIdx, out.indexOf("; ---- 场景：庭院"));
  assert(clearSceneBlock.includes("pixiInit;"), "晴天场景必须 pixiInit 清除上一场的雨");
  assert(!clearSceneBlock.includes("pixiPerform:"), "晴天场景不应再添加任何粒子");

  // 用户明确关掉氛围时不叠粒子（避免「静音但还在下雪」）
  const off = renderChapter(
    chapter,
    { characters: [card("a", "甲")], items: [], assets, introCard: false, useSe: false } as never,
    1,
  );
  assert(!off.includes("pixiPerform:"), "useSe:false 时不应输出粒子特效");
  assert(!off.includes("playEffect:"), "useSe:false 时不应输出音效");
  const off2 = renderChapter(
    chapter,
    { characters: [card("a", "甲")], items: [], assets, introCard: false, useWeather: false } as never,
    1,
  );
  assert(!off2.includes("pixiPerform:"), "useWeather:false 时不应输出粒子特效");

  console.log(`[天气] 雨/雪/暴雪/樱花粒子按场景变化 pixiInit+pixiPerform，晴天与关闭开关时正确清场`);
}

function main(): void {
  testTextboxCapacity();
  testFigureFramingGeometry();
  testStagePositions();
  testAmbientSe();
  testWeather();
  console.log("=== 引擎对照修复回归通过（F1 容量不变量 / F2 环境音循环 / F3 粒子特效 / F5 取景几何 / 群戏站位）===");
}

main();
