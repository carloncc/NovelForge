import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VITE_PORT = 5199;
const BASE = `http://localhost:${VITE_PORT}`;
const SHOT_DIR = join(ROOT, "..", "docs", "screenshots");
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

async function waitForServer(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Vite did not start: ${url}`);
}

async function seedState(page, mode, outputDir) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(
    async ({ mode, outputDir, png }) => {
      const { projectState } = await import("/src/stores/project.ts");
      const { tauri } = await import("/src/utils/tauri.ts");
      const { saveVisualBible, computeProjectVisualBibleFingerprint } = await import("/src/core/visualBible.ts");

      await tauri.removePath(outputDir).catch(() => {});
      await tauri.mkdirAll(outputDir);

      const novel = {
        sourcePath: `${outputDir}/novel.txt`,
        fileName: "novel.txt",
        encoding: "UTF-8",
        fullText: "Chapter one\nA rainy neon city.",
        chapters: [{ index: 0, title: "One", text: "Chapter one\nA rainy neon city.", charCount: 31, enabled: true }],
      };
      const characters = [
        {
          id: "alice",
          name: "Alice",
          appearance: "silver hair",
          clothing: "black coat",
          personality: "calm",
          voiceDesc: "soft",
          imagePrompt: "alice, silver hair, black coat",
          threeViewPrompt: "alice character turnaround",
          color: "#ffffff",
        },
        {
          id: "bob",
          name: "Bob",
          appearance: "brown hair",
          clothing: "leather jacket",
          personality: "warm",
          voiceDesc: "steady",
          imagePrompt: "bob, brown hair, leather jacket",
          threeViewPrompt: "bob character turnaround",
          color: "#222222",
        },
      ];
      projectState.novel = novel;
      projectState.outputDir = outputDir;
      projectState.options.useImage = true;
      projectState.lastResult = {
        meta: {
          title: "Visual Bible Test",
          gameKey: "visual_bible_test",
          chapterCount: 1,
          charCount: characters.length,
          sceneCount: 0,
          lineCount: 0,
          outputDir,
          webgalVersion: "4.6.3",
          generatedAt: new Date().toISOString(),
        },
        cards: { title: "Visual Bible Test", characters, scenes: [], items: [] },
        chapters: [],
        assets: {},
        cost: {
          llmTokens: 0,
          imageCount: 0,
          ttsChars: 0,
          llmCostYuan: 0,
          imageCostYuan: 0,
          ttsCostYuan: 0,
        },
        failedTasks: [],
      };

      if (mode === "missing") {
        projectState.visualBible = null;
        return;
      }

      const artifactDir = `${outputDir}/.novel2vn/visual-bible`;
      const stylePath = mode === "reference_image" ? "style-reference.png" : "style-sample.png";
      await tauri.writeFileBase64(`${artifactDir}/${stylePath}`, png);
      for (const character of characters) {
        await tauri.writeFileBase64(`${artifactDir}/threeview_${character.id}.png`, png);
      }

      const bible = {
        version: 1,
        status: "draft",
        styleSource: mode,
        styleDescription: "cinematic anime, cool palette, soft rim light",
        styleReferencePath: stylePath,
        characters: Object.fromEntries(characters.map((character) => [
          character.id,
          {
            threeViewPath: `threeview_${character.id}.png`,
            prompt: `${character.id} character turnaround`,
            approved: false,
            revision: 1,
            sourceRevision: 0,
            sheetSourceRevision: 0,
          },
        ])),
        inputFingerprint: "pending",
      };
      bible.inputFingerprint = await computeProjectVisualBibleFingerprint(outputDir, bible, novel, characters);
      await saveVisualBible(outputDir, bible, characters);
      projectState.visualBible = bible;
    },
    { mode, outputDir, png: PNG_B64 },
  );
}

async function openBibleTab(page) {
  await page.getByText("生成项目", { exact: true }).first().click();
  await page.locator(".tabs .tab", { hasText: "视觉圣经" }).click();
  await page.waitForSelector(".vb-panel");
}

async function inspectPage(page, label) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await openBibleTab(page);
  await page.waitForTimeout(400);
  const layout = await page.evaluate(() => {
    const main = document.querySelector(".main");
    return {
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  return { errors, layout };
}

async function runMissingState(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await seedState(page, "missing", "/app/exports/visual-bible-missing");
  const { errors, layout } = await inspectPage(page, "missing-1280");
  const createButton = page.getByRole("button", { name: "创建视觉圣经草稿" });
  check("missing state shows both style sources", await page.locator(".vb-source-option").count() === 2);
  check("missing state default novel-analysis allows draft creation", await createButton.isEnabled());
  await page.locator('.vb-source-option input[value="reference_image"]').check();
  check("missing state disables create for reference-image until reference selected", await createButton.isDisabled());
  check("missing state has no horizontal overflow", layout.docOverflow <= 0 && layout.mainOverflow <= 0, JSON.stringify(layout));
  check("missing state has no runtime errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: join(SHOT_DIR, "visual-bible-missing-1280.png"), fullPage: true });
  await page.close();
}

async function runReviewState(browser, viewport, mode) {
  const page = await browser.newPage({ viewport });
  const outputDir = `/app/exports/visual-bible-${mode}-${viewport.width}x${viewport.height}`;
  await seedState(page, mode, outputDir);
  const { errors, layout } = await inspectPage(page, `${mode}-${viewport.width}`);
  const rowCount = await page.locator(".vb-character-row").count();
  const approve = page.getByRole("button", { name: "批准并续跑生成" });
  check(`${mode} renders all character rows`, rowCount === 2, `rows=${rowCount}`);
  check(`${mode} previews render`, await page.locator(".vb-thumb").count() >= 4);
  check(`${mode} approval starts disabled`, await approve.isDisabled());
  check(`${mode} has no horizontal overflow`, layout.docOverflow <= 0 && layout.mainOverflow <= 0, JSON.stringify(layout));
  check(`${mode} has no runtime errors`, errors.length === 0, errors.slice(0, 3).join(" | "));

  await page.getByRole("button", { name: "确认此角色" }).first().click();
  await page.getByRole("button", { name: "确认此角色" }).nth(1).click();
  await page.waitForTimeout(300);
  check(`${mode} approval enables after all characters accepted`, await approve.isEnabled());

  await page.screenshot({ path: join(SHOT_DIR, `visual-bible-${mode}-${viewport.width}.png`), fullPage: true });
  await page.close();
}

const viteBin = join(ROOT, "..", "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteBin, "--port", String(VITE_PORT), "--strictPort"], {
  cwd: join(ROOT, ".."),
  stdio: ["ignore", "ignore", "inherit"],
});
vite.on("error", (error) => console.error("Vite spawn error", error));
vite.on("exit", (code, signal) => {
  if (code !== null && code !== 0) console.error(`Vite exited early with code ${code} signal ${signal}`);
});

try {
  await waitForServer(BASE);
  await mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  await runMissingState(browser);
  await runReviewState(browser, { width: 1280, height: 800 }, "novel_analysis");
  await runReviewState(browser, { width: 900, height: 700 }, "reference_image");
  await browser.close();

  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  vite.kill();
}
