// 上传视频「原声开关」回归（E2E，需要浏览器，不进 test:unit）
//   node tests/video-sound.mjs
//
// 守三件事：
//   1. 相机模式恒定静音、且不显示原声按钮（getUserMedia 没要音轨，开了只会啸叫）；
//   2. 上传视频模式按钮出现，点一下真的能解除 video 元素的静音，并记进 localStorage；
//   3. 顶栏在窄屏（iPhone 393px）上放得下这个按钮，不挤掉 FPS 读数。
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
const srv = http.createServer((q, s) => {
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
  args: ["--use-gl=swiftshader", "--use-fake-device-for-media-stream",
         "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, permissions: ["camera"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let ok = false;
try {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chooser:not(.hidden)", { timeout: 180000 });
  await page.click("#chooseLive");
  await page.waitForFunction(() => document.getElementById("video").videoWidth > 0, { timeout: 30000 });
  await page.click("#closeOnboard").catch(() => {});

  const cam = await page.evaluate(() => ({
    hidden: document.getElementById("soundBtn").classList.contains("hidden"),
    muted: document.getElementById("video").muted,
  }));
  const camOk = cam.hidden && cam.muted;
  console.error(`[${camOk ? "ok" : "FAIL"}] 相机模式：按钮隐藏=${cam.hidden}，视频静音=${cam.muted}`);

  // 造一个带音轨的视频文件喂给上传入口
  const webm = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 160; c.height = 120;
    const cx = c.getContext("2d");
    const ac = new AudioContext();
    const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination();
    osc.connect(dst); osc.start();
    const st = new MediaStream([...c.captureStream(15).getVideoTracks(), ...dst.stream.getAudioTracks()]);
    const rec = new MediaRecorder(st); const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = () => r()));
    rec.start();
    let i = 0;
    await new Promise((r) => { const t = setInterval(() => {
      cx.fillStyle = `hsl(${(i * 12) % 360} 70% 50%)`; cx.fillRect(0, 0, 160, 120);
      if (++i > 30) { clearInterval(t); r(); } }, 33); });
    rec.stop(); await done; osc.stop();
    const blob = new Blob(parts, { type: rec.mimeType });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.setInputFiles("#videoInput", {
    name: "swing.webm", mimeType: "video/webm", buffer: Buffer.from(webm),
  });
  await page.waitForFunction(() => !document.getElementById("soundBtn").classList.contains("hidden"), { timeout: 15000 });

  const before = await page.evaluate(() => ({
    text: document.getElementById("soundBtn").textContent,
    muted: document.getElementById("video").muted,
  }));
  await page.click("#soundBtn");
  const after = await page.evaluate(() => ({
    text: document.getElementById("soundBtn").textContent,
    muted: document.getElementById("video").muted,
    saved: localStorage.getItem("videoSound.v1"),
  }));
  const toggleOk = before.muted === true && after.muted === false && after.saved === "1";
  console.error(`[${toggleOk ? "ok" : "FAIL"}] 上传视频：默认「${before.text}」静音=${before.muted} → 点击后「${after.text}」静音=${after.muted}，已记住=${after.saved}`);

  // 再点回去
  await page.click("#soundBtn");
  const back = await page.evaluate(() => ({
    muted: document.getElementById("video").muted,
    saved: localStorage.getItem("videoSound.v1"),
  }));
  const offOk = back.muted === true && back.saved === "0";
  console.error(`[${offOk ? "ok" : "FAIL"}] 再点一次回到静音（记住=${back.saved}）`);

  // 窄屏顶栏不能被挤爆
  const bar = await page.evaluate(() => {
    const t = document.getElementById("topbar").getBoundingClientRect();
    const f = document.getElementById("fpsLabel").getBoundingClientRect();
    const s = document.getElementById("soundBtn").getBoundingClientRect();
    return { barRight: t.right, fpsRight: f.right, fpsW: f.width, sW: s.width, overlap: s.right > f.left };
  });
  const layoutOk = bar.fpsRight <= bar.barRight + 1 && !bar.overlap && bar.sW > 20;
  console.error(`[${layoutOk ? "ok" : "FAIL"}] 393px 顶栏放得下（按钮 ${bar.sW.toFixed(0)}px，FPS 未被挤出/重叠）`);

  ok = camOk && toggleOk && offOk && layoutOk && errors.length === 0;
  if (errors.length) console.error("[FAIL] 页面报错：", errors.join(" | "));
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
} finally {
  await browser.close();
  srv.close();
}
console.error(ok ? "PASS：原声开关行为正确" : "FAIL：原声开关有问题");
process.exit(ok ? 0 : 1);
