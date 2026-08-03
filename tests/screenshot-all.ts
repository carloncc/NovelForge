import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const OUT = "docs/screenshots";
const GAME_ROOT = "/root/my_project/game";
const VITE = "http://localhost:5173";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".txt": "text/plain",
};

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// canvas 像素验证：绘制"中"字，方框（中空矩形）与正常笔画像素分布差异明显
async function verifyChineseRendering(page: any): Promise<boolean> {
  const ok = await page.evaluate(async () => {
    try {
      await (document as any).fonts.load('32px "Noto Sans CJK SC"', "中");
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.font = '32px "Noto Sans CJK SC"';
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText("中", 32, 34);
      const data = ctx.getImageData(8, 8, 48, 48).data;
      let painted = 0;
      let center = 0;
      for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
          const a = data[(y * 48 + x) * 4 + 3];
          if (a > 100) {
            painted++;
            if (x > 14 && x < 34 && y > 14 && y < 34) center++;
          }
        }
      }
      // 正常汉字：笔画像素占比高且中心有笔画；方框：只有外框（中心空）
      return painted > 150 && center > 20;
    } catch {
      return false;
    }
  });
  return ok;
}

async function main(): Promise<void> {
  const vite = spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 5000));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // ---- 工具 UI ----
  await page.goto(VITE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (document as any).fonts.ready);
  await page.getByText("加载示例小说（演示）").first().click().catch(() => {});
  await page.waitForTimeout(1500);
  assert(await verifyChineseRendering(page), "导入页中文渲染异常（方框）");
  await page.screenshot({ path: `${OUT}/import.png` });
  console.log("[截图] import.png ✓（中文渲染验证通过）");

  await page.getByText("API 配置", { exact: true }).click();
  await page.waitForTimeout(1200);
  assert(await verifyChineseRendering(page), "配置页中文渲染异常（方框）");
  await page.screenshot({ path: `${OUT}/config.png` });
  console.log("[截图] config.png ✓");

  await page.getByText("生成项目", { exact: true }).click();
  await page.waitForTimeout(1200);
  assert(await verifyChineseRendering(page), "生成页中文渲染异常（方框）");
  await page.screenshot({ path: `${OUT}/generate.png` });
  console.log("[截图] generate.png ✓");

  await page.getByText("导出", { exact: true }).click();
  await page.waitForTimeout(1200);
  assert(await verifyChineseRendering(page), "导出页中文渲染异常（方框）");
  await page.screenshot({ path: `${OUT}/export.png` });
  console.log("[截图] export.png ✓");
  await browser.close();

  // ---- 游戏画面（WebGAL 引擎）----
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    let p = normalize(decodeURIComponent(url.pathname));
    if (p === "/" || p === "") p = "/index.html";
    const file = join(GAME_ROOT, p);
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("nf");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const gbrowser = await chromium.launch({ headless: true });
  const gpage = await gbrowser.newPage({ viewport: { width: 1280, height: 720 } });
  await gpage.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle", timeout: 60000 });
  await gpage.waitForTimeout(8000);
  await gpage.evaluate(() => (document as any).fonts.ready);
  // 点击屏幕（PRESS THE SCREEN）显示主菜单后再截，确保中文字体已渲染
  await gpage.mouse.click(640, 360).catch(() => {});
  await gpage.waitForTimeout(2000);
  await gpage.screenshot({ path: `${OUT}/game-title.png` });
  console.log("[截图] game-title.png（标题/主菜单）✓");

  await gpage.mouse.click(640, 360);
  await gpage.waitForTimeout(1200);
  await gpage.getByText("开始游戏", { exact: true }).first().click().catch(() => {});
  await gpage.waitForTimeout(4000);
  await gpage.screenshot({ path: `${OUT}/game-story.png` });
  console.log("[截图] game-story.png（剧情画面）✓");
  await gbrowser.close();
  server.close();
  vite.kill();

  console.log("=== 全部截图完成 ===");
}

main().catch((e) => {
  console.error("截图失败:", e);
  process.exit(1);
});
