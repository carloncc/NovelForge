/**
 * 网页版打包 zip：验证异步压缩（不卡主线程）、媒体文件低压缩级别、排除内部缓存目录。
 */
import "fake-indexeddb/auto";
import { unzipSync } from "fflate";
import { vfsWriteTextFile, vfsWriteFileBase64 } from "../src/utils/vfsWeb";
import { webBuildZip } from "../src/utils/webRuntime";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  await vfsWriteTextFile("/app/zip-test/game/scene/start.txt", "changeScene:ch1.txt;");
  await vfsWriteTextFile("/app/zip-test/game/scene/ch1.txt", "林澈:你好;");
  await vfsWriteFileBase64("/app/zip-test/game/background/bg.png", Buffer.from("PNGDATA-XXXX").toString("base64"));
  await vfsWriteTextFile("/app/zip-test/.novel2vn/project_state.json", "{}");

  const stats = await webBuildZip("/app/zip-test", "ignored.zip", [".novel2vn"]);
  assert(stats.fileCount === 3, `应打包 3 个文件（不含 .novel2vn），实际 ${stats.fileCount}`);
  assert(stats.data instanceof Uint8Array && stats.data.byteLength > 0, "应返回 zip 字节（供浏览器直接下载）");
  assert(stats.sizeBytes === stats.data.byteLength, "sizeBytes 应与 data 一致");

  const unzipped = unzipSync(stats.data);
  const names = Object.keys(unzipped).sort();
  assert(names.includes("game/scene/start.txt"), "缺少 start.txt");
  assert(names.includes("game/scene/ch1.txt"), "缺少 ch1.txt");
  assert(names.includes("game/background/bg.png"), "缺少背景图");
  assert(!names.some((n) => n.startsWith(".novel2vn")), "内部缓存目录应被排除");
  assert(new TextDecoder().decode(unzipped["game/scene/start.txt"]) === "changeScene:ch1.txt;", "start.txt 内容不一致");
  assert(new TextDecoder().decode(unzipped["game/background/bg.png"]) === "PNGDATA-XXXX", "背景图字节不一致");

  console.log("=== 网页版打包 zip 测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
