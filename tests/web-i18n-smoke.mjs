import { chromium } from "playwright";

const BASE = "http://localhost:5199";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const browser = await chromium.launch();

// ---------- 1. 英文系统语言 → 默认英文界面 ----------
const ctxEn = await browser.newContext({ locale: "en-US" });
const pageEn = await ctxEn.newPage();
const errors = [];
pageEn.on("pageerror", (e) => errors.push(e.message));
await pageEn.goto(BASE, { waitUntil: "networkidle" });
await pageEn.waitForTimeout(1500);
const enBody = await pageEn.locator("body").innerText();
check("en 系统语言 → 界面英文", enBody.includes("Import") && enBody.includes("Config") && enBody.includes("Export"), "");
check("en 界面无残留中文导航", !enBody.includes("导入小说"), "");
check("en 无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));

// ---------- 2. 中文系统语言 → 默认中文界面 ----------
const ctxZh = await browser.newContext({ locale: "zh-CN" });
const pageZh = await ctxZh.newPage();
await pageZh.goto(BASE, { waitUntil: "networkidle" });
await pageZh.waitForTimeout(1200);
const zhBody = await pageZh.locator("body").innerText();
check("zh-CN 系统语言 → 界面中文", zhBody.includes("导入小说") && zhBody.includes("生成项目"), "");

// ---------- 3. 手动切换到日语 ----------
const pageSwitch = await ctxEn.newPage();
await pageSwitch.goto(BASE, { waitUntil: "networkidle" });
await pageSwitch.waitForTimeout(1200);
await pageSwitch.locator(".lang-select").selectOption("ja");
await pageSwitch.waitForTimeout(600);
const jaBody = await pageSwitch.locator("body").innerText();
check("切换到日语", jaBody.includes("小説をインポート") || jaBody.includes("インポート"), "");
check("日语导航渲染", !jaBody.includes("Import Novel"), "");

// ---------- 4. 切换到繁體中文 ----------
await pageSwitch.locator(".lang-select").selectOption("zh-TW");
await pageSwitch.waitForTimeout(600);
const twBody = await pageSwitch.locator("body").innerText();
check("切换到繁體中文", twBody.includes("匯入小說"), "");
check("繁体界面渲染", twBody.includes("API 設定") || twBody.includes("API 配置"), "");

// ---------- 5. 切换到韩语 ----------
await pageSwitch.locator(".lang-select").selectOption("ko");
await pageSwitch.waitForTimeout(600);
const koBody = await pageSwitch.locator("body").innerText();
check("切换到한국어", koBody.includes("소설 가져오기") || koBody.includes("가져오기"), "");

// ---------- 6. 语言持久化（刷新后保持） ----------
await pageSwitch.reload({ waitUntil: "networkidle" });
await pageSwitch.waitForTimeout(1200);
const koAfter = await pageSwitch.locator("body").innerText();
check("刷新后语言保持（localStorage）", koAfter.includes("가져오기") || koAfter.includes("설정"), "");

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
