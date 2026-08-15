use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use novelforge_lib::cutout::cutout_with_stats;
use std::path::PathBuf;

fn read_png_b64(path: &str) -> String {
    let bytes = std::fs::read(path).expect("read input png");
    B64.encode(&bytes)
}

fn write_png_b64(b64: &str, path: &str) {
    let bytes = B64.decode(b64).expect("decode b64 png");
    std::fs::write(path, &bytes).expect("write output png");
}

fn main() {
    let mut inputs: Vec<String> = std::env::args().skip(1).collect();
    let mut out_dir: Option<String> = None;
    inputs.retain(|arg| {
        if let Some(rest) = arg.strip_prefix("--out=") {
            out_dir = Some(rest.to_string());
            false
        } else {
            true
        }
    });
    if inputs.is_empty() {
        eprintln!("usage: cutout_stats [--out=DIR] <input.png> [<input2.png> ...]");
        std::process::exit(2);
    }

    for input in &inputs {
        let b64 = read_png_b64(input);
        let stats = match cutout_with_stats(&b64, 40.0) {
            Ok((out_b64, _removed, _green, _dark, sweep_count)) => {
                let stem = std::path::Path::new(input)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                let parent = std::path::Path::new(input).parent().unwrap();
                let out_path = if let Some(ref od) = out_dir {
                    PathBuf::from(od).join(format!("{}.out.png", stem))
                } else {
                    parent.join(format!("{}.out.png", stem))
                };
                write_png_b64(&out_b64, out_path.to_str().unwrap());
                let mut s = compute_alpha_stats(&out_b64);
                if let serde_json::Value::Object(ref mut m) = s {
                    m.insert("sweep_trapped_green_count".into(), serde_json::json!(sweep_count));
                }
                s
            }
            Err(e) => {
                serde_json::json!({ "input": input, "error": e })
            }
        };
        let json = serde_json::json!({ "input": input, "stats": stats });
        println!("{}", json);
    }
}

fn compute_alpha_stats(b64: &str) -> serde_json::Value {
    let bytes = B64.decode(b64).expect("decode png");
    let img = image::load_from_memory(&bytes).expect("decode png").to_rgba8();
    let (w, h) = img.dimensions();
    let mut s = serde_json::Map::new();
    s.insert("width".into(), serde_json::json!(w));
    s.insert("height".into(), serde_json::json!(h));

    // 四角 alpha
    let corner_idx: [(u32, u32); 4] = [
        (0, 0),
        (w.saturating_sub(1), 0),
        (0, h.saturating_sub(1)),
        (w.saturating_sub(1), h.saturating_sub(1)),
    ];
    let corner_alpha: Vec<u8> = corner_idx.iter().map(|&(x, y)| img.get_pixel(x, y)[3]).collect();
    s.insert("corner_alpha".into(), serde_json::json!(corner_alpha));

    // 整图 alpha 分布：<32 / <128 / <224 / >=224 的像素占比
    let mut bins = [0u32; 4];
    let mut total = 0u32;
    for p in img.pixels() {
        let a = p[3];
        total += 1;
        let bin = if a < 32 { 0 } else if a < 128 { 1 } else if a < 224 { 2 } else { 3 };
        bins[bin] += 1;
    }
    let pct = |n: u32| (n as f64 / total.max(1) as f64) * 100.0;
    s.insert("alpha_pct_transparent_lt32".into(), serde_json::json!(pct(bins[0])));
    s.insert("alpha_pct_mid_lt128".into(), serde_json::json!(pct(bins[1])));
    s.insert("alpha_pct_near_lt224".into(), serde_json::json!(pct(bins[2])));
    s.insert("alpha_pct_opaque_gte224".into(), serde_json::json!(pct(bins[3])));

    // 暗色前景保护断言：只看「不透明且暗」的像素（alpha >= 128 && max(rgb) < 60），
    // 排除已正确移除的背景（alpha=0）以及边缘半透明像素。
    // 关键指标：暗前景像素中 alpha=255 的像素数（黑发/黑衣最深处）。
    let mut dark_total = 0u32;
    let mut dark_alpha_255 = 0u32; // 完全不透明的暗像素（黑发核心保留证据）
    let mut dark_alpha_128 = 0u32; // alpha >= 128 的暗像素（前景暗像素总数）
    let mut dark_max_alpha = 0u8;
    let mut dark_center_total = 0u32;
    let mut dark_center_opaque = 0u32;
    for p in img.pixels() {
        let max = p[0].max(p[1]).max(p[2]);
        if max < 60 && p[3] >= 128 {
            dark_total += 1;
            dark_alpha_128 += 1;
            if p[3] == 255 {
                dark_alpha_255 += 1;
            }
            if p[3] > dark_max_alpha {
                dark_max_alpha = p[3];
            }
        }
    }
    // 中心 1/3 区域暗像素（避开背景与边缘过渡带）
    let cx0 = w / 3;
    let cx1 = (w * 2) / 3;
    let cy0 = h / 3;
    let cy1 = (h * 2) / 3;
    for y in cy0..cy1 {
        for x in cx0..cx1 {
            let p = img.get_pixel(x, y);
            let max = p[0].max(p[1]).max(p[2]);
            if max < 60 && p[3] >= 128 {
                dark_center_total += 1;
                if p[3] >= 224 {
                    dark_center_opaque += 1;
                }
            }
        }
    }
    s.insert("dark_pixel_count".into(), serde_json::json!(dark_total));
    s.insert("dark_pixel_alpha255_count".into(), serde_json::json!(dark_alpha_255));
    s.insert("dark_pixel_alpha128_count".into(), serde_json::json!(dark_alpha_128));
    s.insert("dark_pixel_max_alpha".into(), serde_json::json!(dark_max_alpha));
    s.insert("dark_pixel_center_count".into(), serde_json::json!(dark_center_total));
    s.insert("dark_pixel_center_opaque_pct".into(), serde_json::json!(pct(dark_center_opaque)));

    // 边中点（每条边的中点）的 alpha
    let mid = |x: u32, y: u32| img.get_pixel(x.min(w - 1), y.min(h - 1))[3];
    s.insert("edge_top_mid_alpha".into(), serde_json::json!(mid(w / 2, 0)));
    s.insert("edge_bottom_mid_alpha".into(), serde_json::json!(mid(w / 2, h - 1)));
    s.insert("edge_left_mid_alpha".into(), serde_json::json!(mid(0, h / 2)));
    s.insert("edge_right_mid_alpha".into(), serde_json::json!(mid(w - 1, h / 2)));

    serde_json::Value::Object(s)
}