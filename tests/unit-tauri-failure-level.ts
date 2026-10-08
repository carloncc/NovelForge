/**
 * #1514：tauri 调用失败的日志级别判定。
 *
 * 背景：failureLogLevel 本意是「文件不存在降级为低级别，别刷 ERROR」，
 * 但正则只写了 os error 2（ERROR_FILE_NOT_FOUND）。Windows 上文件/目录缺失
 * 返回的是 os error 3（ERROR_PATH_NOT_FOUND，中文「系统找不到指定的路径。」），
 * 于是这条降级分支在 Windows 上成了死代码：实测全量日志里 os error 3 出现 790 次、
 * os error 2 零次。每章一个 script_chN_*.json 的缓存探针全部以红色 ERROR 刷屏，
 * 真正的错误被淹没（用户看到的就是一屏 30 条「调用 readTextFile 失败」）。
 *
 * 本测试同时守住反面：降级不能把「拒绝访问」「白名单拒绝」这类真错误一起吃掉。
 */
import { failureLogLevel } from "../src/utils/tauri";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── 缺失文件/目录：两个平台、两种 os error 都必须降级 ──
assert(
  failureLogLevel("readTextFile", "读取失败: 系统找不到指定的路径。 (os error 3)") === "debug",
  "Windows os error 3（路径不存在）必须降级为 debug —— 这正是 #1514 的回归点",
);
assert(
  failureLogLevel("readTextFile", "读取失败: 系统找不到指定的文件。 (os error 2)") === "debug",
  "Windows os error 2（文件不存在）必须降级为 debug",
);
assert(failureLogLevel("readTextFile", "No such file or directory (os error 2)") === "debug", "POSIX ENOENT 必须降级为 debug");
assert(failureLogLevel("readFileBase64", "ENOENT") === "debug", "readFileBase64 同样适用");
assert(failureLogLevel("hasTransparency", "系统找不到指定的路径。 (os error 3)") === "debug", "hasTransparency 同样适用");
assert(failureLogLevel("pathExists", "os error 3") === "debug", "pathExists 同样适用");

// ── 反面：降级不得吞掉真错误 ──
assert(failureLogLevel("readTextFile", "读取失败: 拒绝访问。 (os error 5)") === "error", "权限拒绝必须是 ERROR");
assert(
  failureLogLevel("readTextFile", "路径不在允许目录内（仅允许工作目录/临时目录/用户家目录），已拒绝") === "error",
  "目录白名单拒绝必须是 ERROR",
);
assert(
  failureLogLevel("writeTextFile", "系统找不到指定的路径。 (os error 3)") === "error",
  "写文件失败不能因「路径不存在」而降级 —— 降级只针对读探针",
);
assert(failureLogLevel("http", "error sending request") === "warn", "网络瞬时失败为 warn");
assert(failureLogLevel("http", "HTTP 500") === "error", "HTTP 业务错误为 ERROR");

console.log("=== tauri 失败级别判定测试通过（含 #1514 os error 3 回归）===");
