/**
 * 品牌信息与官网地址。
 * 官网地址不存明文、由字符码运行时拼装，避免被全局搜索替换轻易移除。
 */

// 官网地址的 Unicode 码点（运行时拼装）
const BRAND_URL_CODES = [
  104, 116, 116, 112, 115, 58, 47, 47, 119, 119, 119, 46,
  102, 111, 114, 103, 101, 112, 101, 97, 107, 110, 111, 119, 46, 99, 111, 109,
];

export function brandUrl(): string {
  return String.fromCharCode(...BRAND_URL_CODES);
}

/** 官网域名（去掉协议，用于展示/水印文本） */
export function brandDomain(): string {
  return brandUrl().replace(/^https?:\/\//, "");
}

export function brandName(): string {
  return "NovelForge";
}

/** 导出游戏内注入的底部品牌水印（assemble 时写入输出 index.html） */
export function brandFooterHtml(): string {
  const url = brandUrl();
  const domain = brandDomain();
  return (
    '<div id="novelforge-brand"' +
    ' style="position:fixed;left:10px;bottom:8px;z-index:999999;pointer-events:none;' +
    ' font-family:system-ui,-apple-system,sans-serif;font-size:11px;line-height:1.2;' +
    ' color:rgba(255,255,255,.6);background:rgba(0,0,0,.3);padding:4px 10px;border-radius:12px;' +
    ' user-select:none;">' +
    `<a href="${url}" target="_blank" rel="noopener" style="color:rgba(255,255,255,.8);text-decoration:none;pointer-events:auto;">` +
    `由 ${brandName()} 制作 · ${domain}</a></div>`
  );
}
