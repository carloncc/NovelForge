import { zhTW } from "../src/i18n/zh-TW";
import { en } from "../src/i18n/en";
import { ja } from "../src/i18n/ja";
import { ko } from "../src/i18n/ko";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const DICTS: Record<string, Record<string, string>> = { "zh-TW": zhTW, en, ja, ko };

/** 与 src/i18n/index.ts 的 t() 同口径的占位符插值（此处内联，避免依赖 DOM/currentLang） */
function fill(template: string, params: Record<string, string | number>): string {
  let out = template;
  for (const [k, v] of Object.entries(params)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return out;
}

function main(): void {
  // #1476 回归：章节序数必须走单条整句键。
  // 旧实现用两个碎片键拼句：`${t("第")}${n}${t("章")}`。t() 以中文原文为 key，
  // 而「章」在计数语境（"3 章" → en "3 chapters"）与序数语境（"第 3 章" → en "Chapter 3"）
  // 需要不同的译文，一个键只能给一个值——英文界面实测会输出 "Chapter 4chapters"。
  const ORDINAL = "第 {n} 章";
  const ORDINAL_WITH_TITLE = "第 {n} 章 {title}";
  for (const [lang, dict] of Object.entries(DICTS)) {
    for (const key of [ORDINAL, ORDINAL_WITH_TITLE]) {
      const value = dict[key];
      assert(typeof value === "string" && value.length > 0, `${lang} 缺少章节序数词条「${key}」`);
      assert(value.includes("{n}"), `${lang} 的「${key}」丢了 {n} 占位符：${value}`);
    }
    assert(dict[ORDINAL_WITH_TITLE].includes("{title}"), `${lang} 的「${ORDINAL_WITH_TITLE}」丢了 {title} 占位符`);
    // 译文不得再自我拼接碎片键的价值：序数译文里不应出现「中文的『第』+数字」这种半成品
    const filled = fill(dict[ORDINAL], { n: 4 });
    assert(!filled.includes("{n}"), `${lang}「${ORDINAL}」插值后仍残留 {n}：${filled}`);
    assert(filled.trim().length > 0, `${lang}「${ORDINAL}」插值后为空`);
  }

  // 关键回归断言：英文序数译文不能是计数译文的拼接
  assert(en["章"] === "chapters", `en「章」应为计数用词 chapters，实际 ${en["章"]}`);
  assert(
    !fill(en[ORDINAL], { n: 4 }).includes(en["章"]),
    `英文序数「${fill(en[ORDINAL], { n: 4 })}」不应包含计数词「${en["章"]}」——这正是 "Chapter 4chapters" 的成因`,
  );
  assert(
    fill(en[ORDINAL], { n: 4 }) === "Chapter 4",
    `英文「${ORDINAL}」应插值为 Chapter 4，实际 ${fill(en[ORDINAL], { n: 4 })}`,
  );
  assert(
    fill(en[ORDINAL_WITH_TITLE], { n: 4, title: "Awakening" }) === "Chapter 4: Awakening",
    `英文带标题序数插值错误：${fill(en[ORDINAL_WITH_TITLE], { n: 4, title: "Awakening" })}`,
  );
  // 日/韩的中文数字与「第」位置不同，确保没有照抄中文写法
  assert(fill(ja[ORDINAL], { n: 4 }) === "第4章", `日文序数插值错误：${fill(ja[ORDINAL], { n: 4 })}`);
  assert(fill(ko[ORDINAL], { n: 4 }) === "4장", `韩文序数插值错误：${fill(ko[ORDINAL], { n: 4 })}`);

  console.log("=== 章节序数整句键（#1476 回归）测试通过 ===");
}

main();
