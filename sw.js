// Service Worker：离线可用 + 大文件缓存优先。
//
// 两个缓存分工明确：
//   VENDOR（不随发布升版）：推理库、WASM、模型，约 24MB，几乎不变。
//     发布新版本绝不能把它删掉——否则每个用户都要在弱网下重下 24MB。
//     沿用旧名 swingcoach-v2，让现有用户已缓存的模型继续有效。
//   SHELL（随发布升版）：页面、样式、脚本、图标。网络优先保证代码更新及时，
//     但 install 时预缓存一份，保证断网/弱网启动一定有页面可渲染。
const VENDOR = "swingcoach-v2";
const SHELL = "swingcoach-shell-v1";
const KEEP = [VENDOR, SHELL];
const VENDOR_PREFIX = "vendor/";

const SHELL_FILES = [
  "./", "index.html", "manifest.webmanifest",
  "css/style.css",
  "js/app.js", "js/swingAnalyzer.js", "js/poseDetector.js", "js/rules.js",
  "js/shareCard.js", "js/store.js", "js/voice.js", "js/flags.js",
  "js/strikeAudio.js", "js/imuReport.js", "js/cameraWatchdog.js",
  "js/replayExport.js",
  "assets/icon-192.png", "assets/icon-512.png", "assets/apple-touch-icon.png",
  "assets/logo-mark.png",
  "assets/qr.png",
];

self.addEventListener("install", (e) => {
  // 逐个 add + allSettled：单个文件取不到不该让整次安装失败（addAll 是全或无）
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    url.pathname.includes("/" + VENDOR_PREFIX) ? cacheFirst(req) : networkFirst(req)
  );
});

/** 模型/推理库：缓存优先，体积大且几乎不变 */
async function cacheFirst(req) {
  const hit = await caches.match(req, { cacheName: VENDOR });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VENDOR)).put(req, res.clone());
    return res;
  } catch (err) {
    return offline(req);
  }
}

/** 页面与逻辑：网络优先，保证更新及时生效；失败回退缓存 */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch (err) {
    return (await caches.match(req)) || offline(req);
  }
}

/** 最后兜底。关键：绝不能返回 undefined——respondWith(undefined) 会让
 *  导航请求直接失败，PWA 启动就是黑屏（闪屏）后白屏。
 *  导航请求退回预缓存的首页；其余资源返回一个真实的 503 响应。 */
async function offline(req) {
  if (req.mode === "navigate") {
    const shell = (await caches.match("index.html")) || (await caches.match("./"));
    if (shell) return shell;
  }
  return new Response("离线且无可用缓存", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
