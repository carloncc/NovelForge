import "fake-indexeddb/auto";
import {
  vfsWriteFile,
  vfsWriteTextFile,
  vfsReadTextFile,
  vfsReadFileBase64,
  vfsWriteFileBase64,
  vfsListDir,
  vfsMkdirAll,
  vfsExists,
  vfsRemove,
  vfsCopyFile,
  vfsCopyDirAll,
  vfsCollectFiles,
  vfsReadFile,
} from "../src/utils/vfsWeb";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // 写文本
  await vfsWriteTextFile("/app/project/game/scene/start.txt", "第一章");
  assert((await vfsReadTextFile("/app/project/game/scene/start.txt")) === "第一章", "写读文本失败");

  // 自动建目录
  assert(await vfsExists("/app/project"), "父目录未自动创建");
  assert(await vfsExists("/app/project/game/scene"), "深层目录未自动创建");
  assert(!(await vfsExists("/app/project/none")), "不存在误报");

  // base64 二进制
  const raw = "HELLO-WEB";
  await vfsWriteFileBase64("/app/project/img.png", Buffer.from(raw).toString("base64"));
  assert((await vfsReadFileBase64("/app/project/img.png")) === Buffer.from(raw).toString("base64"), "base64 读写失败");
  const buf = await vfsReadFile("/app/project/img.png");
  assert(buf && new TextDecoder().decode(buf) === raw, "二进制读取失败");

  // listDir 含目录/文件/大小
  const entries = await vfsListDir("/app/project");
  assert(entries.length === 2, `listDir 数量错误: ${entries.length}`);
  const game = entries.find((e) => e.name === "game");
  const img = entries.find((e) => e.name === "img.png");
  assert(game?.isDir === true, "game 应为目录");
  assert(img?.isDir === false && img?.size === raw.length, `文件大小错误: ${img?.size}`);

  // 深层 listDir
  const sceneEntries = await vfsListDir("/app/project/game/scene");
  assert(sceneEntries.length === 1 && sceneEntries[0].name === "start.txt", "深层 listDir 失败");

  // 复制文件 / 目录
  await vfsCopyFile("/app/project/img.png", "/app/project/backup.png");
  assert((await vfsReadFileBase64("/app/project/backup.png")) === (await vfsReadFileBase64("/app/project/img.png")), "copyFile 失败");
  await vfsCopyDirAll("/app/project", "/app/copy");
  assert(await vfsExists("/app/copy/game/scene/start.txt"), "copyDirAll 失败");

  // 递归收集（含排除）
  await vfsWriteTextFile("/app/project/.novel2vn/meta.json", "{}");
  const all = await vfsCollectFiles("/app/project");
  assert(all.length === 4, `collectFiles 数量错误: ${all.length}`);
  const noMeta = await vfsCollectFiles("/app/project", ["/app/project/.novel2vn"]);
  assert(noMeta.length === 3, "collectFiles 排除失败");

  // 删除（递归）
  await vfsRemove("/app/project/game/scene");
  assert(!(await vfsExists("/app/project/game/scene/start.txt")), "remove 递归失败");
  assert(await vfsExists("/app/project/game"), "remove 误删父目录");

  // mkdirAll 幂等
  await vfsMkdirAll("/app/project/game");
  await vfsMkdirAll("/app/project/game");
  assert(true, "mkdirAll 幂等");

  console.log("=== 虚拟文件系统（IndexedDB）测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
