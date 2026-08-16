import { createServer } from "vite";

const DEV_URL = "http://localhost:5173";

async function hasRunningNovelForgeServer() {
  try {
    const response = await fetch(DEV_URL, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const html = await response.text();
    return html.includes('/@vite/client') && html.includes('<title>NovelForge');
  } catch {
    return false;
  }
}

if (await hasRunningNovelForgeServer()) {
  console.log(`NovelForge dev server is already running at ${DEV_URL}; reusing it.`);
} else {
  const server = await createServer();
  await server.listen();
  server.printUrls();
}
