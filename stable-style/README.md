# stable-style — 本地「稳定风格」生图服务

把 **IP-Adapter + ControlNet + LoRA** 的开源实现折合成一个自用方案：
一个 **OpenAI 兼容** 的本地生图服务。给一张参考图（三视图 / 角色图 / 风格图）+ 文本，
就能生成画风与形象一致的图片，NovelForge 的图像配置直接指过去即用。

## 原理（对应参考的开源项目）

| 技术 | 来源 | 作用 |
|---|---|---|
| IP-Adapter | tencent-ailab/IP-Adapter（diffusers 官方集成） | 参考图作为图片条件，锁画风/形象 |
| ControlNet | lllyasviel/ControlNet | 可选的姿态/结构约束 |
| LoRA | Kohya / diffusers | 可选的字符/画风终极锁定（训练后加载） |
| 底座 | SDXL / DreamShaper(SD1.5) | 动漫等风格基线 |

## 安装

```bash
pip install torch diffusers transformers accelerate safetensors pillow
# 可选（使用 ControlNet 姿态时）
pip install controlnet_aux opencv-python
```

## 启动

```bash
# 动漫风格 + IP-Adapter（默认 SDXL）
python stable_style_server.py --base sdxl --port 8100

# 想更贴近参考图：加大 --ip-scale
python stable_style_server.py --base sdxl --ip-scale 0.85

# 有角色 LoRA：锁死角色
python stable_style_server.py --base sd15 --lora my_char_v1.safetensors

# 需要姿态控制：加 ControlNet（请求里传 control_image）
python stable_style_server.py --base sd15 --controlnet xinsir/controlnet-openpose-sdxl-1.0
```

首次请求会下载权重并加载，之后常驻内存、逐张秒级出图。

## NovelForge 接入

`API 配置` → 图像通道：
- **Base URL**：`http://127.0.0.1:8100`
- **Model**：任意（如 `sdxl`）
- **API Key**：任意（本地不校验）
- 服务商模板：保持 OpenAI 兼容默认即可

NovelForge 生成三视图 / 立绘 / 表情 / 动作时，会自动把上一张参考图（三视图或角色参考图）
放进请求的 `image` 字段 → 本服务用 IP-Adapter 把它作为图片条件，保证一致性。

## API

```
POST /v1/images/generations
{
  "model": "sdxl",
  "prompt": "anime girl, waving hand, full body, plain green background",
  "size": "1024x1024",
  "n": 1,
  "image": "<base64 参考图>",        # 可选：启用 IP-Adapter
  "control_image": "<base64 姿态图>", # 可选：需 --controlnet
  "seed": 42                          # 可选
}
→ { "data": [ { "b64_json": "<base64 PNG>" } ] }

GET /health → {"status":"ok"}
```

## 提示

- **绿幕背景**：提示词里加 `pure solid green chroma background (exact RGB 0,255,0)`，与 NovelForge 的抠图一致。
- **`--ip-scale` 是核心旋钮**：一致性不足调高（0.6→0.9），多样性/可控性不足调低。
- **VRAM 不够**：默认启用 CPU 卸载（`enable_model_cpu_offload`）；显存充裕可加 `--no-offload` 提速。
- **要绝对同一角色**：用角色的几张三视图训一个小 LoRA，再用 `--lora` 加载，比纯 IP-Adapter 更稳。
