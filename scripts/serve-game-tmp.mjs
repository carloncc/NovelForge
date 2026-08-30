import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.resolve("D:/Desktop/视觉小说/成功回避死亡结局的美少女游戏女主们似乎读到了我的【日记本】，并知道了我的秘密");
const MIME = { ".html":"text/html; charset=utf-8", ".js":"application/javascript", ".css":"text/css", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".mp3":"audio/mpeg", ".mp4":"video/mp4", ".ogg":"audio/ogg", ".txt":"text/plain; charset=utf-8", ".json":"application/json", ".ico":"image/x-icon", ".ttf":"font/ttf" };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const full = path.join(ROOT, p);
  console.log("REQ", req.url, "->", full, fs.existsSync(full));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found " + p); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}).listen(8734, () => console.log("serving on http://localhost:8734"));
