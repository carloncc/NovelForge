/**
 * 运行 .ts 测试的最小加载器：Node 原生类型擦除 + 相对导入补 .ts 扩展名。
 * 用法：node --import ./scripts/run-ts-loader.mjs tests/unit-cutout.ts
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      try {
        return nextResolve(specifier);
      } catch {
        return nextResolve(`${specifier}.ts`);
      }
    }
    return nextResolve(specifier);
  },
});
