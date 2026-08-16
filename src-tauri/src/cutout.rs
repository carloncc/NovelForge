use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{ImageFormat, Rgba, RgbaImage};

/// 判断采样到的背景色是否绿色幕（含亮绿、墨绿、青绿、teal）：
/// - 亮绿/饱和绿：G 显著高于 R/B
/// - 墨绿/深绿：G 高但 R/B 也不低，整体偏绿
/// - teal（青绿）：G 高且 B 明显高于 R
fn is_green_screen(bg: [f32; 3]) -> bool {
    let r = bg[0];
    let g = bg[1];
    let b = bg[2];
    if g < 60.0 {
        return false;
    }
    // 饱和绿：G 显著高于 max(R,B)
    if g - r.max(b) > 30.0 {
        return true;
    }
    // teal/青绿：G 高且 B 明显高于 R（B≥R+15 且 G≥B-15，整体偏冷绿）
    if b > r + 15.0 && g >= b - 15.0 {
        return true;
    }
    // 偏绿（弱）：G > R 且 G > B，且 G 占主导
    if g > r + 10.0 && g > b + 10.0 && g >= (r + b) * 0.55 {
        return true;
    }
    false
}

/// 色度加权欧氏距离：对绿色背景降低亮度(G)权重，让深绿/浅绿渐变与背景色距离变小
/// （RGB 欧氏距离在亮度变化下会放大，导致 AI 生成的有渐变的绿底抠不干净）
fn distance(rgba: &RgbaImage, x: u32, y: u32, bg: [f32; 3], green: bool) -> f32 {
    let p = rgba.get_pixel(x, y);
    let dr = p[0] as f32 - bg[0];
    let dg = p[1] as f32 - bg[1];
    let db = p[2] as f32 - bg[2];
    if green {
        // G 权重 0.25：把"亮度差"对距离的贡献压低，色度(R/B 差)主导 → 渐变绿底仍判定为背景
        (dr * dr + db * db + dg * dg * 0.25).sqrt()
    } else {
        (dr * dr + dg * dg + db * db).sqrt()
    }
}

/// 采样图像边缘一圈的背景色（取各通道中位数，抗前景人物/噪点干扰）。
/// 关键：先剔除"明显是前景"的暗像素（亮度 < 60），避免人物贴边的黑色头发/黑色衣服把背景色拉成黑，
/// 解决"边缘有黑色前景时算法把黑色当背景一起抠掉"的回归。
/// 候选样本不足时退回全量采样以保证最差情况仍能抠图。
fn sample_bg_color(img: &RgbaImage) -> Option<[f32; 3]> {
    let (w, h) = img.dimensions();
    if w < 8 || h < 8 {
        return None;
    }
    let ring = 8u32; // 边缘采样厚度（比原先大，抗主体贴边）
    let mut rs = Vec::new();
    let mut gs = Vec::new();
    let mut bs = Vec::new();
    let mut rs_bright = Vec::new();
    let mut gs_bright = Vec::new();
    let mut bs_bright = Vec::new();
    let mut push = |x: u32, y: u32,
                    rs: &mut Vec<u8>,
                    gs: &mut Vec<u8>,
                    bs: &mut Vec<u8>| {
        let p = img.get_pixel(x.min(w - 1), y.min(h - 1));
        if p[3] > 240 {
            rs.push(p[0]);
            gs.push(p[1]);
            bs.push(p[2]);
            // 暗像素（max channel < 60）大概率是前景黑色，过滤掉避免把背景色拉成黑
            if p[0].max(p[1]).max(p[2]) >= 60 {
                rs_bright.push(p[0]);
                gs_bright.push(p[1]);
                bs_bright.push(p[2]);
            }
        }
    };
    for x in 0..w {
        for y in 0..ring {
            push(x, y, &mut rs, &mut gs, &mut bs);
            push(x, h - 1 - y, &mut rs, &mut gs, &mut bs);
        }
    }
    for y in 0..h {
        for x in 0..ring {
            push(x, y, &mut rs, &mut gs, &mut bs);
            push(w - 1 - x, y, &mut rs, &mut gs, &mut bs);
        }
    }
    if rs.is_empty() {
        return None;
    }
    let median = |mut v: Vec<u8>| -> u8 {
        v.sort_unstable();
        v[v.len() / 2]
    };
    // 优先用亮像素样本；若太少（说明这个图本身就是暗色背景），退回全量样本
    if rs_bright.len() >= 8 {
        Some([
            median(rs_bright) as f32,
            median(gs_bright) as f32,
            median(bs_bright) as f32,
        ])
    } else {
        Some([median(rs) as f32, median(gs) as f32, median(bs) as f32])
    }
}

/// 3x3 中值滤波（仅 alpha），去除抠图后的孤立噪点与 1px 空洞
fn alpha_median3x3(alpha: &[f32], w: u32, h: u32) -> Vec<f32> {
    let n = (w * h) as usize;
    let mut out = alpha.to_vec();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let mut window = [0f32; 9];
            let mut k = 0;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let xx = (x as i32 + dx).clamp(0, w as i32 - 1) as u32;
                    let yy = (y as i32 + dy).clamp(0, h as i32 - 1) as u32;
                    window[k] = alpha[(yy * w + xx) as usize];
                    k += 1;
                }
            }
            window.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            out[(y * w + x) as usize] = window[4];
        }
    }
    // 边缘保留原值（不动四边）
    for i in 0..n {
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        if x == 0 || y == 0 || x + 1 >= w || y + 1 >= h {
            out[i] = alpha[i];
        }
    }
    out
}

/// 8 邻域二值膨胀：把 mask 中 true 的像素向外扩展 1 像素。
fn dilate(mask: &[bool], w: u32, h: u32) -> Vec<bool> {
    let mut out = mask.to_vec();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if !mask[i] {
                continue;
            }
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let xx = x as i32 + dx;
                    let yy = y as i32 + dy;
                    if xx < 0 || yy < 0 || xx >= w as i32 || yy >= h as i32 {
                        continue;
                    }
                    out[(yy as u32 * w + xx as u32) as usize] = true;
                }
            }
        }
    }
    out
}

/// 把背景绿色溢出（绿边/绿晕）从前景边缘去除：
/// - 半透明羽化带（alpha < 0.98）按透明度强度去绿，避免灰边
/// - 与透明像素相邻的不透明边界像素做一次轻量去绿
/// - 迭代膨胀 fringe（最多 3 像素），把不透明但靠边、被绿晕污染的发丝内部像素也去绿
/// - 主体内远离边界的非绿色像素完全不受影响
/// `aggressive=true` 用于亮绿色背景：触发阈值更低、边界带去绿强度更强，
/// 防止 AI 生成的有渐变绿底在人物边缘残留绿边/绿晕。
pub(crate) fn despill(rgba: &mut RgbaImage, alpha: &[f32], aggressive: bool) {
    let (w, h) = rgba.dimensions();
    let n = (w * h) as usize;
    // 初始 fringe：半透明像素 + 4 邻域有半透明像素的不透明边界像素
    let mut is_fringe = vec![false; n];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = (y * w + x) as usize;
            if alpha[i] < 0.98 {
                is_fringe[i] = true;
                continue;
            }
            let nb = [
                ((y - 1) * w + x) as usize,
                ((y + 1) * w + x) as usize,
                (y * w + x - 1) as usize,
                (y * w + x + 1) as usize,
            ];
            for &j in &nb {
                if alpha[j] < 0.5 {
                    is_fringe[i] = true;
                    break;
                }
            }
        }
    }
    let spill_th = if aggressive { 2.0 } else { 6.0 };
    let fringe_strength = if aggressive { 0.95 } else { 0.85 };
    // 多次膨胀 + 去绿：把"靠边的不透明但偏绿"的发丝内部也处理掉
    let max_passes = if aggressive { 3 } else { 2 };
    for _ in 0..max_passes {
        apply_despill(rgba, &is_fringe, alpha, spill_th, fringe_strength);
        is_fringe = dilate(&is_fringe, w, h);
    }
    // 最后一轮：fringe 已膨胀到位，再跑一次完整去绿
    apply_despill(rgba, &is_fringe, alpha, spill_th, fringe_strength);
}

fn apply_despill(
    rgba: &mut RgbaImage,
    is_fringe: &[bool],
    alpha: &[f32],
    spill_th: f32,
    fringe_strength: f32,
) {
    let (w, _h) = rgba.dimensions();
    let n = is_fringe.len();
    for i in 0..n {
        if !is_fringe[i] {
            continue;
        }
        let p = rgba.get_pixel_mut((i % w as usize) as u32, (i / w as usize) as u32);
        let r = p[0] as f32;
        let g = p[1] as f32;
        let b = p[2] as f32;
        let max_rb = r.max(b);
        let spill = (g - max_rb).max(0.0);
        if spill <= spill_th {
            continue;
        }
        // 强度按像素透明度分档，避免把半透明发丝直接杀成灰：
        // - 不透明像素（alpha ≥ 0.98）：用 fringe_strength，去大部分绿（避免灰边）
        // - 半透明羽化带（alpha 0.5..0.98）：用 0.85，保留发丝色调
        // - 高度半透明（alpha < 0.5）：用 1.0，几乎彻底去绿
        let a = alpha[i];
        let strength = if a >= 0.98 {
            fringe_strength
        } else if a >= 0.5 {
            0.85
        } else {
            1.0
        };
        let out_g = g - spill * strength;
        p[1] = out_g.round().clamp(0.0, 255.0) as u8;
    }
}

/// 清除"被前景包围的内部绿污染像素"（绿底 AI 立绘常见，头发/手指/衣缝间隙处残留绿块）。
///
/// 用户反馈：之前实现仅当 `g - max(r,b) > 30` 时去绿（且只压 85%），对发丝边缘抗锯齿产生的
/// "半透明发丝×绿幕" 暗青绿混合色（如 rgb(5,44,34)，b 接近 g，g-max ≈ 10）判定不命中，
/// 残留 alpha=1.0 的深绿块。修复：
///
///   判据放宽：
///     1. alpha_out >= 0.5（不透明或主体不透明）
///     2. 8 邻域全是不透明（被前景完全包围，没通向图像边缘的透明路径）
///     3. max(rgb) < 60 且 g 是 r/b 中最大者（偏绿暗像素 = 背景绿泄漏到前景内部的发丝间隙/暗部）
///
///   命中后：
///     - 彻底去绿：`out_g = max(r, b)`（去掉绿色分量到与红蓝持平），不再保留 15% 残余
///     - 设为透明：alpha_out 置 0（这些是被前景包围的背景泄漏，应作为背景被抠掉）
///
///   风险控制：仅在「被前景完全包围」的孤立像素上生效，不影响大块连通真暗前景（黑发/黑衣），
///   也避开了洪流填充触达过的区域（那些已被正确抠掉/羽化）。
///
/// 仅适用于绿底场景（与 `despill` 的 aggressive 共用入口）。
/// 返回命中像素数（被彻底去绿 + 置透明的像素），用于统计与调试。
fn sweep_trapped_green(rgba: &mut RgbaImage, alpha: &mut Vec<f32>) -> usize {
    let (w, h) = rgba.dimensions();
    let n = (w * h) as usize;
    let mut trap: Vec<bool> = vec![false; n];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = (y * w + x) as usize;
            if alpha[i] < 0.5 {
                continue;
            }
            let p = rgba.get_pixel(x, y);
            let r = p[0];
            let g = p[1];
            let b = p[2];
            let mx = r.max(g).max(b);
            if mx >= 60 {
                continue;
            }
            // 偏绿判定：g 是三通道中最大的（捕获纯绿残留 + 青绿/墨绿混合色）
            if !(g > r && g >= b) {
                continue;
            }
            // 8 邻域 alpha_out >= 0.2：用户真实项目里发丝间隙的暗绿像素常处于「半透明发丝边缘包围」
            // 状态（不是被 100% 不透明包围的孤立岛，而是邻域含 feather 半透明像素）。
            // 放宽阈值到 0.2 才能让这些像素被 sweep 处理；纯背景边缘（alpha 极低）仍不算包围。
            let mut surrounded = true;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let xx = x as i32 + dx;
                    let yy = y as i32 + dy;
                    let j = (yy as u32 * w + xx as u32) as usize;
                    if alpha[j] < 0.2 {
                        surrounded = false;
                        break;
                    }
                }
                if !surrounded {
                    break;
                }
            }
            if surrounded {
                trap[i] = true;
            }
        }
    }
    let mut count = 0usize;
    for i in 0..n {
        if !trap[i] {
            continue;
        }
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        // 彻底去绿：把 G 压到与 R/B 持平（变中性灰），不再保留 15% 残余 → 视觉上不再偏绿
        let p = rgba.get_pixel_mut(x, y);
        let max_rb = p[0].max(p[2]);
        p[1] = max_rb;
        // 这些像素是被前景包围的背景绿泄漏，应作为背景被抠掉：alpha 置 0（透明）
        alpha[i] = 0.0;
        count += 1;
    }
    count
}

/// 色度键抠图（连通性洪水填充 + 边缘羽化 + 去绿边 + alpha 中值平滑）：
/// - 从图像四条边播种，沿相似色扩散；与背景色距离 < thr 的像素置透明
/// - thr..thr_edge 之间羽化（平滑过渡到不透明）；超过 thr_edge 视为前景边界，不扩散
/// - 前景内部与背景色相近的孤立像素（如脸部高光、浅色头发内侧）因“不连通”而不会被误删
/// - 最后做 despill（去除绿幕常见的绿边/绿晕）与 alpha 3x3 中值平滑（去噪点/空洞）
/// - 对亮绿色背景自动切换为色度加权距离（降亮度权重）+ 更大容差，把有渐变/光照的绿底也抠干净
/// 返回 (PNG base64, 被置为全透明的像素比例 0.0~1.0)。比例用于判断“背景识别是否过激”
/// （例如 AI 画了纯黑背景，黑色前景与背景色距离≈0 会被误抠，removed 会异常偏高）。
pub fn cutout(data_b64: &str, threshold: f32) -> Result<String, String> {
    cutout_with_stats(data_b64, threshold).map(|(b64, _, _, _, _)| b64)
}

/// 同 `cutout`，但额外返回被置全透明的像素比例 + 背景是否为绿幕 + 背景是否为深色（黑）。
/// - 绿幕背景 removed 偏高是“抠干净”的正常成功指标，调用方不得据此降级 AI；
/// - 深色背景（黑/墨蓝等）色度键原理上无法区分“黑发/黑衣服”与“黑背景”（距离≈0 被误抠成
///   半透明灰），调用方应保留原图而非继续抠。
pub fn cutout_with_stats(
    data_b64: &str,
    threshold: f32,
) -> Result<(String, f32, bool, bool, usize), String> {
    let bytes = B64
        .decode(data_b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let mut rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let bg = sample_bg_color(&rgba).ok_or("无法采样背景色（图像过小或边缘全透明）")?;

    // 检测亮绿背景：绿底常见 AI 生成会有明暗渐变/压缩噪点，
    // RGB 欧氏距离会因亮度差放大导致洪水填充提前终止 → 残留绿块。
    // 色度加权 + 更大容差可彻底抠掉。
    let green = is_green_screen(bg);
    // 深色背景（黑/墨蓝/深灰渐变等）：色度键无法区分黑发/黑衣服/深色物品与深色背景
    // （RGB 距离≈0 会互相误判，把主体羽化成半透明灰）。阈值 90 覆盖「深蓝/炭黑渐变」
    // 这类物品图常见背景（采样 max 常在 60~90，旧阈值 60 漏判导致深色物品被扣成半透明黑）。
    // 前置标记给调用方，让其保留原图而不是继续抠。
    let dark_bg = !green && bg.iter().fold(0.0f32, |m, v| m.max(*v)) < 90.0;
    // 绿底用更大的容差：AI 生成的渐变/带噪点绿底距离中位色能到 80~120；
    // thr_edge 给更宽的羽化带，让飘动的半透明发丝要么完全抠掉、要么完整保留（少出怪异半透色）。
    let thr = if green { threshold.max(80.0) } else { threshold.max(4.0) };
    let thr_edge = if green { thr + 90.0 } else { thr + 40.0 };

    let idx = |x: u32, y: u32| -> usize { (y * w + x) as usize };
    let dist_at = |x: u32, y: u32| -> f32 { distance(&rgba, x, y, bg, green) };

    // 初始 alpha 全 1（默认保留），仅对“与边缘连通的背景区域”做透明化
    let mut alpha_out = vec![1f32; (w * h) as usize];
    let mut visited = vec![false; (w * h) as usize];
    let mut stack: Vec<(u32, u32)> = Vec::with_capacity(((w + h) * 2) as usize);
    for x in 0..w {
        stack.push((x, 0));
        stack.push((x, h - 1));
    }
    for y in 1..h.saturating_sub(1) {
        stack.push((0, y));
        stack.push((w - 1, y));
    }

    while let Some((x, y)) = stack.pop() {
        let i = idx(x, y);
        if visited[i] {
            continue;
        }
        visited[i] = true;
        // 暗色前景保护（绿幕下精确版）：max(rgb)<60 且「不偏绿」（r≈g 或 g≤r 或 g≤b，即真黑/真灰前景）
        // → 当前景边界，不透 + 不扩散，避免黑发/黑衣被色度键羽化成半透明灰。
        // 偏绿（g>r 或 g>b）的暗像素 → 当作绿幕背景泄漏让色度键正常处理。
        if green {
            let p = rgba.get_pixel(x, y);
            let r = p[0]; let g = p[1]; let b = p[2];
            let mx = r.max(g).max(b);
            if mx < 96 && !(g > r) && !(g > b) {
                alpha_out[i] = 1.0;
                continue;
            }
        } else {
            // 非绿幕下的暗色前景保护（物品图重点）：远离背景色的暗像素是深色主体
            // （黑剑/深色道具/黑色描边），作为前景边界不透 + 不扩散，
            // 避免落在羽化带 (thr..thr_edge) 被扣成半透明黑。
            let p = rgba.get_pixel(x, y);
            let mx = p[0].max(p[1]).max(p[2]);
            if mx < 96 && dist_at(x, y) > thr {
                alpha_out[i] = 1.0;
                continue;
            }
        }
        let d = dist_at(x, y);
        if d > thr_edge {
            continue; // 前景边界：不扩散，保持不透明
        }
        let a = if d < thr {
            0.0
        } else {
            let t = (d - thr) / (thr_edge - thr);
            let s = t * t * (3.0 - 2.0 * t);
            s
        };
        alpha_out[i] = a;
        if x > 0 {
            stack.push((x - 1, y));
        }
        if x + 1 < w {
            stack.push((x + 1, y));
        }
        if y > 0 {
            stack.push((x, y - 1));
        }
        if y + 1 < h {
            stack.push((x, y + 1));
        }
    }

    // alpha 3x3 中值平滑：去掉孤立噪点/1px 空洞，让边缘更干净
    let mut alpha_out = alpha_median3x3(&alpha_out, w, h);
    // 暗色前景保护二次落地（通用）：median 平滑会把 dark-fg 像素 alpha=1.0 被 8 个
    // 半透明邻居中值化成 ~0.54，导致黑色人物/深色物品依旧呈灰色半透明。
    // 绿幕下排除「偏绿」暗像素（那是背景泄漏）；非绿幕下所有暗像素一律保护
    // （真正的深色背景图已由 dark_bg 前置拦截，不会走到这里）。
    for y in 0..h {
        for x in 0..w {
            let p = rgba.get_pixel(x, y);
            let r = p[0]; let g = p[1]; let b = p[2];
            let mx = r.max(g).max(b);
            let dark_foreground = if green {
                mx < 96 && !(g > r) && !(g > b)
            } else {
                mx < 96 && distance(&rgba, x, y, bg, false) > thr
            };
            if dark_foreground {
                alpha_out[idx(x, y)] = 1.0;
            }
        }
    }

    let mut max_opaque = 0f32;
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = alpha_out[idx(x, y)] * (p[3] as f32 / 255.0);
        if a > max_opaque {
            max_opaque = a;
        }
    }
    if max_opaque < 0.02 {
        return Err("抠图失败：画面几乎全部接近背景色".to_string());
    }

    // 去绿边/绿晕（在应用 alpha 前处理颜色，避免绿边留在前景上）
    despill(&mut rgba, &alpha_out, green);

    // 内部绿污染清除：绿底 AI 立绘常见"头发/手指/衣缝间隙处残留绿块"——这些像素不透明、被
    // 前景完全包围（洪水填充没蔓延进去），颜色仍是绿幕色或其与前景边缘抗锯齿的暗青绿混合色
    // （g 是三通道中最大者）。判据放宽覆盖：α >= 0.5 且 8 邻域全不透明 且 max(rgb) < 60 且
    // g 是 r/g/b 中最大。命中后：彻底去绿（g 压到 max(r,b)）+ alpha 置 0（透明），
    // 把这些背景泄漏彻底抠掉。
    let sweep_count = if green {
        sweep_trapped_green(&mut rgba, &mut alpha_out)
    } else {
        0
    };

    let mut writes: Vec<(u32, u32, [u8; 4])> = Vec::with_capacity((w * h) as usize / 8);
    for (x, y, base) in rgba.enumerate_pixels() {
        let a = alpha_out[idx(x, y)] * (base[3] as f32 / 255.0);
        let mut out = Rgba([base[0], base[1], base[2], 0]);
        out[3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
        if out[3] > 0 {
            let src_a = base[3] as f32 / 255.0;
            let blend = a / src_a.max(0.001);
            out[0] = (base[0] as f32 * blend.min(1.0)) as u8;
            out[1] = (base[1] as f32 * blend.min(1.0)) as u8;
            out[2] = (base[2] as f32 * blend.min(1.0)) as u8;
        }
        writes.push((x, y, out.0));
    }
    for (x, y, px) in writes {
        *rgba.get_pixel_mut(x, y) = Rgba(px);
    }

    let mut out_buf = std::io::Cursor::new(Vec::new());
    rgba.write_to(&mut out_buf, ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    let removed = count_transparent(&rgba) as f32 / (w * h).max(1) as f32;
    Ok((B64.encode(out_buf.into_inner()), removed, green, dark_bg, sweep_count))
}

/// 统计 RGBA 图像中 alpha == 0 的像素数（用于判断色度键是否过激）
fn count_transparent(rgba: &image::RgbaImage) -> u32 {
    rgba.pixels().filter(|p| p[3] == 0).count() as u32
}

/// 检查图片是否已经包含大范围透明区域（用户已抠好的素材则跳过抠图）
pub fn has_transparency(data_b64: &str) -> Result<bool, String> {
    let bytes = B64
        .decode(data_b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let total = rgba.pixels().count().max(1);
        let transparent = rgba
            .pixels()
            .filter(|p| p[3] < 16)
            .count();
        return Ok(transparent * 100 / total > 5);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn make_white_bg_art() -> String {
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([255, 255, 255, 255]);
        }
        // 中心画一个红色方块（前景）
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    fn make_green_bg_art() -> String {
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([0, 255, 0, 255]); // 纯绿底
        }
        // 中心画一个红色方块（前景）
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        // 前景边缘加一圈“绿色溢出”（模拟绿边）
        for y in 19..=44 {
            for x in 19..=44 {
                if (x == 19 || x == 44 || y == 19 || y == 44) && img.get_pixel(x, y)[0] == 200 {
                    img.put_pixel(x, y, Rgba([80, 180, 60, 255]));
                }
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    /// 模拟 AI 生成的有渐变的亮绿背景（抠图没抠干净的根因）：
    /// 边缘是纯绿 (0,255,0)，向中心逐渐变暗绿（如 (40,180,40)）。
    /// RGB 欧氏距离下，深绿与背景色距离 ≈ 91 > 旧阈值 80 → 洪水填充被挡住 → 残留绿块。
    fn make_gradient_green_bg_art() -> String {
        let mut img = RgbaImage::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                let dx = (x as i32 - 32).unsigned_abs() as f32 / 32.0;
                let dy = (y as i32 - 32).unsigned_abs() as f32 / 32.0;
                let t = (dx + dy) * 0.5;
                let r = (0.0 + t * 40.0) as u8;
                let g = (255.0 - t * 75.0) as u8;
                let b = (0.0 + t * 40.0) as u8;
                img.put_pixel(x, y, Rgba([r, g, b, 255]));
            }
        }
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn cutout_gradient_green_bg_clean() {
        // 渐变绿底应被完全抠掉（旧算法在深绿处残留）
        let b64 = make_gradient_green_bg_art();
        let out = cutout(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap()).unwrap().to_rgba8();
        // 四角应透明
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert!(out_img.get_pixel(x, y)[3] < 16, "角落应透明: {x},{y}");
        }
        // 中间靠近中心的深绿背景区域也应透明（关键：旧算法这里会残留绿块）
        // 前景是 20..44 的方块，背景区域取前景外但在中央附近的深绿点
        for (x, y) in [(2, 32), (32, 2), (61, 32), (32, 61), (15, 15)] {
            let p = out_img.get_pixel(x, y);
            assert!(p[3] < 16, "渐变绿底中央附近应透明: ({x},{y}) a={}", p[3]);
        }
        // 中心红色前景应保留
        assert!(out_img.get_pixel(32, 32)[3] > 200, "中心前景应保留");
        assert!(out_img.get_pixel(32, 32)[0] > 150, "中心应接近红色");
    }

    #[test]
    fn cutout_makes_bg_transparent() {
        let b64 = make_white_bg_art();
        let out = cutout(&b64, 40.0).expect("抠图应成功");
        let bytes = B64.decode(&out).unwrap();
        let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
        // 四角应透明
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert!(img.get_pixel(x, y)[3] < 16, "角落应透明: {x},{y}");
        }
        // 中心红色前景应不透明
        assert!(img.get_pixel(32, 32)[3] > 200, "中心前景应保留");
        assert!(img.get_pixel(32, 32)[0] > 150, "中心应接近红色");
    }

    #[test]
    fn cutout_preserves_interior_similar_color() {
        // 白底 + 中心红色前景，前景内部有一个“接近背景色”的亮点（模拟脸部高光）
        // 旧的全图逐像素算法会把它删掉；连通性洪水填充应保留它
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([255, 255, 255, 255]);
        }
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        img.put_pixel(32, 32, Rgba([250, 250, 250, 255])); // 前景内部的高亮点
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        let out = cutout(&B64.encode(buf.into_inner()), 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        // 角落背景应透明
        assert!(out_img.get_pixel(0, 0)[3] < 16, "角落应透明");
        // 前景内部的高亮点应保留（不透明），因为不连通背景
        assert!(out_img.get_pixel(32, 32)[3] > 200, "前景内部高亮点应保留");
        assert!(out_img.get_pixel(31, 31)[3] > 200, "前景主体应保留");
    }

    #[test]
    fn cutout_green_bg_despills_fringe() {
        let b64 = make_green_bg_art();
        let out = cutout(&b64, 40.0).expect("绿色底抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        // 角落（绿底）应透明
        assert!(out_img.get_pixel(0, 0)[3] < 16, "绿底角落应透明");
        // 中心红色前景应保留
        assert!(out_img.get_pixel(32, 32)[3] > 200, "中心前景应保留");
        // 前景边缘的“绿色溢出”像素：要么透明（属背景），要么去绿后绿色分量被压低
        for (x, y) in [(19, 30), (30, 19), (44, 30), (30, 44)] {
            let p = out_img.get_pixel(x, y);
            if p[3] > 80 {
                // 保留但不应偏绿：绿色分量不应明显高于红/蓝
                assert!(
                    p[1] as i32 <= (p[0] as i32).max(p[2] as i32) + 20,
                    "绿边未去干净: ({x},{y}) rgb={:?}",
                    [p[0], p[1], p[2]]
                );
            }
        }
    }

    /// 模拟 AI 生成的"飘散发丝 + 亮绿背景"：绿色背景里悬浮几条不透明但偏绿的发丝，
    /// 以及几条半透明（alpha=0.5 左右）的飘散发丝。抠图后：
    /// - 背景应完全抠掉
    /// - 不透明发丝保留但绿分量被压低
    /// - 半透明飘散发丝要么完全抠掉、要么完整保留（不再有怪异半透绿）
    fn make_wispy_hair_art() -> String {
        let mut img = RgbaImage::new(96, 64);
        // 亮绿底 + 一点噪点（AI 压缩特征）
        for y in 0..64 {
            for x in 0..96 {
                let n = ((x * 13 + y * 7) % 11) as i32 - 5;
                let g = (250 + n).clamp(180, 255) as u8;
                img.put_pixel(x, y, Rgba([n.max(0) as u8, g, n.max(0) as u8, 255]));
            }
        }
        // 主体：暖色头发块（防止被洪水填充误删）
        for y in 22..42 {
            for x in 24..72 {
                img.put_pixel(x, y, Rgba([150, 90, 60, 255]));
            }
        }
        // 不透明但偏绿的发丝（靠边）：模拟 AI 边缘处的绿晕
        for x in 8..20 {
            img.put_pixel(x, 28, Rgba([140, 200, 130, 255]));
            img.put_pixel(x, 32, Rgba([120, 190, 110, 255]));
            img.put_pixel(x, 36, Rgba([130, 210, 120, 255]));
        }
        // 半透明飘散发丝（alpha=0.5）：会与绿底混合成偏绿颜色
        for x in 4..14 {
            img.put_pixel(x, 12, Rgba([140, 220, 140, 128]));
            img.put_pixel(x, 14, Rgba([130, 210, 130, 128]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn cutout_wispy_green_hair_no_residue() {
        let b64 = make_wispy_hair_art();
        let out = cutout(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();

        // 背景应完全抠掉
        for (x, y) in [(0, 0), (95, 0), (0, 63), (95, 63), (50, 0), (50, 63)] {
            assert!(out_img.get_pixel(x, y)[3] < 16, "背景应透明: ({x},{y})");
        }
        // 主体暖色头发应保留
        assert!(out_img.get_pixel(48, 32)[3] > 200, "主体应保留");
        // 主体内不应偏绿
        let main = out_img.get_pixel(48, 32);
        assert!(
            main[1] as i32 <= main[0] as i32 + 30,
            "主体残留绿色: rgb={:?}",
            [main[0], main[1], main[2]]
        );
        // 不透明发丝（靠边偏绿）：要么被抠掉，要么绿分量被显著压低
        for (x, y) in [(10, 28), (12, 32), (15, 36)] {
            let p = out_img.get_pixel(x, y);
            if p[3] > 80 {
                assert!(
                    p[1] as i32 <= (p[0] as i32).max(p[2] as i32) + 20,
                    "发丝边缘残留绿: ({x},{y}) rgb={:?}",
                    [p[0], p[1], p[2]]
                );
            }
        }
        // 半透明飘散发丝区域：要么完全透明（被抠掉），要么完整保留（不再有怪异半透绿）
        for (x, y) in [(8, 12), (10, 14)] {
            let p = out_img.get_pixel(x, y);
            if p[3] > 32 {
                // 完整保留的部分不应偏绿
                assert!(
                    p[1] as i32 <= (p[0] as i32).max(p[2] as i32) + 20,
                    "飘散发丝残留绿: ({x},{y}) rgba={:?}",
                    [p[0], p[1], p[2], p[3]]
                );
            }
        }
    }

    /// 模拟 teal/青绿背景（也常见于 AI 生成的立绘，抠图旧算法会漏判非亮绿）
    fn make_teal_bg_art() -> String {
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([40, 200, 160, 255]); // teal
        }
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn cutout_teal_bg_recognized_as_green() {
        let b64 = make_teal_bg_art();
        let out = cutout(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        // 四角应透明（teal 也应被识别为绿底）
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert!(out_img.get_pixel(x, y)[3] < 16, "teal 角落应透明: ({x},{y})");
        }
        // 中心前景应保留
        assert!(out_img.get_pixel(32, 32)[3] > 200, "teal 中心前景应保留");
    }

    #[test]
    fn transparency_detection() {
        assert!(!has_transparency(&make_white_bg_art()).unwrap());
        let mut img = RgbaImage::new(32, 32);
        for p in img.pixels_mut() {
            *p = Rgba([0, 0, 0, 0]);
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        assert!(has_transparency(&B64.encode(buf.into_inner())).unwrap());
    }

    #[test]
    fn cutout_reports_green_bg() {
        // 绿幕图必须返回 bg_is_green=true：commands 层据此永不降级 AI，纯代码抠绿即可成功
        let (_, removed, green, dark, _sweep) =
            cutout_with_stats(&make_green_bg_art(), 40.0).expect("绿底抠图应成功");
        assert!(green, "绿幕背景应被识别为 green=true");
        assert!(!dark, "绿幕背景不应被判为深色");
        // 绿幕背景占比高 → removed 偏高是成功指标，不影响 green 判定
        assert!(removed > 0.4, "绿幕背景 removed 应偏高（背景占比大）");
    }

    #[test]
    fn cutout_white_bg_is_not_green() {
        let (_, _, green, dark, _sweep) =
            cutout_with_stats(&make_white_bg_art(), 40.0).expect("白底抠图应成功");
        assert!(!green, "白底不应被识别为绿幕");
        assert!(!dark, "白底不应被判为深色");
    }

    /// 复现用户问题：AI 生成的绿幕立绘四周常有一圈暗色（黑）边缘/晕影，
    /// 若 sample_bg_color 采样到暗边则背景被误判为黑 → 黑色头发/衣服被误抠成透明。
    fn make_green_bg_with_dark_edge() -> String {
        let mut img = RgbaImage::new(64, 64);
        // 外围 8px 模拟 AI 暗色边缘（黑）
        for y in 0..64 {
            for x in 0..64 {
                if x < 8 || y < 8 || x >= 64 - 8 || y >= 64 - 8 {
                    img.put_pixel(x, y, Rgba([8, 8, 8, 255]));
                } else {
                    img.put_pixel(x, y, Rgba([0, 255, 0, 255])); // 内部纯绿底
                }
            }
        }
        // 中心黑色方块模拟"黑色头发/衣服的人物"
        for y in 24..40 {
            for x in 24..40 {
                img.put_pixel(x, y, Rgba([12, 12, 12, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn green_bg_with_dark_edge_keeps_dark_figure() {
        let b64 = make_green_bg_with_dark_edge();
        let (out, removed, green, dark, _sweep) = cutout_with_stats(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        // 中心黑色人物必须保留（不透明）——这是用户报"黑色被抠掉"的核心
        assert!(
            out_img.get_pixel(32, 32)[3] > 200,
            "中心黑色人物应保留（被误抠成透明/半透明即 bug）"
        );
        assert!(
            out_img.get_pixel(30, 30)[3] > 200,
            "黑色人物内部应保留"
        );
        eprintln!("green={green} dark={dark} removed={removed:.2}");
    }

    /// 复现用户"黑色被扣成透明灰"：AI 生成的是黑色背景人物图（非绿幕）。
    /// 色度键采样到黑背景 → 灰黑色人物到黑背景距离落在羽化带(thr..thr_edge) → 被抠成半透明灰。
    fn make_dark_bg_figure() -> String {
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([5, 5, 5, 255]); // 黑背景（模拟 AI 未画绿幕）
        }
        // 灰黑人物方块（模拟黑发/黑衣服人物）
        for y in 16..48 {
            for x in 16..48 {
                img.put_pixel(x, y, Rgba([40, 40, 40, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn dark_bg_figure_is_cut_to_semitransparent() {
        let b64 = make_dark_bg_figure();
        let (out, removed, green, dark, _sweep) = cutout_with_stats(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        let alpha_center = out_img.get_pixel(32, 32)[3];
        eprintln!(
            "dark_bg_figure: green={green} dark={dark} removed={removed:.2} center_alpha={}",
            alpha_center
        );
        // 深色背景必须被识别并拦截（调用方保留原图，不继续抠）
        assert!(dark, "深色背景应被识别并拦截");
        // 双保险：即使调用方忽略拦截直接使用色度键输出，
        // 暗色前景保护也应保证黑色人物不被羽化成半透明（alpha 保持不透明）
        assert!(
            alpha_center > 200,
            "黑色人物应保持不透明（被扣成透明灰即 bug）"
        );
    }

    /// 复现用户「物品黑被扣成半透明黑」：物品图常见深蓝/炭黑渐变背景（采样 max 常在 60~90）。
    /// 旧阈值 60 漏判 dark_bg → 色度键羽化带把深色物品扣成半透明黑。
    fn make_dark_navy_bg_item() -> String {
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([32, 48, 64, 255]); // 深蓝背景（max=64，旧阈值 60 判不出深色）
        }
        // 深色物品方块（模拟黑剑/深色道具）
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([10, 20, 30, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn dark_navy_bg_item_is_intercepted() {
        let b64 = make_dark_navy_bg_item();
        let (out, removed, green, dark, _sweep) = cutout_with_stats(&b64, 40.0).expect("抠图应成功");
        assert!(!green, "深蓝背景不应判为绿幕");
        assert!(
            dark,
            "深蓝/炭黑背景应被判为深色并拦截（旧阈值 60 漏判导致物品被扣成半透明黑）"
        );
        // 拦截路径返回原图：深色物品必须不透明
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        assert!(
            out_img.get_pixel(32, 32)[3] > 200,
            "深色物品应保留不透明（被扣成半透明即 bug）"
        );
        eprintln!("dark_navy_item: green={green} dark={dark} removed={removed:.2}");
    }

    /// 近灰背景（max=92，恰好越过深色阈值 90）+ 黑色物品：色度键正常路径。
    /// 背景应被抠除；物品核心（黑）与暗色边缘（59 灰，落在羽化带 thr..thr_edge）
    /// 必须保持不透明——验证非绿幕暗色前景保护（旧实现会把 59 灰边缘羽化成半透明黑）。
    fn make_gray_bg_black_item() -> String {
        let mut img = RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgba([92, 92, 92, 255]); // 近灰背景
        }
        // 黑色物品核心（10） + 暗色过渡边缘（59）
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        for y in 18..46 {
            for x in 18..46 {
                if x < 20 || y < 20 || x >= 44 || y >= 44 {
                    img.put_pixel(x, y, Rgba([59, 59, 59, 255]));
                }
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn gray_bg_keeps_black_item_opaque() {
        let b64 = make_gray_bg_black_item();
        let (out, removed, green, dark, _sweep) = cutout_with_stats(&b64, 40.0).expect("抠图应成功");
        assert!(!green, "近灰背景不应判为绿幕");
        assert!(!dark, "近灰背景不应判为深色");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        assert!(
            out_img.get_pixel(32, 32)[3] > 200,
            "黑色物品内部应保持不透明"
        );
        assert!(
            out_img.get_pixel(19, 32)[3] > 200,
            "物品暗色边缘（59 灰，落在羽化带）应保持不透明，不能被羽化成半透明黑"
        );
        assert!(
            out_img.get_pixel(4, 4)[3] == 0,
            "背景应被抠除"
        );
        eprintln!("gray_item: green={green} dark={dark} removed={removed:.2}");
    }

    /// 用户报「绿底把黑色抠成灰色半透明」：绿幕立绘里黑色头发/黑衣应保留为不透明前景，
    /// 不能被色度键羽化带 (thr..thr_edge) 透明化成灰色半透明。
    /// 此前实现：黑像素对绿底色度加权距离 ≈ 127，落在 (80, 170) 羽化带 → alpha≈0.54，
    /// 且洪水填充穿透黑色区域，整片黑发被扣成灰半透明。
    /// 修复：绿幕下 max(rgb) < 60 的像素当作前景边界，不透 + 不扩散。
    fn make_green_bg_with_black_figure() -> String {
        let mut img = RgbaImage::new(64, 64);
        // 纯绿底
        for p in img.pixels_mut() {
            *p = Rgba([0, 255, 0, 255]);
        }
        // 中心一个黑色方块（模拟黑发/黑衣人物）
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn green_bg_preserves_black_figure() {
        let b64 = make_green_bg_with_black_figure();
        let (out, _removed, green, dark, _sweep) = cutout_with_stats(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        // 必须是绿幕路径（不是 dark-bg skip 路径）
        assert!(green, "应识别为绿幕");
        assert!(!dark, "不应被判为深色背景");
        // 四角（绿底）应被抠掉
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert!(
                out_img.get_pixel(x, y)[3] < 16,
                "绿底角落应透明: ({x},{y}) a={}",
                out_img.get_pixel(x, y)[3]
            );
        }
        // 中心黑色人物必须不透明（核心回归点）
        let center_a = out_img.get_pixel(32, 32)[3];
        assert!(
            center_a > 200,
            "绿底中央黑色人物应保留不透明（修复前会被羽化成半透明灰）：实际 alpha={center_a}"
        );
        // 黑色人物内部随机几个采样点也应不透明
        for (x, y) in [(24, 24), (32, 24), (40, 24), (24, 32), (40, 32), (24, 40), (40, 40)] {
            let a = out_img.get_pixel(x, y)[3];
            assert!(
                a > 200,
                "黑色人物内部应保留不透明 ({x},{y}) alpha={a}"
            );
        }
    }

    #[test]
    fn green_bg_preserves_near_black_item_opaque() {
        let mut img = RgbaImage::from_pixel(64, 64, Rgba([0, 255, 0, 255]));
        for y in 18..46 {
            for x in 18..46 {
                img.put_pixel(x, y, Rgba([60, 60, 60, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        let encoded = B64.encode(buf.into_inner());
        let (out, _, green, _, _) = cutout_with_stats(&encoded, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();

        assert!(green, "应识别为绿幕");
        assert!(
            out_img.get_pixel(32, 32)[3] > 245,
            "近黑色物品主体必须保持不透明"
        );
    }

    /// 用户报「抠图把绿色扣成黑色/深绿」：AI 生成时蓬松头发/手指缝隙处有「发丝色 × 绿幕背景」的
    /// 半透明混合色（典型如 rgb(5,44,34)：r 低、g 中低、b 接近 g）。修复前这些像素：
    ///   1. flood 距离大 → 默认 alpha=1.0
    ///   2. max(rgb)<60 → 旧 dark_fg 保护强制保留不透明（误判为前景）
    ///   3. sweep 判据 g-max(r,b)>30 不命中（混合色 g-max ≈ 10）
    /// → 抠图后保留为不透明墨绿残渣，视觉上接近黑色。
    ///
    /// 修复：绿幕下「暗色前景保护」仅保护 r≈g 或 g≤r 或 g≤b 的真暗前景；偏绿（g>r 或 g>b）
    /// 的暗像素当作绿幕泄漏；sweep_trapped_green 对被完全包围且偏绿的暗像素彻底去绿 + alpha 置 0。
    fn make_green_bg_with_dark_green_hair_gaps() -> String {
        let mut img = RgbaImage::new(64, 64);
        // 纯绿底
        for p in img.pixels_mut() {
            *p = Rgba([0, 255, 0, 255]);
        }
        // 中心「黑色头发方块」模拟黑发人物主体（r=g=b=10，纯黑）
        for y in 20..44 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        // 在黑发内部加几个「暗青绿混合色」方块，模拟发丝边缘抗锯齿与绿幕的混合色
        // （rgb(5,44,34)：r 低、g 中低、b 接近 g，是典型的「绿幕泄漏到前景内部」颜色）
        for y in 30..34 {
            for x in 30..34 {
                img.put_pixel(x, y, Rgba([5, 44, 34, 255]));
            }
        }
        // 再加一个真黑小斑（rgb(10,10,10)），应被保留为不透明前景
        for y in 36..40 {
            for x in 30..34 {
                img.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        B64.encode(buf.into_inner())
    }

    #[test]
    fn green_bg_keeps_real_dark_but_strips_green_leaked_hair_gaps() {
        let b64 = make_green_bg_with_dark_green_hair_gaps();
        let (out, _removed, green, dark, _sweep) =
            cutout_with_stats(&b64, 40.0).expect("抠图应成功");
        let out_img = image::load_from_memory(&B64.decode(&out).unwrap())
            .unwrap()
            .to_rgba8();
        assert!(green, "应识别为绿幕");
        assert!(!dark, "不应被判为深色背景");
        // 四角（绿底）应被抠掉
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert!(
                out_img.get_pixel(x, y)[3] < 16,
                "绿底角落应透明: ({x},{y}) a={}",
                out_img.get_pixel(x, y)[3]
            );
        }
        // 真黑前景（中心 r=g=b 黑块）必须不透明
        for (x, y) in [(22, 22), (30, 22), (40, 22), (22, 30), (40, 30), (22, 40), (40, 40)] {
            let a = out_img.get_pixel(x, y)[3];
            assert!(
                a > 200,
                "绿底中心纯黑前景应保留不透明 ({x},{y}) alpha={a}"
            );
        }
        // 真黑小斑（r=g=b=10）也应保留
        for (x, y) in [(32, 37), (33, 38)] {
            let a = out_img.get_pixel(x, y)[3];
            assert!(
                a > 200,
                "真黑前景斑应保留不透明 ({x},{y}) alpha={a}"
            );
        }
        // 关键回归：暗青绿混合色（绿幕泄漏到发丝缝隙）应被彻底抠掉，alpha < 32
        // 这些像素被前景完全包围，sweep 应识别并把 alpha 置 0
        for (x, y) in [(31, 31), (32, 31), (33, 31), (31, 33), (33, 33)] {
            let a = out_img.get_pixel(x, y)[3];
            assert!(
                a < 32,
                "暗青绿发丝缝隙应被抠为透明 ({x},{y}) alpha={a}"
            );
        }
        // 且这些像素 RGB 的 G 应被压到 max(r,b)，不再是「深绿残留」（验证 sweep 彻底去绿）
        for (x, y) in [(31, 31), (32, 31), (33, 31)] {
            let p = out_img.get_pixel(x, y);
            let max_rb = p[0].max(p[2]);
            assert!(
                p[1] <= max_rb + 1,
                "暗青绿残渣应被彻底去绿（G 压到 max(r,b)）({x},{y}) rgb=({},{},{})",
                p[0], p[1], p[2]
            );
        }
    }
}
