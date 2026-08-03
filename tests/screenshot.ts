import { chromium } from "playwright";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // 导入页
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "docs/screenshots/import.png" });
  // 配置页
  await page.getByText("API 配置", { exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "docs/screenshots/config.png" });
  // 生成页
  await page.getByText("生成项目", { exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "docs/screenshots/generate.png" });
  await browser.close();
  console.log("screenshots done");
}
main().catch((e) => { console.error(e); process.exit(1); });
