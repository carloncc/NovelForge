import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * 无障碍弹层的"契约"回归（#1475/#1484）。
 *
 * 为什么用源码断言而不是渲染测试：本仓库没有 jsdom/vitest 渲染环境（单测都是纯 Node + tsx），
 * 而 role/aria-modal/焦点陷阱/Esc 这些恰恰是"组件模板里删掉一行就静默退化、且没有任何
 * 运行时报错"的东西——正是回归测试该盯住的地方。这里按文本断言关键约定存在。
 */

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 递归收集 src/ 下所有 .ts/.vue（原生弹层门禁必须覆盖全仓，不能只枚举几个文件）。
 *  注意不跳过点文件：临时/隐藏源文件照样会被打包进产物，跳过等于给门禁留后门。 */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if ([".ts", ".vue"].includes(extname(e.name))) out.push(p);
  }
  return out;
}

/** 取包含 needle 的那一行（属性是否挂在正确的元素上，比"文件里出现过"更强） */
function lineWith(src: string, needle: string): string {
  return src.split("\n").find((line) => line.includes(needle)) ?? "";
}

/** 同 lineWith，但先排除注释行：注释里会写反例说明（"没有 role=dialog"），
 *  否则契约会被注释里的字符串"满足"——断言看似在跑，其实什么都没锁住。 */
function codeLineWith(src: string, needle: string): string {
  return src.split("\n").find((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes(needle)) ?? "";
}

const dialog = readFileSync("src/components/AppDialog.vue", "utf-8");
const host = readFileSync("src/components/ConfirmDialogHost.vue", "utf-8");
const composable = readFileSync("src/composables/useConfirmDialog.ts", "utf-8");
const app = readFileSync("src/App.vue", "utf-8");

function main(): void {
  // ---- AppDialog：对话框语义 + 键盘可达 ----
  assert(dialog.includes('role="dialog"'), "弹层必须有 role=dialog（读屏据此宣告对话框）");
  assert(dialog.includes('aria-modal="true"'), "弹层必须标记 aria-modal，避免读屏穿透到背景页");
  assert(dialog.includes(":aria-labelledby"), "弹层必须用 aria-labelledby 关联标题");
  assert(dialog.includes(":aria-describedby"), "弹层必须用 aria-describedby 关联说明");
  assert(dialog.includes("tabindex="), "弹层容器必须可聚焦（打开后把焦点收进来）");
  assert(dialog.includes("e.key === \"Escape\""), "弹层必须支持 Esc 关闭");
  assert(dialog.includes("e.key !== \"Tab\""), "弹层必须处理 Tab（焦点陷阱）");
  assert(dialog.includes("lastFocused"), "弹层必须记录触发元素");

  // 焦点陷阱与焦点归还的真实逻辑
  assert(/e\.shiftKey/.test(dialog), "焦点陷阱必须处理 Shift+Tab 反向循环");
  assert(/lastFocused\?\.focus/.test(dialog), "关闭后必须把焦点还给触发元素");
  assert(/max-height/.test(readFileSync("src/styles.css", "utf-8")), "弹层容器需要最大高度约束（矮窗口可滚动）");

  // ---- 宿主：确认/输入两种形态 + 默认按钮来自词典 ----
  assert(host.includes("options.kind === 'prompt'"), "宿主必须区分确认与输入两种形态");
  assert(host.includes("submitInput"), "输入弹层必须能把文本交回 Promise");
  assert(host.includes("placeholder"), "输入弹层必须有占位符（说明要填什么）");
  assert(app.includes("<ConfirmDialogHost"), "全局宿主必须挂载在 App 上，否则弹层永远不显示");

  // ---- 组合式：队列串行化 + 空输入归一 ----
  assert(composable.includes("queue.push"), "并发请求必须排队，不能覆盖当前弹层");
  assert(/resolve\(text\.length > 0 \? text : null\)/.test(composable), "空输入必须归一为 null（调用方按取消处理）");
  assert(composable.includes("export function confirmDialog"), "必须导出 confirmDialog");
  assert(composable.includes("export function promptDialog"), "必须导出 promptDialog（替代 window.prompt）");

  // ---- 全仓不得再出现原生阻塞弹层 ----
  // 旧实现只枚举 4 个文件（stores/generate.ts、ImportPage.vue、EditCards.vue、VisualBiblePanel.vue），
  // 而注释写的是"全仓"——ChapterWorkbench.vue / ScriptPanel.vue 里的 5 处 window.alert
  // 因此永远不会被这条门禁发现（假门禁）。改为递归扫描 src/ 全部 .ts/.vue。
  const nativeCalls: string[] = [];
  for (const f of walkSrc("src")) {
    const src = readFileSync(f, "utf-8");
    src.split("\n").forEach((line, i) => {
      // 注释行不算调用：说明性注释里会写反例（如"原实现用 window.prompt"）
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const blocked = line.match(/window\.(confirm|prompt|alert)\s*\(/g) ?? [];
      for (const b of blocked) nativeCalls.push(`${f}:${i + 1} ${b}`);
    });
  }
  assert(
    nativeCalls.length === 0,
    `全仓不得再出现原生阻塞弹层（无 role=dialog/焦点陷阱，且同步阻塞主线程）：\n  ${nativeCalls.join("\n  ")}`,
  );

  // ---- 自建模态（关于 / 大图预览）同样要有对话框语义与焦点管理 ----
  // 这两处此前只做 Esc + 点遮罩关闭，读屏不宣告对话框、Tab 会跑到背景页（见 F6）。
  for (const [name, file] of [
    ["AboutDialog.vue", "src/components/AboutDialog.vue"],
    ["AssetPreview.vue", "src/components/AssetPreview.vue"],
  ] as const) {
    const src = readFileSync(file, "utf-8");
    const maskLine = codeLineWith(src, "modal-mask") || codeLineWith(src, "asset-preview");
    assert(codeLineWith(src, 'role="dialog"').length > 0, `${name} 的弹层容器必须有 role=dialog`);
    assert(codeLineWith(src, 'aria-modal="true"').length > 0, `${name} 的弹层容器必须标记 aria-modal`);
    assert(codeLineWith(src, ":aria-labelledby").length > 0, `${name} 必须用 aria-labelledby 关联可访问名称`);
    assert(codeLineWith(src, "ref=\"maskEl\"").length > 0, `${name} 必须持有弹层容器引用（焦点收拢/陷阱的前提）`);
    assert(codeLineWith(src, 'tabindex="-1"').length > 0, `${name} 的弹层容器必须可聚焦`);
    assert(src.includes("focusables"), `${name} 必须有可聚焦元素集合（焦点陷阱）`);
    assert(/e\.shiftKey/.test(src), `${name} 的焦点陷阱必须处理 Shift+Tab 反向循环`);
    assert(src.includes("lastFocused"), `${name} 必须记录触发元素并把焦点收进弹层`);
    assert(/lastFocused\?\.focus/.test(src), `${name} 关闭后必须把焦点还给触发元素`);
    assert(maskLine.length > 0, `${name} 的遮罩元素定位失败（契约测试失效）`);
  }

  // ---- 语言下拉必须有可访问名称（否则读屏只念"组合框 简体中文"）----
  const langSelect = lineWith(app, "lang-select");
  assert(langSelect.includes("aria-label"), "语言下拉必须带 aria-label（否则无可访问名称）");
  assert(/t\(['"]界面语言['"]\)/.test(langSelect), "语言下拉的 aria-label 文案必须进四语词典（t('界面语言')）");

  // ---- 缩略图必须键盘可达（div + @click 对键盘用户等于不存在）----
  const asset = readFileSync("src/components/generate/result/AssetPanel.vue", "utf-8");
  const vb = readFileSync("src/components/VisualBiblePanel.vue", "utf-8");
  for (const [name, src] of [["AssetPanel.vue", asset], ["VisualBiblePanel.vue", vb]] as const) {
    assert(src.includes("thumbA11y"), `${name} 的缩略图必须走 thumbA11y（补 role/tabindex/Enter+Space）`);
  }
  const a11yHelper = asset.slice(asset.indexOf("function thumbA11y"));
  assert(a11yHelper.includes('role: "button"'), "缩略图必须声明 role=button");
  assert(a11yHelper.includes("tabindex"), "缩略图必须可 Tab 聚焦");
  assert(a11yHelper.includes('e.key !== " "' ), "缩略图必须响应空格键");

  // ---- JS 滚动必须尊重 reduce-motion ----
  const motion = readFileSync("src/utils/motion.ts", "utf-8");
  assert(motion.includes("prefers-reduced-motion"), "motion 工具必须读取系统的 reduce-motion 偏好");
  assert(motion.includes("instant"), "开启 reduce-motion 时必须用 instant 滚动");
  for (const f of ["src/pages/GeneratePage.vue", "src/components/generate/ResultSection.vue", "src/components/generate/result/VideoPanel.vue"]) {
    const src = readFileSync(f, "utf-8");
    assert(!/behavior:\s*"smooth"/.test(src), `${f} 仍有硬编码的平滑滚动，绕过 reduce-motion`);
  }

  // ---- 导出游戏文档语言/标题随界面语言变化 ----
  const i18nIndex = readFileSync("src/i18n/index.ts", "utf-8");
  const mainTs = readFileSync("src/main.ts", "utf-8");
  assert(i18nIndex.includes("syncDocumentLocale"), "必须提供 syncDocumentLocale");
  assert(i18nIndex.includes("document.documentElement.lang"), "syncDocumentLocale 必须设置 <html lang>");
  assert(i18nIndex.includes("document.title"), "syncDocumentLocale 必须设置窗口标题");
  assert(mainTs.includes("syncDocumentLocale()"), "挂载前必须调用一次，避免首帧语言错误");

  // ---- imageSizeMatches 是三态结果，禁止再用真值/取反判断（#1498）----
  // 它曾经返回 boolean，改成 "ok"|"mismatch"|"unknown" 后，任何 `(await …) ? x : y` 或
  // `if (!(await …))` 写法都会因"字符串恒为真"而永远走命中分支——尺寸校验静默失效，
  // 而且 TypeScript 不会报错（只报"始终为真"的 lint，本仓库没开）。
  // 这里逐行扫描：凡是调用点所在行，不能出现 `await …) ?` / `!(await …` / `(await …) &&` 形态。
  const SIZE_STATE_VALUES = ['"mismatch"', '"unknown"', '"ok"'];
  for (const file of ["src/core/images.ts", "src/stores/generate.ts"]) {
    const raw = readFileSync(file, "utf-8");
    // 去掉注释行：注释里会写反例说明，不能因注释而误报
    const code = raw
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const uses = code.split("imageSizeMatches(").length - 1;
    assert(uses > 0, `${file}: 应当仍在调用 imageSizeMatches（否则本契约失效）`);
    // 反例形态：调用结果被当成布尔
    assert(!/await[^;]*imageSizeMatches\([^;]*\)[^;]*\?/.test(code), `${file}: 三态结果不得参与三元真值判断`);
    assert(!/!\(await[^;]*imageSizeMatches/.test(code), `${file}: 三态结果不得直接取反`);
    assert(!/\(await[^;]*imageSizeMatches[^;]*\)\s*&&/.test(code), `${file}: 三态结果不得直接用于 &&`);
    // 正例要求：每个调用点附近都要显式比较三态值
    for (const value of SIZE_STATE_VALUES.slice(0, 2)) {
      // 至少出现 mismatch / unknown 中的一种比较
      if (value === '"mismatch"') {
        assert(code.includes(value), `${file}: 必须有显式的 "mismatch" 比较`);
      }
    }
  }

  console.log("=== 无障碍弹层 / 键盘可达 / reduce-motion / 文档语言 / 三态尺寸校验 契约测试通过 ===");
}

main();
