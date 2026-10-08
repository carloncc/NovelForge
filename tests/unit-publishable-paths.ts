/**
 * #1522：发布包不得包含点文件/点目录（.git / .env / .idea …）。
 *
 * 口径来自预览服务器的 is_preview_blocked——那里把「任一路径组件以 . 开头」当作隐私、
 * 不对外提供；打包器此前只排除调用方显式列出的前缀，两侧口径不一致，
 * 于是项目目录若被用户挑在仓库里，整个 .git 会跟着发布包发出去。
 */
import { isPublishableRelativePath } from "../src/utils/vfsWeb";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // 正常素材必须照常进包——这条规则不能误伤游戏本体
  for (const ok of ["index.html", "game/main.js", "assets/bg/01.png", "assets/vocal/a.wav", "a"]) {
    assert(isPublishableRelativePath(ok), `正常路径不得被误伤：${ok}`);
  }

  // 顶层点文件
  for (const bad of [".env", ".gitignore", ".DS_Store", ".npmrc"]) {
    assert(!isPublishableRelativePath(bad), `点文件必须排除：${bad}`);
  }

  // 任意深度的点目录——不只是根下一层（#1474 踩过的同一个坑：只看叶子）
  for (const bad of [".git/config", ".git/objects/ab/cdef", ".novel2vn/project_state.json", "game/.cache/token.json", "assets/.hidden/x.png"]) {
    assert(!isPublishableRelativePath(bad), `子目录中的点目录必须排除：${bad}`);
  }

  // 只看组件起点，不能误伤中间出现点号的普通名字
  for (const ok of ["assets/v1.2/file.png", "a.b.c.js", "assets/中文.txt"]) {
    assert(isPublishableRelativePath(ok), `含点号的普通文件名不得被误伤：${ok}`);
  }

  console.log("=== 发布包点文件排除测试通过（#1522）===");
}

main();
