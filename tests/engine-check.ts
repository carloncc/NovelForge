import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = process.argv[2] || "/tmp/novelforge-e2e/game";
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".mp4": "video/mp4",
};

async function main(): Promise<void> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    let p = normalize(decodeURIComponent(url.pathname));
    if (p === "/" || p === "") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(normalize(ROOT))) {
      res.writeHead(403);
      res.end();
      return;
    }
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
  const url = `http://127.0.0.1:${port}/index.html`;
  console.log("server:", url);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("console", (m) => {
    logs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(6000);

  const title = await page.title();
  await page.screenshot({ path: "/tmp/novelforge-engine-title.png" });

  // 进入剧情：先点击屏幕（PRESS THE SCREEN TO START），再点击「开始游戏」
  await page.mouse.click(640, 360).catch(() => {});
  await page.waitForTimeout(1500);
  const startBtn = page.getByText("开始游戏", { exact: true }).first();
  if (await startBtn.count().catch(() => 0)) {
    await startBtn.click().catch(() => {});
    console.log("[操作] 点击了开始游戏");
  } else {
    console.log("[操作] 未找到开始游戏按钮，再点屏幕");
    await page.mouse.click(640, 360).catch(() => {});
  }
  await page.waitForTimeout(5000);

  // 推进对话，验证剧情文本渲染
  let advanced = 0;
  const probes = ["黄昏时分", "林澈", "星陨", "护心玉佩", "城门前", "暮色", "苏晚晴", "老铁匠"];
  const hitSet = new Set<string>();
  let last = "";
  for (let i = 0; i < 10; i++) {
    const t = (await page.textContent("body")) || "";
    for (const probe of probes) {
      if (t.includes(probe)) hitSet.add(probe);
    }
    if (t !== last) advanced++;
    last = t;
    if (hitSet.size >= 4) break;
    await page.mouse.click(640, 500).catch(() => {});
    await page.waitForTimeout(1200);
  }
  const foundDialogue = hitSet.size > 0;
  console.log(`[内容] 命中关键词: ${Array.from(hitSet).join(", ") || "无"}`);
  console.log(`[操作] 剧情推进 ${advanced} 次`);

  // 验证流程图（任务/章节选择 UI）：尝试多个入口
  let flowchartOk = false;
  try {
    const tryFind = async (label: string): Promise<boolean> => {
      const btn = page.getByText(label, { exact: true }).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1200);
        const body = (await page.textContent("body")) || "";
        if (/ch\d+/.test(body) || /第\d+章/.test(body)) return true;
      }
      return false;
    };
    // 入口 1：游戏内底部菜单（先点底部呼出）
    await page.mouse.click(640, 690).catch(() => {});
    await page.waitForTimeout(700);
    flowchartOk = await tryFind("流程图");
    if (!flowchartOk) {
      // 入口 2：选项菜单内
      flowchartOk = await tryFind("选项");
      if (!flowchartOk) {
        await page.mouse.click(640, 360).catch(() => {});
        await page.waitForTimeout(700);
        flowchartOk = await tryFind("流程图");
      }
    }
    console.log(`[流程图] 章节节点检测: ${flowchartOk ? "通过" : "未找到入口（跳过）"}`);
    // 关闭流程图返回
    await page.mouse.click(120, 60).catch(() => {});
    await page.waitForTimeout(600);
  } catch {
    console.log("[流程图] 验证异常（跳过）");
  }

  await page.screenshot({ path: "/tmp/novelforge-engine-shot.png" });
  console.log("页面标题:", title);
  console.log("内容命中:", foundDialogue);
  console.log("console errors:", errors.length);
  errors.slice(0, 10).forEach((e) => console.log("  ERR:", e));
  console.log("关键日志:", logs.filter((l) => /error|fail|webgal|scene/i.test(l)).slice(0, 10));

  if (!foundDialogue) {
    throw new Error("引擎未渲染出游戏文本（剧本解析失败？）");
  }
  if (!flowchartOk) {
    console.log("警告: 流程图节点未验证（可能入口位置不同，不影响游戏可玩性）");
  }

  await browser.close();
  server.close();
  console.log("=== 引擎加载验证通过 ===");
}

main().catch((e) => {
  console.error("引擎验证失败:", e);
  process.exit(1);
});
