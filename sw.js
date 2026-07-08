// Service Worker：离线可用 + 大文件缓存优先。
// 策略：vendor/（推理库、WASM、模型，约 25MB，极少变更）缓存优先；
// 其余同源资源网络优先、失败回退缓存——保证代码更新及时可见。
const CACHE = "swingcoach-v1";
const VENDOR_PREFIX = "vendor/";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isVendor = url.pathname.includes("/" + VENDOR_PREFIX);
  if (isVendor) {
    // 缓存优先：模型/推理库体积大且几乎不变
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
  } else {
    // 网络优先：保证页面与逻辑更新及时生效，离线时回退缓存
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
