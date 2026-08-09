use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{GrayImage, ImageFormat, Luma};
use once_cell::sync::Lazy;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// isnet-anime：专为动漫角色训练的高精度分割模型（rembg 官方发布）
const MODEL_URL: &str =
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx";

const INPUT_SIZE: u32 = 1024;

/// 模型会话缓存（首次使用后复用，避免每张图重建）
static SESSION: Lazy<Mutex<Option<ort::session::Session>>> = Lazy::new(|| Mutex::new(None));

fn model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(data_dir.join("cutout").join("isnet-anime.onnx"))
}

/// 确保分割模型存在：没有则从 rembg 官方发布下载（一次性，约 40MB），下载失败返回 Err（调用方回退色度键）
pub fn ensure_model(app: &tauri::AppHandle) -> Result<String, String> {
    let path = model_path(app)?;
    if path.exists() && path.metadata().map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return Ok(path.to_string_lossy().to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建模型目录失败: {e}"))?;
    }
    eprintln!("[novelforge] 首次使用 AI 抠图，正在下载分割模型（约 40MB，仅一次）…");
    let tmp = path.with_extension("onnx.download");
    let resp = reqwest::blocking::get(MODEL_URL)
        .map_err(|e| format!("下载 AI 抠图模型失败（将使用色度键抠图）: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载 AI 抠图模型失败（HTTP {status}，将使用色度键抠图）"));
    }
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("写入模型失败: {e}"))?;
    let bytes = resp
        .bytes()
        .map_err(|e| format!("读取模型数据失败: {e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写入模型失败: {e}"))?;
    file.flush().map_err(|e| format!("写入模型失败: {e}"))?;
    drop(file);
    std::fs::rename(&tmp, &path).map_err(|e| format!("模型落盘失败: {e}"))?;
    eprintln!("[novelforge] AI 抠图模型就绪");
    Ok(path.to_string_lossy().to_string())
}

fn session<'a>(guard: &'a mut Option<ort::session::Session>, model_path: &str) -> Result<&'a mut ort::session::Session, String> {
    if guard.is_none() {
        let s = ort::session::Session::builder()
            .map_err(|e| format!("ONNX 初始化失败: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("加载 AI 抠图模型失败: {e}"))?;
        *guard = Some(s);
    }
    Ok(guard.as_mut().expect("session 已填充"))
}

/// sigmoid；若输出已落在 [0,1]（模型自带 sigmoid）则原样返回
fn sigmoid(x: f32) -> f32 {
    if x >= 0.0 && x <= 1.0 {
        return x;
    }
    1.0 / (1.0 + (-x).exp())
}

/// AI 分割抠图：isnet-anime 预测 alpha 遮罩，叠加去绿边后输出透明 PNG。
/// 任何一步失败都返回 Err，由调用方回退到色度键抠图。
pub fn ai_cutout(data_b64: &str, model_path: &str) -> Result<String, String> {
    let bytes = B64
        .decode(data_b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let (orig_w, orig_h) = (img.width(), img.height());
    let rgba = img.to_rgba8();

    // 缩放到模型输入尺寸
    let small = image::imageops::resize(
        &rgba,
        INPUT_SIZE,
        INPUT_SIZE,
        image::imageops::FilterType::Triangle,
    );

    // CHW 归一化（ImageNet mean/std）
    let hw = (INPUT_SIZE * INPUT_SIZE) as usize;
    let mut chw = vec![0f32; hw * 3];
    for y in 0..INPUT_SIZE {
        for x in 0..INPUT_SIZE {
            let p = small.get_pixel(x, y);
            let i = (y * INPUT_SIZE + x) as usize;
            chw[i] = (p[0] as f32 / 255.0 - 0.485) / 0.229;
            chw[hw + i] = (p[1] as f32 / 255.0 - 0.456) / 0.224;
            chw[hw * 2 + i] = (p[2] as f32 / 255.0 - 0.406) / 0.225;
        }
    }

    let tensor = ort::value::Tensor::from_array(([1usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize], chw))
        .map_err(|e| format!("构造输入张量失败: {e}"))?;

    let mut guard = SESSION.lock().unwrap();
    let sess = session(&mut guard, model_path)?;
    let input_name = sess
        .inputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or("模型缺少输入")?;
    let output_name = sess
        .outputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or("模型缺少输出")?;
    let outputs = sess
        .run(ort::inputs![input_name => tensor])
        .map_err(|e| format!("AI 抠图推理失败: {e}"))?;
    let (shape, tensor) = outputs
        .get(&output_name)
        .ok_or("模型无输出")?
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("读取输出失败: {e}"))?;
    let data: &[f32] = &tensor;
    let dims: &[i64] = shape.as_ref();
    let h = dims.get(dims.len() - 2).copied().unwrap_or(INPUT_SIZE as i64).max(1) as usize;
    let w = dims.get(dims.len() - 1).copied().unwrap_or(INPUT_SIZE as i64).max(1) as usize;

    // 输出 [1,1,H,W] → sigmoid → 缩回原图尺寸
    let mut mask = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let v = data.get(idx).copied().unwrap_or(0.0);
            let a = (sigmoid(v) * 255.0).round().clamp(0.0, 255.0) as u8;
            mask.put_pixel(x as u32, y as u32, Luma([a]));
        }
    }
    if h as u32 != INPUT_SIZE || w as u32 != INPUT_SIZE {
        mask = image::imageops::resize(
            &mask,
            INPUT_SIZE,
            INPUT_SIZE,
            image::imageops::FilterType::Triangle,
        );
    }
    let mask = image::imageops::resize(&mask, orig_w, orig_h, image::imageops::FilterType::Triangle);

    // 叠加 alpha
    let mut out_rgba = rgba.clone();
    for (x, y, p) in out_rgba.enumerate_pixels_mut() {
        let a = mask.get_pixel(x, y)[0] as f32 / 255.0;
        p[3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
    }

    // 源是绿幕，AI 遮罩会把绿边颜色留在边缘 → 统一去绿
    let alpha: Vec<f32> = out_rgba.pixels().map(|p| p[3] as f32 / 255.0).collect();
    crate::cutout::despill(&mut out_rgba, &alpha);

    let mut out_buf = std::io::Cursor::new(Vec::new());
    out_rgba
        .write_to(&mut out_buf, ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(B64.encode(out_buf.into_inner()))
}
