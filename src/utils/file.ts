/** 读取浏览器 File 为纯 base64（去掉 dataURL 前缀）；失败时抛出可展示的错误信息 */
export function fileToBase64(file: File, errorMessage = "文件读取失败"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error(errorMessage));
    reader.readAsDataURL(file);
  });
}
