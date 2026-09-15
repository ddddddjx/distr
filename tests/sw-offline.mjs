// Service Worker 离线启动回归（E2E，需要浏览器，不进 test:unit）
//   node tests/sw-offline.mjs
//
// 复现过的线上事故：sw 升版 activate 清掉旧缓存后，只要页面导航请求失败
// （github.io 在国内并不稳定），网络优先分支的 `.catch(() => caches.match(req))`
// 在缓存未命中时 resolve 成 undefined → respondWith(undefined) → 导航直接
// 失败 → 装到主屏幕的 PWA 启动后黑屏（闪屏）转白屏，永远打不开。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".wasm": "application/wasm", ".task": "application/octet-stream",
};
let down = false;
const srv = http.createServer((q, s) => {
  if (down) return void s.socket.destroy(); // 模拟连不上站点
  const u = decodeURIComponent(new URL(q.url, "http://x").pathname);
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return void s.writeHead(404).end();
  }
  s.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  executablePath: fs.existsSync(PREINSTALLED) ? PREINSTALLED : undefined,
  args: ["--use-gl=swiftshader"],
});
const page = await (await browser.newContext({ viewport: { width: 393, height: 852 } })).newPage();
let ok = false;
try {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 60000 });
  console.error("[ok] SW 已接管");

  // 外壳必须在 install 阶段就进了缓存（不能等某次成功联网加载）
  const shellCached = await page.evaluate(async () => !!(await caches.match("index.html")));
  console.error(`[${shellCached ? "ok" : "FAIL"}] install 预缓存了应用外壳`);

  // 模拟弱网/站点不可达下的启动
  down = true;
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  const brand = (await page.textContent(".brand").catch(() => "")).trim();
  console.error(`[${brand ? "ok" : "FAIL"}] 断网启动仍渲染出页面，顶栏品牌 = ${JSON.stringify(brand)}`);
  ok = shellCached && !!brand;
} catch (err) {
  console.error("[FAIL] 断网启动失败（白屏）：", String(err).split("\n")[0]);
} finally {
  await browser.close();
  srv.close();
}
console.log(ok ? "PASS：离线启动正常" : "FAIL：离线启动白屏");
process.exit(ok ? 0 : 1);
