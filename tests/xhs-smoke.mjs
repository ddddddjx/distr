import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = "/home/user/distr/xhs-tool";
const MIME = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".png":"image/png" };
const server = http.createServer((req,res)=>{
  let fp = path.join(ROOT, decodeURIComponent(new URL(req.url,"http://x").pathname));
  if (fp.endsWith("/")) fp += "index.html";
  if (!fs.existsSync(fp)) { res.writeHead(404).end(); return; }
  res.writeHead(200, {"Content-Type": MIME[path.extname(fp)]||"application/octet-stream"});
  fs.createReadStream(fp).pipe(res);
});
await new Promise(r=>server.listen(0,r));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on("pageerror", e=>errs.push(String(e)));
page.on("console", m=>{ if (m.type()==="error") errs.push(m.text()); });
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "load" });
const pickerVisible = await page.isVisible("#pickBtn");
// 切到自查 tab 前需要视频；直接检查清单是否已渲染在 DOM
const cards = await page.$$eval(".check-card", els=>els.length);
await page.screenshot({ path: "/tmp/claude-0/-home-user-distr/001d5aa8-d9e0-5781-ba1e-04026f16b614/scratchpad/xhs-shot.png" });
console.log(JSON.stringify({ pickerVisible, cards, errs }));
await browser.close(); server.close();
