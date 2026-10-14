import { lintProject } from "../src/core/lint";
import { tauri } from "../src/utils/tauri";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const DIR = (await mkdtemp(join(tmpdir(), "novelforge-lint-test-"))).replace(/\\/g, "/");
  await tauri.removePath(DIR).catch(() => {});
  // 构造项目：正常章节 + 一个引用缺失素材 + 一个坏语法 + 一个空章
  await tauri.mkdirAll(`${DIR}/game/scene`);
  await tauri.mkdirAll(`${DIR}/game/background`);
  await tauri.mkdirAll(`${DIR}/game/figure`);
  await tauri.mkdirAll(`${DIR}/game/vocal`);
  await tauri.mkdirAll(`${DIR}/game/bgm`);
  await tauri.mkdirAll(`${DIR}/game/video`);

  await tauri.writeTextFile(`${DIR}/game/scene/start.txt`, `changeScene:ch1.txt;`);
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch1.txt`,
    [
      `label:ch1_第一章;`,
      `changeBg:none -next;`,
      `changeBg:missing_bg.png -next;`,
      `林澈:你好 -missing_voice.mp3;`,
      `:正常旁白;`,
      // 天气粒子特效（pixiInit/pixiPerform）是 4.6.6 的正式指令，必须被白名单识别为指令：
      // 若落进台词分支会多算一句台词，落进错误分支会直接挡导出。
      `pixiInit;`,
      `pixiPerform:rain;`,
      `bad syntax line without semicolon`,
      ``,
    ].join("\n"),
  );
  await tauri.writeTextFile(`${DIR}/game/scene/ch2.txt`, `label:ch2_第二章;\nchangeBg:none;`);
  // 演出指令回归：filmMode 必须被识别为指令；setFilter 已从白名单移除（4.6.x 空实现且未文档化），
  // 必须报出「指令无效」而不是被当台词放行，也不能只落到泛化的「无法解析」。
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch3.txt`,
    [`label:ch3_第三章;`, `filmMode:true;`, `setFilter:{"oldFilm":0.35} -target=bg-main -next;`, `:旁白;`].join("\n"),
  );

  const report = await lintProject(DIR);

  console.log("errors:", report.errors.length, "warnings:", report.warnings.length);
  for (const e of report.errors) console.log("  ERR:", e.scope, e.message);
  for (const w of report.warnings) console.log("  WARN:", w.scope, w.message);

  // 素材缺失检测（背景 + 配音）
  assert(report.errors.some((e) => e.message.includes("missing_bg.png")), "应检出缺失背景");
  assert(report.errors.some((e) => e.message.includes("missing_voice.mp3")), "应检出缺失配音");
  // 坏语法检测
  assert(report.errors.some((e) => e.message.includes("无法解析")), "应检出坏语法");
  // 空章警告
  assert(report.warnings.some((w) => w.message.includes("没有任何台词")), "应警告空章节");
  // 演出指令识别：filmMode 与天气特效指令不得报错、不得计入台词
  assert(!report.errors.some((e) => e.scope.includes("ch3.txt") && e.message.includes("filmMode")), "filmMode 不应报错");
  assert(
    !report.errors.some((e) => e.message.includes("pixiInit") || e.message.includes("pixiPerform")),
    "pixiInit/pixiPerform 必须被白名单识别为指令（4.6.6 正式指令，否则会被当台词或直接挡导出）",
  );
  // setFilter 必须被拦下（4.6.x 空实现 + 未文档化）：既不能当台词，也不能只报「无法解析」
  assert(
    report.errors.some((e) => e.scope.includes("ch3.txt") && e.message.includes("setFilter") && e.message.includes("指令无效")),
    `setFilter 应报「指令无效」（滤镜请改 setTransform 同名键），实际：${report.errors.map((e) => e.message).join(" / ")}`,
  );
  assert(report.summary.lines === 3, `台词计数应为 3（ch1×2 + ch3×1），实际 ${report.summary.lines}`);

  // 修复后通过
  await tauri.writeFileBase64(`${DIR}/game/background/missing_bg.png`, Buffer.from("fake").toString("base64"));
  await tauri.writeFileBase64(`${DIR}/game/vocal/missing_voice.mp3`, Buffer.from("fake").toString("base64"));
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch1.txt`,
    [
      `label:ch1_第一章;`,
      `changeBg:none -next;`,
      `changeBg:missing_bg.png -next;`,
      `林澈:你好 -missing_voice.mp3;`,
      `:正常旁白;`,
    ].join("\n"),
  );
  const report2 = await lintProject(DIR);
  assert(!report2.errors.some((e) => e.message.includes("missing_")), "修复后不应有缺失素材错误");
  console.log("=== 导出检查（Lint）测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
