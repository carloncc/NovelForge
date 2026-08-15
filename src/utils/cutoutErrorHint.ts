/**
 * 抠图错误分类提示：把 Rust 端返回的抠图失败消息翻译成用户能看懂的补充说明。
 */
export function cutoutErrorHint(msg: string): string {
  if (!msg) return "";
  if (msg.includes("无法采样背景色") || msg.includes("图像过小") || msg.includes("边缘全透明")) {
    return "（图像太小或边缘已全透明，无法识别背景）";
  }
  if (msg.includes("AI 抠图") && /下载|model|网络/.test(msg)) {
    return "（AI 分割模型下载失败，请检查网络后重试）";
  }
  if (msg.includes("AI 抠图") && /推理|onnx|ort|Session/.test(msg)) {
    return "（AI 分割模型推理失败）";
  }
  if (msg.includes("base64") || msg.includes("解码") || msg.includes("PNG 编码")) {
    return "（图像数据异常，请检查文件是否损坏）";
  }
  if (msg.includes("过激")) {
    return "（背景识别异常，已尝试 AI 分割兜底仍失败）";
  }
  return "";
}
