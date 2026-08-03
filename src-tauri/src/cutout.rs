use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{ImageFormat, Rgba, RgbaImage};

/// 采样图像四个角的背景色（取四角像素的平均，忽略已透明像素）
fn sample_bg_color(img: &RgbaImage) -> Option<[f32; 3]> {
    let (w, h) = img.dimensions();
    if w < 2 || h < 2 {
        return None;
    }
    let corners = [
        (0u32, 0u32),
        (w - 1, 0),
        (0, h - 1),
        (w - 1, h - 1),
    ];
    let mut sum = [0f64; 3];
    let mut count = 0usize;
    for (x, y) in corners {
        for dx in 0..4u32 {
            for dy in 0..4u32 {
                let cx = (x + dx).min(w - 1);
                let cy = (y + dy).min(h - 1);
                let p = img.get_pixel(cx, cy);
                if p[3] > 240 {
                    sum[0] += p[0] as f64;
                    sum[1] += p[1] as f64;
                    sum[2] += p[2] as f64;
                    count += 1;
                }
            }
        }
    }
    if count == 0 {
        return None;
    }
    Some([
        (sum[0] / count as f64) as f32,
        (sum[1] / count as f64) as f32,
        (sum[2] / count as f64) as f32,
    ])
}

/// 色度键抠图：将与背景色接近的像素置为透明，边缘羽化。
/// threshold 越大抠得越狠（0-255 距离容差）。
pub fn cutout(data_b64: &str, threshold: f32) -> Result<String, String> {
    let bytes = B64
        .decode(data_b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let mut rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let bg = sample_bg_color(&rgba).ok_or("无法采样背景色（图像过小或边缘全透明）")?;

    let mut alpha_out = vec![0f32; (w * h) as usize];
    let mut max_opaque_alpha = 0f32;
    for (x, y, p) in rgba.enumerate_pixels() {
        let dr = p[0] as f32 - bg[0];
        let dg = p[1] as f32 - bg[1];
        let db = p[2] as f32 - bg[2];
        let dist = (dr * dr + dg * dg + db * db).sqrt();
        let target = if dist < threshold {
            0.0
        } else {
            let edge = (dist - threshold).min(24.0) / 24.0;
            edge * edge * (3.0 - 2.0 * edge)
        };
        alpha_out[(y * w + x) as usize] = target * (p[3] as f32 / 255.0);
        if alpha_out[(y * w + x) as usize] > max_opaque_alpha {
            max_opaque_alpha = alpha_out[(y * w + x) as usize];
        }
    }

    if max_opaque_alpha < 0.02 {
        return Err("抠图失败：画面几乎全部接近背景色".to_string());
    }

    let mut writes: Vec<(u32, u32, [u8; 4])> = Vec::with_capacity((w * h) as usize / 8);
    for y in 0..h {
        for x in 0..w {
            let a = alpha_out[(y * w + x) as usize];
            let base = rgba.get_pixel(x, y);
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
