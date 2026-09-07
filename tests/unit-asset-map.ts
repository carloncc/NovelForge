import { updateAssetMap, backupAssetMap, listAssetBackups, restoreAssetBackup } from "../src/core/assetMap";
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

async function testBackupRestoreRoundTrip(): Promise<void> {
  await updateAssetMap(DIR, (assets) => { assets.bg.hall = "hall.png"; });
  const name = await backupAssetMap(DIR);
  assert(!!name && /^assets\.backup-.*\.json$/.test(name), `备份应返回合法文件名：${name}`);
  // 模拟剪枝误删：映射被洗空
  await updateAssetMap(DIR, (assets) => { assets.bg = {}; assets.cg = {}; assets.vocal = {}; });
  const wiped = JSON.parse((await tauri.readTextFile(`${DIR}/.novel2vn/assets.json`)).text);
  assert(Object.keys(wiped.bg).length === 0, "应先模拟出被洗空的状态");
  // 一键恢复
  const backups = await listAssetBackups(DIR);
  assert(backups.includes(name!), "备份应能列出");
  await restoreAssetBackup(DIR, backups[0]);
  const restored = JSON.parse((await tauri.readTextFile(`${DIR}/.novel2vn/assets.json`)).text);
  assert(restored.bg.hall === "hall.png", "恢复后映射应回来");
  // 非法文件名拒绝
  let rejected = false;
  try {
    await restoreAssetBackup(DIR, "../evil.json");
  } catch {
    rejected = true;
  }
  assert(rejected, "非法备份文件名必须拒绝");
  // 坏内容备份拒绝写入
  await tauri.writeTextFile(`${DIR}/.novel2vn/assets.backup-2099-01-01-00-00-00.json`, "{not json");
  let badRejected = false;
  try {
    await restoreAssetBackup(DIR, "assets.backup-2099-01-01-00-00-00.json");
  } catch {
    badRejected = true;
  }
  assert(badRejected, "坏备份必须拒绝恢复");
}

async function main(): Promise<void> {
  await tauri.removePath(DIR).catch(() => {});
  await tauri.mkdirAll(`${DIR}/.novel2vn`);
  await testConcurrentUpdatesPreserveMappings();
  await testWriteFailureReachesCaller();
  await testBackupRestoreRoundTrip();

  await tauri.removePath(DIR);
  console.log("=== asset map transaction tests passed ===");
}

main().catch((error) => {
  console.error("asset map transaction tests failed:", error);
  process.exit(1);
});
