import { unifiedImage, unifiedTts, buildRequestBody, getByPath, joinUrl, setByPath, buildMultipartBody } from "../src/api/universal";
import { getTemplate, resolveTemplate } from "../src/api/templates";
import type { ApiConfig } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function makeCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: "t1",
    name: "test",
    baseUrl: "https://api.test.com",
    apiKey: "sk-test",
    model: "m1",
    ...over,
  };
}

interface MockRoute {
  match: (url: string, body: unknown) => boolean;
  respond: (url: string, body: unknown) => { status: number; contentType: string; body: unknown };
}

const routes: MockRoute[] = [];

function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  let body: unknown = null;
  if (init?.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = String(init.body);
    }
  }
  for (const r of routes) {
    if (r.match(url, body)) {
      const res = r.respond(url, body);
      const raw = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      return Promise.resolve(
        new Response(raw, {
          status: res.status,
          headers: { "Content-Type": res.contentType },
        }),
      );
    }
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

async function main(): Promise<void> {
  globalThis.fetch = mockFetch as typeof fetch;

  // ---------- 1. openai-image 请求体与响应 ----------
  routes.length = 0;
  routes.push({
    match: (u, b) => u.includes("/v1/images/generations") && (b as any).response_format === "b64_json",
    respond: () => ({
      status: 200,
      contentType: "application/json",
      body: { data: [{ b64_json: "QUJDRA==" }] }, // ABCD
    }),
  });
  const img1 = await unifiedImage(makeCfg(), getTemplate("openai-image")!, {
    prompt: "cat",
    width: 1024,
    height: 1024,
  });
  assert(img1.dataB64 === "QUJDRA==", "openai-image b64 解析失败");
  assert(img1.mime === "image/png", "openai-image mime 错误");

  // base_url 带 /v1 时 URL 拼接正确（不产生 /v1/v1）
  const url1 = joinUrl("https://api.test.com/v1", "/v1/images/generations");
  assert(url1 === "https://api.test.com/v1/images/generations", `joinUrl 失败: ${url1}`);
  const url2 = joinUrl("https://api.test.com", "/v1/images/generations");
  assert(url2 === "https://api.test.com/v1/images/generations", `joinUrl 失败: ${url2}`);

  // ---------- 2. minimax-image URL 响应（自动下载） ----------
  routes.length = 0;
  routes.push({
    match: (u) => u.includes("/v1/image_generation"),
    respond: () => ({
      status: 200,
      contentType: "application/json",
      body: { data: { image_urls: ["https://img.test/x.png"] }, base_resp: { status_code: 0 } },
    }),
  });
  routes.push({
    match: (u) => u === "https://img.test/x.png",
    respond: () => ({ status: 200, contentType: "image/png", body: "PNGDATA" }),
  });
  const img2 = await unifiedImage(makeCfg(), getTemplate("minimax-image")!, { prompt: "cat", width: 1280, height: 720 });
  assert(img2.dataB64 === Buffer.from("PNGDATA").toString("base64"), "minimax-image url 下载失败");
  assert(img2.mime === "image/png", "minimax-image mime 错误");

  // ---------- 3. minimax-tts HEX 解码 ----------
  routes.length = 0;
  routes.push({
    match: (u, b) => u.includes("/v1/t2a_v2") && (b as any).voice_setting?.voice_id === "male-qn-qingse",
    respond: () => ({
      status: 200,
      contentType: "application/json",
      body: { data: { audio: Buffer.from("HEXAUDIO").toString("hex"), status: 2 }, base_resp: { status_code: 0 } },
    }),
  });
  const tts1 = await unifiedTts(makeCfg({ adapter: "minimax-tts" }), getTemplate("minimax-tts")!, {
    text: "你好",
    voice: "male-qn-qingse",
  });
  assert(tts1.dataB64 === Buffer.from("HEXAUDIO").toString("base64"), "minimax-tts hex 解码失败");
  assert(tts1.mime === "audio/mpeg", "minimax-tts mime 错误");

  // ---------- 4. dashscope async 轮询 ----------
  routes.length = 0;
  let polls = 0;
  routes.push({
    match: (u, b) => u.includes("/image-synthesis") && (b as any).model === "wanx-v1",
    respond: () => ({
      status: 200,
      contentType: "application/json",
      body: { output: { task_id: "task-123", task_status: "PENDING" } },
    }),
  });
  routes.push({
    match: (u) => u.includes("/tasks/task-123"),
    respond: () => {
      polls++;
      if (polls === 1) {
        return { status: 200, contentType: "application/json", body: { output: { task_status: "RUNNING" } } };
      }
      return {
        status: 200,
        contentType: "application/json",
        body: { output: { task_status: "SUCCEEDED", results: [{ url: "https://oss.test/a.png" }] } },
      };
    },
  });
  routes.push({
    match: (u) => u === "https://oss.test/a.png",
    respond: () => ({ status: 200, contentType: "image/png", body: "OSSIMG" }),
  });
  const img3 = await unifiedImage(makeCfg({ baseUrl: "https://ws.cn-beijing.maas.aliyuncs.com", adapter: "dashscope-image", model: "wanx-v1" }), getTemplate("dashscope-image")!, {
    prompt: "山",
    width: 1024,
    height: 1024,
  });
  assert(polls === 2, `轮询次数异常: ${polls}`);
  assert(img3.dataB64 === Buffer.from("OSSIMG").toString("base64"), "dashscope 异步结果下载失败");

  // ---------- 5. dashscope 任务失败 ----------
  routes.length = 0;
  routes.push({
    match: (u) => u.includes("/image-synthesis"),
    respond: () => ({ status: 200, contentType: "application/json", body: { output: { task_id: "t-fail" } } }),
  });
  routes.push({
    match: (u) => u.includes("/tasks/t-fail"),
    respond: () => ({ status: 200, contentType: "application/json", body: { output: { task_status: "FAILED" } } }),
  });
  let failed = false;
  try {
    await unifiedImage(makeCfg({ adapter: "dashscope-image", model: "wanx-v1" }), getTemplate("dashscope-image")!, { prompt: "x" });
  } catch {
    failed = true;
  }
  assert(failed, "任务失败应抛错");

  // ---------- 6. openai-tts 二进制响应 ----------
  routes.length = 0;
  routes.push({
    match: (u, b) => u.includes("/v1/audio/speech") && (b as any).voice === "alloy",
    respond: () => ({ status: 200, contentType: "audio/mpeg", body: "MP3RAW" }),
  });
  const tts2 = await unifiedTts(makeCfg(), getTemplate("openai-tts")!, { text: "hi", voice: "alloy" });
  assert(tts2.dataB64 === Buffer.from("MP3RAW").toString("base64"), "openai-tts 二进制响应失败");
  assert(tts2.mime === "audio/mpeg", "openai-tts mime 错误");

  // ---------- 7. 自定义模板优先于预置 ----------
  const customCfg = makeCfg({
    adapter: "openai-image",
    extra: {
      customTemplate: JSON.stringify({
        id: "my-image",
        name: "自定义",
        capability: "image",
        mode: "sync",
        endpoint: "/custom/generate",
        requestMap: { model: "$model", prompt: "$prompt" },
        response: { path: "data", encoding: "base64", mime: "image/png" },
      }),
    },
  });
  const resolved = resolveTemplate(customCfg);
  assert(resolved?.endpoint === "/custom/generate", "自定义模板未生效");

  // ---------- 8. 请求体构造（嵌套字段） ----------
  const body = buildRequestBody(getTemplate("dashscope-tts")!, {
    model: "cosyvoice-v2",
    text: "你好",
    voice: "longxiaochun",
    format: "mp3",
  });
  assert((body as any).input.text === "你好", "嵌套 input.text 构造失败");
  assert((body as any).parameters.voice === "longxiaochun", "嵌套 parameters.voice 构造失败");

  // ---------- 9. getByPath ----------
  assert(getByPath({ a: { b: [{ c: 42 }] } }, "a.b[0].c") === 42, "getByPath 数组路径失败");
  assert(getByPath({ data: { image_urls: ["x"] } }, "data.image_urls")?.[0] === "x", "getByPath 失败");

  // ---------- 10. Gemini：endpoint {model} 占位 + 数组路径构造 + inlineData 提取 ----------
  routes.length = 0;
  let geminiUrl = "";
  let geminiBody: any = null;
  routes.push({
    match: (u, b) => {
      geminiUrl = u;
      geminiBody = b;
      return u.includes("/v1beta/models/") && u.endsWith(":generateContent");
    },
    respond: () => ({
      status: 200,
      contentType: "application/json",
      body: {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: "R0lOR0FOAA==" } }],
            },
          },
        ],
      },
    }),
  });
  const geminiCfg = makeCfg({
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.0-flash-exp",
  });
  const img4 = await unifiedImage(geminiCfg, getTemplate("gemini-image")!, { prompt: "星空", width: 1024, height: 1024 });
  assert(img4.dataB64 === "R0lOR0FOAA==", "gemini inlineData 提取失败");
  assert(img4.mime === "image/png", "gemini mime 错误");
  assert(geminiUrl === "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent", `gemini URL 错误: ${geminiUrl}`);
  assert(geminiBody.contents[0].parts[0].text === "星空", "gemini 数组路径构造失败");
  assert(JSON.stringify(geminiBody.generationConfig.responseModalities) === JSON.stringify(["IMAGE"]), "gemini 常量数组失败");

  // ---------- 11. Stability：multipart form + 原始二进制响应 + Authorization 头 ----------
  routes.length = 0;
  let stabHeaders: Record<string, string> = {};
  let stabBody = "";
  routes.push({
    match: (u, b) => {
      stabBody = typeof b === "string" ? b : JSON.stringify(b);
      return u.includes("/v1/generation/");
    },
    respond: () => ({ status: 200, contentType: "image/png", body: "PNGRAW2" }),
  });
  const stabCfg = makeCfg({
    baseUrl: "https://api.stability.ai",
    apiKey: "sk-stab",
    model: "stable-image-core",
    adapter: "stability-image",
  });
  const img5 = await unifiedImage(stabCfg, getTemplate("stability-image")!, { prompt: "龙", width: 1024, height: 1024 });
  assert(img5.dataB64 === Buffer.from("PNGRAW2").toString("base64"), "stability 二进制响应失败");
  assert(stabBody.includes('name="prompt"') && stabBody.includes("龙"), "stability form 字段缺失");
  assert(stabBody.includes("multipart/form-data") === false, "form body 不应含 content-type 头");

  // ---------- 12. 错误信息提取 ----------
  routes.length = 0;
  routes.push({
    match: () => true,
    respond: () => ({
      status: 400,
      contentType: "application/json",
      body: { base_resp: { status_code: 1004, status_message: "模型不存在或已下线" } },
    }),
  });
  let gemErr = "";
  try {
    await unifiedImage(makeCfg(), getTemplate("openai-image")!, { prompt: "x" });
  } catch (e) {
    gemErr = (e as Error).message;
  }
  assert(gemErr.includes("模型不存在或已下线"), `错误提取失败: ${gemErr}`);

  // ---------- 13. setByPath 数组创建 ----------
  const deep = {};
  setByPath(deep, "contents[0].parts[0].text", "hello");
  assert((deep as any).contents[0].parts[0].text === "hello", "setByPath 数组创建失败");

  // ---------- 14. buildMultipartBody ----------
  const mp = buildMultipartBody({ prompt: "a", n: 2 });
  assert(mp.contentType.includes("multipart/form-data; boundary="), "multipart boundary 缺失");
  assert(mp.body.includes('name="n"') && mp.body.includes("\r\n2\r\n"), "multipart 字段序列化错误");
  assert(mp.body.endsWith("--\r\n"), "multipart 结尾错误");

  console.log("=== 通用适配器引擎测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
