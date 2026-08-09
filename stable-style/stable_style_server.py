#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stable_style_server.py — 本地 OpenAI 兼容的「稳定风格」生图服务
===============================================================
参考 IP-Adapter（diffusers 官方集成）、ControlNet、LoRA 的源码实现，
折合成一个自用方案：用一张参考图（三视图 / 角色图 / 风格图）+ 文本，
生成画风与形象保持一致的图片。

NovelForge 接入步骤
-------------------
1) 安装依赖（需 Python 3.10+，有 NVIDIA GPU 更好）：
     pip install torch diffusers transformers accelerate safetensors pillow
     # 可选（姿态控制 ControlNet 用）：
     pip install controlnet_aux opencv-python

2) 启动服务：
     python stable_style_server.py --base sdxl --port 8100
     # 首次请求会下载 SDXL / IP-Adapter 权重并加载，耗时几分钟

3) NovelForge「API 配置」→ 图像通道：
     baseUrl: http://127.0.0.1:8100
     model:   sdxl（任意，本地不校验）
     apiKey:  任意（本地不校验）
   生成时把三视图 / 角色参考图传给服务（NovelForge 会自动把参考图作为
   OpenAI 兼容请求里的 "image" 字段），服务用 IP-Adapter 把它作为图片条件，
   保证生成结果与参考图保持同一角色 / 画风。

请求 / 响应（OpenAI /v1/images/generations 兼容）：
     POST /v1/images/generations
     {
       "model": "sdxl",
       "prompt": "anime girl, waving hand, ...",
       "size": "1024x1024",
       "n": 1,
       "image": "<base64 参考图>",       # 可选，有则启用 IP-Adapter
       "control_image": "<base64 姿态图>" # 可选，需启用 --controlnet
     }
     -> { "data": [ { "b64_json": "<base64 PNG>" } ] }

其他 GET 接口：
     GET /health  -> {"status":"ok"}
"""

import argparse
import base64
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------- 模型加载（懒加载，首次请求才加载，避免启动慢） ----------

PIPE = {"value": None}
PIPE_LOCK = threading.Lock()

DEFAULT_NEGATIVE = (
    "lowres, bad anatomy, bad hands, extra fingers, extra limbs, "
    "deformed, blurry, watermark, text, signature, duplicate, jpeg artifacts"
)

BASE_DEFAULTS = {
    "sdxl": {
        "model": "stabilityai/stable-diffusion-xl-base-1.0",
        "ip_repo": "h94/IP-Adapter",
        "ip_subfolder": "sdxl_models",
        "ip_weight": "ip-adapter_sdxl.bin",
        "pipe_cls": "StableDiffusionXLPipeline",
    },
    "sd15": {
        "model": "lykon/dreamshaper-8",
        "ip_repo": "h94/IP-Adapter",
        "ip_subfolder": "models",
        "ip_weight": "ip-adapter-plus_sd15.bin",
        "pipe_cls": "StableDiffusionPipeline",
    },
}


def load_pipe(args: argparse.Namespace):
    """构造管线：基础模型 + 可选 LoRA + 可选 ControlNet + IP-Adapter"""
    import torch
    from diffusers import AutoPipelineForText2Image

    use_cuda = torch.cuda.is_available()
    dtype = torch.float16 if use_cuda else torch.float32
    device = "cuda" if use_cuda else "cpu"

    base = BASE_DEFAULTS.get(args.base, BASE_DEFAULTS["sdxl"])
    model_id = args.model or base["model"]

    kw = dict(torch_dtype=dtype)
    if use_cuda and args.base == "sdxl":
        kw["variant"] = "fp16"

    controlnet = None
    if args.controlnet:
        from diffusers import ControlNetModel

        controlnet = ControlNetModel.from_pretrained(args.controlnet, torch_dtype=dtype)

    if controlnet is not None:
        from diffusers import AutoPipelineForText2Image

        # AutoPipeline 会根据 controlnet 自动选 ControlNet 管线
        pipe = AutoPipelineForText2Image.from_pretrained(model_id, controlnet=controlnet, **kw)
    else:
        pipe = AutoPipelineForText2Image.from_pretrained(model_id, **kw)

    # LoRA：把角色 / 画风固定成一个小文件，之后一致性最强
    if args.lora:
        pipe.load_lora_weights(args.lora)
        pipe.fuse_lora()

    # IP-Adapter：参考图作为图片条件（核心一致性手段）
    reference_image_ready = False
    reference_image_error = None
    try:
        pipe.load_ip_adapter(
            args.ip_repo or base["ip_repo"],
            subfolder=args.ip_subfolder or base["ip_subfolder"],
            weight_name=args.ip_weight or base["ip_weight"],
        )
        pipe.set_ip_adapter_scale(args.ip_scale)
        reference_image_ready = True
        print(f"[stable-style] IP-Adapter 已加载 (scale={args.ip_scale})")
    except Exception as e:  # noqa: BLE001
        reference_image_error = str(e)
        print(f"[stable-style] 警告：IP-Adapter 加载失败，仅用文本生图：{e}")

    if use_cuda and not args.no_offload:
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    PIPE["value"] = {
        "pipe": pipe,
        "device": device,
        "use_cuda": use_cuda,
        "reference_image_ready": reference_image_ready,
        "reference_image_error": reference_image_error,
    }
    print("[stable-style] 模型加载完成。")


def get_pipe(args: argparse.Namespace):
    with PIPE_LOCK:
        if PIPE["value"] is None:
            print("[stable-style] 首次请求，加载模型（需几分钟）…")
            t0 = time.time()
            load_pipe(args)
            print(f"[stable-style] 加载耗时 {time.time() - t0:.1f}s")
        return PIPE["value"]


def parse_size(size: str):
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except Exception:  # noqa: BLE001
        w = h = 1024
    # 稳定扩散要求 8 的倍数
    return max(64, w // 8 * 8), max(64, h // 8 * 8)


def b64_to_pil(b64: str):
    from PIL import Image

    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def generate(args, prompt, ref_b64=None, control_b64=None, size="1024x1024", n=1, seed=None):
    import torch

    state = get_pipe(args)
    pipe = state["pipe"]
    if ref_b64 and not state["reference_image_ready"]:
        raise RuntimeError("REFERENCE_UNSUPPORTED: IP-Adapter is not ready for required image references")
    width, height = parse_size(size)

    generator = None
    if seed is not None and state["use_cuda"]:
        generator = torch.Generator(device="cuda").manual_seed(int(seed))
    elif seed is not None:
        generator = torch.Generator().manual_seed(int(seed))

    kw = dict(
        prompt=prompt,
        negative_prompt=args.negative or DEFAULT_NEGATIVE,
        num_inference_steps=args.steps,
        guidance_scale=args.cfg,
        width=width,
        height=height,
        num_images_per_prompt=n,
        generator=generator,
    )

    ip_image = b64_to_pil(ref_b64) if ref_b64 else None
    if ip_image is not None:
        kw["ip_adapter_image"] = ip_image

    control_image = b64_to_pil(control_b64) if control_b64 else None
    if control_image is not None:
        kw["image"] = control_image
        kw["controlnet_conditioning_scale"] = args.controlnet_scale

    images = pipe(**kw).images
    return [pil_to_b64_png(img) for img in images]


def pil_to_b64_png(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def health_payload():
    state = PIPE["value"]
    if state is None:
        reference_status = "uninitialized"
    elif state.get("reference_image_ready"):
        reference_status = "ready"
    else:
        reference_status = "failed"
    payload = {
        "status": "ok",
        "pid": os.getpid(),
        "referenceImageStatus": reference_status,
        "referenceImageReady": reference_status == "ready",
    }
    if reference_status == "failed" and state.get("reference_image_error"):
        payload["referenceImageError"] = state["reference_image_error"]
    return payload


# ---------- HTTP（OpenAI 兼容） ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "stable-style/1.0"

    def log_message(self, fmt, *args):  # noqa: A003
        print(f"[stable-style] {self.address_string()} {fmt % args}")

    def _send_json(self, obj, status=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._send_json(health_payload())
        else:
            self._send_json(
                {
                    "name": "stable-style-server",
                    "usage": "POST /v1/images/generations  {model,prompt,size,n,image,control_image,seed}",
                }
            )

    def do_POST(self):  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

            if self.path.rstrip("/") == "/v1/images/generations":
                prompt = str(body.get("prompt") or "").strip()
                if not prompt:
                    raise ValueError("缺少 prompt")
                images = generate(
                    self.server.args,
                    prompt,
                    ref_b64=body.get("image"),
                    control_b64=body.get("control_image"),
                    size=str(body.get("size") or "1024x1024"),
                    n=int(body.get("n") or 1),
                    seed=body.get("seed"),
                )
                self._send_json({"created": int(time.time()), "data": [{"b64_json": b} for b in images]})
            else:
                self._send_json({"error": {"message": f"未知路径 {self.path}"}}, status=404)
        except Exception as e:  # noqa: BLE001
            print(f"[stable-style] 生成失败：{e}")
            self._send_json({"error": {"message": str(e)}}, status=500)


def main():
    ap = argparse.ArgumentParser(description="本地 OpenAI 兼容稳定风格生图服务（IP-Adapter / ControlNet / LoRA）")
    ap.add_argument("--base", choices=["sdxl", "sd15"], default="sdxl", help="基础模型（默认 sdxl，动漫建议 sd15 用 dreamshaper）")
    ap.add_argument("--model", default="", help="自定义 HF 基础模型 id，覆盖 --base 默认")
    ap.add_argument("--port", type=int, default=8100)
    ap.add_argument("--ip-repo", default="", help="IP-Adapter 权重仓库（默认 h94/IP-Adapter）")
    ap.add_argument("--ip-subfolder", default="", help="IP-Adapter 权重子目录（sdxl: sdxl_models / sd15: models）")
    ap.add_argument("--ip-weight", default="", help="IP-Adapter 权重文件名（sdxl: ip-adapter_sdxl.bin / sd15: ip-adapter-plus_sd15.bin）")
    ap.add_argument("--ip-scale", type=float, default=0.6, help="IP-Adapter 权重：越大越贴近参考图（0.4-1.0）")
    ap.add_argument("--lora", default="", help="可选 LoRA 权重路径（角色/画风锁定）")
    ap.add_argument("--controlnet", default="", help="可选 ControlNet 模型 id（如 xinsir/controlnet-openpose-sdxl-1.0）")
    ap.add_argument("--controlnet-scale", type=float, default=0.7)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--cfg", type=float, default=7.0)
    ap.add_argument("--negative", default=DEFAULT_NEGATIVE)
    ap.add_argument("--no-offload", action="store_true", help="禁用 CPU 卸载（显存足够时更快）")
    args = ap.parse_args()

    print(f"[stable-style] 监听 http://127.0.0.1:{args.port}  base={args.base}")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.args = args
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[stable-style] 已停止")


if __name__ == "__main__":
    main()
