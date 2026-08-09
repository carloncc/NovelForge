use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize)]
pub struct AppConfig {
    pub preview_port: u16,
    pub image_gen_url: String,
    pub image_gen_key: Option<String>,
    pub background_color_threshold: f32,
    pub default_output_dir: PathBuf,
    pub allowed_hosts: Vec<String>,
}

impl AppConfig {
    pub fn load() -> Self {
        Self {
            preview_port: 17892,
            image_gen_url: "http://127.0.0.1:8100".to_string(),
            image_gen_key: None,
            background_color_threshold: 0.1,
            default_output_dir: PathBuf::from("output"),
            allowed_hosts: vec!["127.0.0.1".to_string()],
        }
    }

    pub fn save(&self) -> Result<(), String> {
        // TODO: implement JSON save to app_config_dir
        Ok(())
    }
}
