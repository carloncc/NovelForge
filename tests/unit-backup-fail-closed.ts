/**
 * #1516：备份失败必须 fail closed。
 *
 * 旧实现把 backupAssetMap 的所有异常吞成 null，调用方无法区分
 * 「本来就没有 assets.json」（首次运行，无需保护）与「备份没写成功」
 * （需要保护却没保护），于是照常执行剪枝/覆盖：唯一一份映射被覆盖后无从回滚。
 *
 * 故障注入沿用本仓既有手法（tests/unit-asset-map.ts）：临时替换 tauri.writeTextFile。
 */
import { backupAssetMap, readAssetMap, updateAssetMap } from "../src/core/assetMap";
import { tauri } from "../src/utils/tauri";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-backup-closed`;
const DIR = `${ROOT}/proj`;
const NV = `${DIR}/.novel2vn`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function exists(path: string): Promise<boolean> {
  return tauri.pathExists(path);
}

async function withFailingWrite<T>(fn: () => Promise<T>): Promise<{ threw: boolean; error: string }> {
  const original = tauri.writeTextFile;
  tauri.writeTextFile = async () => { throw new Error("injected write failure"); };
  try {
    await fn();
    return { threw: false, error: "" };
  } catch (error) {
    return { threw: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    tauri.writeTextFile = original;
  }
}

async function main(): Promise<void> {
  await tauri.removePath(ROOT).catch(() => {});
  await tauri.mkdirAll(NV);

  // 1) 没有 assets.json 时返回 null：这是「无需保护」，不是错误，必须继续往下走
  assert((await backupAssetMap(DIR)) === null, "无 assets.json 时应返回 null（而不是抛错）");

  // 2) 备份写失败必须抛出——这是「需要保护却没保护住」，绝不能静默降级成 null
  await updateAssetMap(DIR, (a) => { a.bg.room = "room.png"; });
  const r2 = await withFailingWrite(() => backupAssetMap(DIR));
  assert(r2.threw, "备份写失败时 backupAssetMap 必须抛出，不能返回 null");
  assert(r2.error.includes("injected write failure"), "应把原始错误抛给调用方：" + r2.error);
  assert(await exists(`${NV}/assets.json`), "备份失败后原始映射必须仍在原处");

  // 3) 正常路径：返回合法文件名且备份确实落盘
  const okName = await backupAssetMap(DIR);
  assert(!!okName && /^assets\.backup-.*\.json$/.test(okName), "应返回合法备份文件名：" + okName);
  assert(await exists(`${NV}/${okName}`), "备份文件应已落盘");

  // 4) 损坏的 assets.json：隔离成功则原文件保留、从空映射继续（既有行为不回归）
  const CORRUPT = `${ROOT}/corrupt`;
  await tauri.mkdirAll(`${CORRUPT}/.novel2vn`);
  await tauri.writeTextFile(`${CORRUPT}/.novel2vn/assets.json`, "{not json");
  const recovered = await readAssetMap(CORRUPT);
  assert(Object.keys(recovered.bg).length === 0, "损坏文件应回退到空映射");
  assert(await exists(`${CORRUPT}/.novel2vn/assets.json`), "隔离后原损坏文件必须保留");
  const quarantined = (await tauri.listDir(`${CORRUPT}/.novel2vn`)).some((e) => e.name.includes(".corrupt-"));
  assert(quarantined, "应生成 .corrupt- 隔离副本");

  // 5) 隔离写失败必须抛出——否则调用方随后 updateAssetMap 会覆盖唯一的内容副本
  const r5 = await withFailingWrite(() => readAssetMap(CORRUPT));
  assert(r5.threw, "隔离写失败时 readAssetMap 必须抛出，不能静默返回空映射");
  assert(await exists(`${CORRUPT}/.novel2vn/assets.json`), "隔离失败后损坏文件必须仍在原处");

  await tauri.removePath(ROOT);
  console.log("=== 备份 fail-closed 测试通过（#1516）===");
}

main().catch((error) => {
  console.error("unit-backup-fail-closed failed:", error);
  process.exit(1);
});
