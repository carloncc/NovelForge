import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 5201;
const base = `http://localhost:${port}`;
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], {
  cwd: process.cwd(),
  stdio: "ignore",
});

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/tests/fixtures/lazy-thumb.html`)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite did not start");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${base}/tests/fixtures/lazy-thumb.html`);
  await page.locator(".lazy-thumb img").waitFor();
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.locator(".lazy-thumb-placeholder").waitFor();
  await page.evaluate(() => window.lazyThumbTest.clear());
  await page.waitForTimeout(300);
  const reads = await page.evaluate(() => window.lazyThumbTest.reads());
  if (reads !== 1) throw new Error(`offscreen thumbnail reloaded after eviction: reads=${reads}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".lazy-thumb img").waitFor();
  const readsAfterReturn = await page.evaluate(() => window.lazyThumbTest.reads());
  if (readsAfterReturn !== 2) throw new Error(`thumbnail did not reload on return: reads=${readsAfterReturn}`);
  console.log("PASS offscreen thumbnail stays evicted until it re-enters the viewport");
} finally {
  await browser?.close();
  vite.kill();
}
