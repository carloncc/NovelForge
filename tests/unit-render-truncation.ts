/**
 * #1551 续：剧本 / config.txt 落盘路径上的截断必须走 safeSlice。
 *
 * 这三个函数的产物是**写到磁盘的 UTF-8 文本**，所以代理对劈开在这里的后果不是
 * 「少一个字符」而是「多一个 U+FFFD」——玩家会在游戏里直接看到「�」：
 *   comment()          -> ; ===== 第N章 <标题> ===== 注释行
 *   sanitizeLabel()    -> 各种显示标签
 *   cleanConfigValue() -> config.txt 的标题类值
 *
 * 这三个函数都是模块私有的，没法直接单测，所以这里校验**源码契约**：
 * 这三处必须是 safeSlice 而不是裸 .slice(0, N)。
 * 行为正确性由 tests/unit-safe-slice.ts 覆盖（它证明 safeSlice 本身不劈代理对）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SRC = readFileSync(join(process.cwd(), "src", "core", "render.ts"), "utf8");

/** 取出一个顶层函数的函数体源码（按第一个 { 到行首 } 粗略切） */
function bodyOf(name: string): string {
  const start = SRC.indexOf("function " + name + "(");
  assert(start >= 0, "找不到函数 " + name + "（#1551）");
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  throw new Error("函数 " + name + " 括号不闭合（#1551）");
}

function main(): void {
  // ① 三个落盘截断点必须走 safeSlice
  const cases: Array<[string, number]> = [
    ["comment", 80],
    ["sanitizeLabel", 30],
  ];
  for (const [fn, n] of cases) {
    const body = bodyOf(fn);
    assert(
      body.includes("safeSlice("),
      fn + " 必须用 safeSlice 截断（其产物会写进剧本文件，裸 slice 会劈开代理对产出 U+FFFD）（#1551）",
    );
    assert(
      !new RegExp("\\.slice\\(\\s*0\\s*,\\s*" + n + "\\s*\\)").test(body),
      fn + " 内不得残留裸 .slice(0, " + n + ")（#1551）",
    );
  }

  // cleanConfigValue 有两条分支，只有标题分支（非 isFile）需要截断
  const ccv = SRC.slice(SRC.indexOf("function cleanConfigValue("));
  const ccvBody = ccv.slice(0, ccv.indexOf("\n}") + 2);
  assert(
    ccvBody.includes("safeSlice(s, 60)"),
    "cleanConfigValue 的标题分支必须用 safeSlice(s, 60)——该值会写进 config.txt（#1551）",
  );
  assert(
    !/return s\.slice\(0, 60\)/.test(ccvBody),
    "cleanConfigValue 内不得残留 return s.slice(0, 60)（#1551）",
  );
  // 文件分支本来就不截断（1452 有意为之：截断会让 Title_img 指向不存在的路径）
  assert(
    ccvBody.includes("engineSafeFileName("),
    "cleanConfigValue 的文件分支必须仍走 engineSafeFileName（不截断，1452）（#1551）",
  );

  // ② render.ts 必须真的 import 了 safeSlice（否则上面断言会在别处炸）
  assert(
    /import \{ safeSlice \} from "\.\.\/utils\/text"/.test(SRC),
    "render.ts 必须 import safeSlice（#1551）",
  );


  // ③ script.ts 里写进 ChapterScript 的 description（会被 JSON.stringify 持久化到剧本缓存）
  const SCRIPT = readFileSync(join(process.cwd(), "src", "core", "script.ts"), "utf8");
  assert(
    SCRIPT.includes("description: safeSlice((hit as { text: string }).text, 40)"),
    "cg.description 必须用 safeSlice——它随 ChapterScript 落盘（#1551）",
  );
  assert(
    SCRIPT.includes("description: safeSlice(l.text, 50)"),
    "itemEvents[].description 必须用 safeSlice——它随 ChapterScript 落盘（#1551）",
  );
  assert(
    !/description: \(hit as \{ text: string \}\)\.text\.slice\(0, 40\)/.test(SCRIPT),
    "script.ts 内不得残留裸 slice 的 cg.description（#1551）",
  );
  assert(
    !/description: l\.text\.slice\(0, 50\)/.test(SCRIPT),
    "script.ts 内不得残留裸 slice 的 itemEvents description（#1551）",
  );

  console.log("=== 剧本/config 落盘截断契约通过（#1551：render 3 处 + script 2 处均走 safeSlice）===");
}

main();
