import { updateAssetMap } from "../src/core/assetMap";
import { tauri } from "../src/utils/tauri";

const DIR = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-asset-map`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testConcurrentUpdatesPreserveMappings(): Promise<void> {
  await Promise.all([
    updateAssetMap(DIR, (assets) => { assets.bg.room = "room.png"; }),
    updateAssetMap(DIR, (assets) => { assets.item.key = "key.png"; }),
  ]);
  const persisted = JSON.parse((await tauri.readTextFile(`${DIR}/.novel2vn/assets.json`)).text);
  assert(persisted.bg.room === "room.png" && persisted.item.key === "key.png", "concurrent asset updates must preserve both mappings");
}

async function testWriteFailureReachesCaller(): Promise<void> {
  const originalWrite = tauri.writeTextFile;
  tauri.writeTextFile = async () => { throw new Error("injected asset-map write failure"); };
  try {
    let writeRejected = false;
    try {
      await updateAssetMap(DIR, (assets) => { assets.cg.scene = "scene.png"; });
    } catch (error) {
      writeRejected = error instanceof Error && error.message.includes("asset-map write failure");
    }
    assert(writeRejected, "asset-map persistence failures must reach the caller");
  } finally {
    tauri.writeTextFile = originalWrite;
  }
}

async function main(): Promise<void> {
  await tauri.removePath(DIR).catch(() => {});
  await tauri.mkdirAll(`${DIR}/.novel2vn`);
  await testConcurrentUpdatesPreserveMappings();
  await testWriteFailureReachesCaller();

  await tauri.removePath(DIR);
  console.log("=== asset map transaction tests passed ===");
}

main().catch((error) => {
  console.error("asset map transaction tests failed:", error);
  process.exit(1);
});
