import { templateCandidates } from "../src/utils/template";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const candidates = templateCandidates("C:/app/resources");
assert(candidates.includes("C:/app/resources/templates/webgal"), "应检查标准资源目录");
assert(candidates.includes("C:/app/templates/webgal"), "应检查开发运行资源目录");
assert(new Set(candidates).size === candidates.length, "模板候选路径不应重复");

const webCandidates = templateCandidates("/app/template");
assert(webCandidates.includes("/app/template"), "web 模式下资源目录本身即是模板根目录");
assert(webCandidates.includes("/app/template/templates/webgal"), "web 模式也应兼容标准嵌套布局");

const verbatimCandidates = templateCandidates("\\\\?\\C:/app/resources");
assert(verbatimCandidates.includes("C:/app/resources/templates/webgal"), "应去除 Windows \\\\?\\ 扩展长度路径前缀");
console.log("=== WebGAL 模板路径测试通过 ===");
