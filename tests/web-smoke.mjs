import { chromium } from "playwright";

const BASE = "http://localhost:5199";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

// 1. 页面加载
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
check("页面加载", (await page.title()).length > 0 || (await page.locator("body").innerText()).length > 0, (await page.title()) || "");
check("导航栏渲染", (await page.locator("body").innerText()).includes("导入") || (await page.locator("body").innerText()).includes("配置"));
check("无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

// 2. 页面内模块：虚拟 FS + 模板同步 + 代理 + 预览
const smoke = await page.evaluate(async () => {
  const out = {};
  try {
    // vfs 读写
    const vfs = await import("/src/utils/vfsWeb.ts");
    await vfs.vfsWriteTextFile("/app/exports/test/game/scene/a.txt", "hello-web");
    out.vfsRead = await vfs.vfsReadTextFile("/app/exports/test/game/scene/a.txt");
    out.vfsList = (await vfs.vfsListDir("/app/exports/test/game")).map((e) => e.name + (e.isDir ? "/" : ""));

    // 模板树同步（走 dev server）
    await vfs.vfsMkdirAll("/app/template");
    const tauri = await import("/src/utils/tauri.ts");
    const idx = await tauri.tauri.readTextFile("/app/template/index.html");
    out.tplHasHtml = idx.text.includes("<html") || idx.text.includes("<HTML");
    out.tplExists = await tauri.tauri.pathExists("/app/template/assets");
    out.tplList = (await tauri.tauri.listDir("/app/template")).map((e) => e.name).slice(0, 5);

    // 模板 → 项目复制（assembleProject 核心路径）
    await tauri.tauri.copyFile("/app/template/index.html", "/app/exports/test/index.html");
    out.copyOk = (await vfs.vfsReadTextFile("/app/exports/test/index.html")).includes("<html");

    // 配置持久化
    await tauri.tauri.writeConfig(JSON.stringify({ probe: 1 }));
    out.config = await tauri.tauri.readConfig();

    // HTTP 代理（真实 MiniMax，无效 key 应透传 401/200+1004 错误体）
    try {
      const res = await tauri.tauri.http({
        method: "POST",
        url: "https://api.minimaxi.com/v1/t2a_v2",
        headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "speech-2.8-hd" }),
      });
      const text = new TextDecoder().decode(Uint8Array.from(atob(res.bodyBase64), (c) => c.charCodeAt(0)));
      out.proxy = text.slice(0, 80);
    } catch (e) {
      out.proxy = "ERR " + e.message;
    }

    // 预览：zip 打包上传 → URL
    await vfs.vfsWriteTextFile("/app/exports/test/game/config.txt", "config");
    const pv = await tauri.tauri.startPreviewServer("/app/exports/test");
    out.previewUrl = pv.url;
  } catch (e) {
    out.fatal = e.message;
  }
  return out;
});

check("vfs 写读", smoke.vfsRead === "hello-web", smoke.vfsRead);
check("vfs 列目录", smoke.vfsList?.join(",") === "scene/", smoke.vfsList?.join(","));
check("模板 index.html 同步", smoke.tplHasHtml === true, "");
check("模板目录存在", smoke.tplExists === true, "");
check("模板列表", (smoke.tplList || []).length >= 4, smoke.tplList?.join(","));
check("模板文件复制", smoke.copyOk === true, "");
check("配置持久化", smoke.config === '{"probe":1}', smoke.config);
check("HTTP 代理透传", smoke.proxy?.includes("status_code"), smoke.proxy?.slice(0, 60));
check("预览上传 URL", smoke.previewUrl?.includes("/novelforge-preview/test/index.html"), smoke.previewUrl);
check("冒烟无致命错误", !smoke.fatal, smoke.fatal ?? "");

// 3. 预览 URL 可访问
if (smoke.previewUrl) {
  const resp = await page.request.get(smoke.previewUrl);
  check("预览页面 HTTP", resp.status() === 200, String(resp.status()));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
