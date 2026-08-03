import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
const ROOT = "/root/my_project/game";
const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain" };
async function main() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    let p = normalize(decodeURIComponent(url.pathname));
    if (p === "/" || p === "") p = "/index.html";
    const file = join(ROOT, p);
    try { const data = await readFile(file); res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" }); res.end(data); } catch { res.writeHead(404); res.end("nf"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const fontResponses: { url: string; status: number; ctype: string; size: number }[] = [];
  page.on("response", (resp) => {
    if (/\.ttf/.test(resp.url())) {
      fontResponses.push({ url: resp.url().split("/").pop() || "", status: resp.status(), ctype: resp.headers()["content-type"] || "", size: Number(resp.headers()["content-length"] || 0) });
    }
  });
  page.on("console", (m) => {
    const t = m.text();
    if (/font|ttf|404|failed/i.test(t)) console.log("[console]", m.type(), t.slice(0, 150));
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.mouse.click(640, 360);
  await page.waitForTimeout(1200);
  await page.getByText("开始游戏", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(4000);
  const fontState = await page.evaluate(async () => {
    const results: Record<string, string> = {};
    for (const name of ["资源圆体", "思源宋体", "WebgalUI"]) {
      try {
        const ok = await (document as any).fonts.check(`16px "${name}"`, "中");
        results[name] = ok ? "LOADED" : "NOT_LOADED";
      } catch (e) {
        results[name] = "ERR " + (e as Error).message;
      }
    }
    const loadedFonts = await (document as any).fonts.ready.then(() => Array.from((document as any).fonts).map((f: any) => f.family).slice(0, 10));
    return { results, loadedFonts };
  });
  console.log("字体请求:", JSON.stringify(fontResponses, null, 1));
  console.log("document.fonts:", JSON.stringify(fontState, null, 1));
  await browser.close(); server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
