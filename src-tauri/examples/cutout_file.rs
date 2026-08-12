use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use novelforge_lib::cutout::cutout;
use std::path::PathBuf;

fn read_png_b64(path: &str) -> String {
    let bytes = std::fs::read(path).expect("read input png");
    B64.encode(&bytes)
}

fn write_png_b64(b64: &str, path: &str) {
    let bytes = B64.decode(b64).expect("decode b64 png");
    std::fs::write(path, &bytes).expect("write output png");
    eprintln!("[ok] wrote {} ({} bytes)", path, bytes.len());
}

fn main() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests")
        .join("cutout-fixtures");

    let mut inputs: Vec<String> = std::env::args().skip(1).collect();
    if inputs.is_empty() {
        if let Ok(entries) = std::fs::read_dir(&fixtures) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("png") {
                    let name = p.file_name().unwrap().to_string_lossy().to_string();
                    if !name.contains(".out.") && !name.starts_with("cutout_") {
                        inputs.push(p.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    if inputs.is_empty() {
        eprintln!("No input PNGs found in {}", fixtures.display());
        std::process::exit(1);
    }

    for input in &inputs {
        eprintln!("[cut] {}", input);
        let b64 = read_png_b64(input);
        match cutout(&b64, 40.0) {
            Ok(out) => {
                let stem = std::path::Path::new(input)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                let out_path = fixtures.join(format!("cutout_{}.out.png", stem));
                write_png_b64(&out, out_path.to_str().unwrap());
            }
            Err(e) => eprintln!("[err] cutout failed for {}: {}", input, e),
        }
    }
}
