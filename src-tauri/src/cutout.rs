use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{ImageFormat, Rgba, RgbaImage};

/// 采样图像边缘一圈的背景色（取各通道中位数，抗前景人物/噪点干扰）
fn sample_bg_color(img: &RgbaImage) -> Option<[f32; 3]> {
    let (w, h) = img.dimensions();
    if w < 8 || h < 8 {
        return None;
    }
    let ring = 8u32; // 边缘采样厚度（比原先大，抗主体贴边）
    let mut rs = Vec::new();
    let mut gs = Vec::new();
    let mut bs = Vec::new();
    let mut push = |x: u32, y: u32| {
        let p = img.get_pixel(x.min(w - 1), y.min(h - 1));
        if p[3] > 240 {
            rs.push(p[0]);
            gs.push(p[1]);
            bs.push(p[2]);
        }
    };
    for x in 0..w {
        for y in 0..ring {
            push(x, y);
            push(x, h - 1 - y);
        }
    }
    for y in 0..h {
        for x in 0..ring {
            push(x, y);
            push(w - 1 - x, y);
        }
    }
    if rs.len() < 8 {
        return None;
    }
    let median = |mut v: Vec<u8>| -> u8 {
        v.sort_unstable();
        v[v.len() / 2]
    };
    Some([median(rs) as f32, median(gs) as f32, median(bs) as f32])
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

/// 把背景绿色溢出（绿边/绿晕）从前景边缘去除：对半透明羽化带按透明度强度去绿，
/// 对与透明像素相邻的不透明边界像素做一次轻量去绿（主体本身非绿色时干净利落）。
pub(crate) fn despill(rgba: &mut RgbaImage, alpha: &[f32]) {
    let (w, h) = rgba.dimensions();
    let n = (w * h) as usize;
    // 标记前景边界像素（4 邻域存在半透明/透明的像素）
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
        if spill > 6.0 {
            // 半透明带：按透明度强度彻底去绿（趋向 max(r,b)）；边界带：只去大部分，避免灰边
            let a = alpha[i];
            let strength = if a < 0.98 { 1.0 } else { 0.85 };
            let out_g = g - spill * strength;
            p[1] = out_g.round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// 色度键抠图（连通性洪水填充 + 边缘羽化 + 去绿边 + alpha 中值平滑）：
/// - 从图像四条边播种，沿相似色扩散；与背景色距离 < thr 的像素置透明
/// - thr..thr_edge 之间羽化（平滑过渡到不透明）；超过 thr_edge 视为前景边界，不扩散
/// - 前景内部与背景色相近的孤立像素（如脸部高光、浅色头发内侧）因“不连通”而不会被误删
/// - 最后做 despill（去除绿幕常见的绿边/绿晕）与 alpha 3x3 中值平滑（去噪点/空洞）
pub fn cutout(data_b64: &str, threshold: f32) -> Result<String, String> {
    let bytes = B64
        .decode(data_b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let mut rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let bg = sample_bg_color(&rgba).ok_or("无法采样背景色（图像过小或边缘全透明）")?;

    let thr = threshold.max(4.0);
    let thr_edge = thr + 40.0;

    let idx = |x: u32, y: u32| -> usize { (y * w + x) as usize };
    let dist_at = |x: u32, y: u32| -> f32 {
        let p = rgba.get_pixel(x, y);
        let dr = p[0] as f32 - bg[0];
        let dg = p[1] as f32 - bg[1];
        let db = p[2] as f32 - bg[2];
        (dr * dr + dg * dg + db * db).sqrt()
    };

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
    let alpha_out = alpha_median3x3(&alpha_out, w, h);

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
    despill(&mut rgba, &alpha_out);

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
    Ok(B64.encode(out_buf.into_inner()))
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
}
